import { db, newId, now } from '../db.ts';
import { complete, hasKey, modeloAuxiliar, type Turn } from '../llm.ts';

// ===========================================================================
// A conversa que cresce em vez de esquecer.
//
// Antes o Thor levava as 24 ultimas mensagens em toda chamada. Duas coisas
// ruins saiam disso:
//
//   1. Ele ESQUECIA o comeco. Passou de 24, sumiu.
//   2. Cada mensagem ficava cara. O desconto de repeticao do provedor so vale
//      quando o pedaco inicial do pedido e igual ao da vez anterior — e numa
//      janela que desliza ele muda sempre, entao o desconto nunca se aplica.
//
// Agora a conversa cresce. Quando passa do orcamento, o MEIO vira um resumo e
// o resto continua inteiro. Nada e apagado do banco: `messages` guarda tudo, e
// o resumo so substitui o que e ENVIADO ao modelo.
//
// Comprimir quebra o desconto de repeticao uma vez, no turno em que acontece.
// E a unica quebra aceita — vale muito mais que pagar o historico inteiro em
// todo turno.
// ===========================================================================

/** Teto do historico, em caracteres. ~4 caracteres por token, entao ~12 mil tokens. */
const ORCAMENTO = Number(process.env.THOR_ORCAMENTO_HISTORICO ?? 48_000);

/** Quantas mensagens do fim ficam sempre inteiras, nunca resumidas. */
const CAUDA = Number(process.env.THOR_CAUDA ?? 8);

type Mensagem = { id: string; role: string; content: string; createdAt: number };

type Resumo = { id: string; conteudo: string; ateMensagem: string; mensagens: number };

function resumoAtual(conversationId: string): Resumo | null {
  return (
    (db
      .prepare(
        `SELECT id, conteudo, ate_mensagem AS ateMensagem, mensagens
           FROM resumos WHERE conversation_id = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(conversationId) as Resumo | undefined) ?? null
  );
}

/** As mensagens que vieram depois do resumo — ou todas, se nao houver resumo. */
function mensagensVivas(conversationId: string, resumo: Resumo | null): Mensagem[] {
  if (!resumo) {
    return db
      .prepare(
        `SELECT id, role, content, created_at AS createdAt FROM messages
          WHERE conversation_id = ? AND role IN ('user','assistant')
          ORDER BY created_at ASC`,
      )
      .all(conversationId) as Mensagem[];
  }
  // Depois da mensagem em que o resumo parou. Compara por created_at da
  // mensagem de corte, e nao por id, porque id nao tem ordem.
  return db
    .prepare(
      `SELECT id, role, content, created_at AS createdAt FROM messages
        WHERE conversation_id = ? AND role IN ('user','assistant')
          AND created_at > (SELECT created_at FROM messages WHERE id = ?)
        ORDER BY created_at ASC`,
    )
    .all(conversationId, resumo.ateMensagem) as Mensagem[];
}

const tamanho = (ms: Mensagem[]): number => ms.reduce((n, m) => n + m.content.length, 0);

/**
 * O historico pronto para o prompt: o resumo na frente, o resto inteiro.
 *
 * O resumo entra como uma mensagem do proprio Thor, e nao como instrucao do
 * sistema. O prompt de sistema tem de ficar igual byte a byte pela vida da
 * conversa — e se o resumo entrasse la, toda compressao reescreveria o inicio
 * do pedido e quebraria o desconto de repeticao de todo o resto.
 */
export function turnosDaConversa(conversationId: string): Turn[] {
  const resumo = resumoAtual(conversationId);
  const vivas = mensagensVivas(conversationId, resumo);

  const turnos: Turn[] = [];
  if (resumo) {
    turnos.push({
      role: 'assistant',
      content:
        `[Resumo do que ja conversamos antes, ${resumo.mensagens} mensagens]\n\n` +
        resumo.conteudo,
    });
    // Depois de uma fala minha tem de vir uma do Lucas. Se o corte deixou duas
    // minhas seguidas, o provedor recusa o pedido inteiro.
    if (vivas[0]?.role === 'assistant') {
      turnos.push({ role: 'user', content: '(continuando)' });
    }
  }

  for (const m of vivas) {
    turnos.push({ role: m.role as 'user' | 'assistant', content: m.content });
  }
  return turnos;
}

export function precisaComprimir(conversationId: string): boolean {
  const resumo = resumoAtual(conversationId);
  const vivas = mensagensVivas(conversationId, resumo);
  return vivas.length > CAUDA + 2 && tamanho(vivas) > ORCAMENTO;
}

const MOLDE =
  'Voce resume conversas para que um assistente possa continuar de onde parou sem ter lido ' +
  'o original. Escreva em portugues do Brasil, em topicos, sem enfeite.\n\n' +
  'Use exatamente estas secoes, e omita as que nao tiverem conteudo:\n\n' +
  '## Objetivo\nO que o Lucas esta tentando conseguir.\n\n' +
  '## Preferencias e restricoes\nComo ele gosta que as coisas sejam feitas, o que ele ja ' +
  'recusou, limites que ele impos.\n\n' +
  '## O que ja foi feito\nCaminhos de arquivo, comandos rodados, resultados concretos.\n\n' +
  '## O que ficou pendente\nO que estava em andamento ou travado quando a conversa cortou.\n\n' +
  '## Decisoes\nO que foi decidido e por que.\n\n' +
  'Guarde fato, nao conversa. Nomes, numeros e caminhos sao o que mais importa: eles nao ' +
  'podem ser reconstruidos depois. "Falamos sobre o servidor" nao serve; "o disco do ' +
  'dedicated-1 estava em 21%" serve.';

/**
 * Comprime se precisar. Devolve quantas mensagens sairam do envio.
 *
 * Falha para o lado macio: se o modelo auxiliar nao responder, nada e
 * comprimido e a conversa continua inteira. Caro e melhor que perdido — e
 * **nunca** descartamos o meio sem resumo, que e justamente o erro que o
 * Hermes documenta como a causa mais comum de compactacao ruim.
 */
export async function talvezComprimir(conversationId: string): Promise<number> {
  if (!hasKey() || !precisaComprimir(conversationId)) return 0;

  const resumo = resumoAtual(conversationId);
  const vivas = mensagensVivas(conversationId, resumo);
  const paraResumir = vivas.slice(0, vivas.length - CAUDA);
  if (paraResumir.length === 0) return 0;

  const corpo = paraResumir
    .map((m) => `${m.role === 'user' ? 'Lucas' : 'Thor'}: ${m.content}`)
    .join('\n\n');

  // O resumo anterior entra junto para o novo acumular em vez de substituir.
  // Sem isso, cada compressao esqueceria tudo que a anterior tinha guardado.
  const entrada = resumo
    ? `Resumo anterior desta conversa:\n\n${resumo.conteudo}\n\n---\n\nTrecho novo:\n\n${corpo}`
    : corpo;

  let texto: string;
  try {
    texto = await complete(MOLDE, entrada.slice(0, 400_000), 1600, modeloAuxiliar());
  } catch {
    return 0;
  }
  if (!texto || texto.length < 40) return 0;

  const ultima = paraResumir[paraResumir.length - 1];
  db.prepare(
    `INSERT INTO resumos (id, conversation_id, conteudo, ate_mensagem, mensagens, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    conversationId,
    texto.trim(),
    ultima.id,
    (resumo?.mensagens ?? 0) + paraResumir.length,
    now(),
  );

  return paraResumir.length;
}

export const orcamento = ORCAMENTO;
export const cauda = CAUDA;
