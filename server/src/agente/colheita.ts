import { db, now } from '../db.ts';
import { complete, hasKey, modeloAuxiliar } from '../llm.ts';
import { remember, indexarPendentes, reavaliarNucleo, type Thought } from '../memory.ts';

// ===========================================================================
// A colheita: o que valeu a pena desta conversa.
//
// O agente ja marca `<lembrar>` no meio da resposta, e isso e bom porque nao
// custa uma segunda chamada de modelo. Mas e o modelo decidindo no calor da
// resposta, enquanto esta ocupado com outra coisa — e muito escapa.
//
// Entao, de tempos em tempos, um modelo BARATO le o trecho recente e responde
// uma pergunta so: o que aqui vale lembrar daqui a um mes?
//
// Ele tambem da a IMPORTANCIA de cada memoria, de 1 a 5, no mesmo custo. Sem
// isso, "o disco estava em 21%" e "ele decide rapido e odeia ser perguntado
// duas vezes" pesam igual na hora de recuperar — e nao pesam.
// ===========================================================================

/** De quantas mensagens novas em diante vale a pena colher. */
const PASSO = Number(process.env.THOR_PASSO_COLHEITA ?? 6);

const MOLDE = [
  'Voce le um trecho de conversa entre uma pessoa e o assistente pessoal dela, e extrai o',
  'que vale guardar como memoria DURAVEL.',
  '',
  'Responda SO com linhas no formato:',
  'tipo | importancia | texto',
  '',
  'Tipos possiveis: preferencia, decisao, projeto, pessoa, fato.',
  '',
  'A importancia vai de 1 a 5 e responde: o quanto ERRAR sobre isto atrapalharia?',
  '  5 = muda como tratar a pessoa para sempre (preferencia forte, decisao do projeto)',
  '  3 = util saber, mas o mundo nao acaba se escapar',
  '  1 = quase trivial, guarde so porque foi dito',
  'Seja avaro com 5. Se tudo e importante, nada e.',
  '',
  'O criterio para guardar e um so: continua verdade depois que esta conversa acabar?',
  '',
  'Guarde:',
  '- como ela gosta de trabalhar (preferencia)',
  '- o que foi decidido e vale daqui para a frente (decisao)',
  '- o que existe no mundo dela: projetos, pessoas, sistemas (projeto, pessoa, fato)',
  '',
  'NAO guarde:',
  '- o que ela pediu para fazer agora, que e tarefa e nao memoria',
  '- estado passageiro ("o disco esta em 21%")',
  '- o que o assistente fez nesta conversa',
  '',
  'Guarde o que ela DISSE, nao a sua interpretacao do que ela disse. Conclusao sua',
  'guardada vira verdade dela em toda conversa seguinte.',
  '',
  'Escreva cada linha curta, em terceira pessoa, completa em si mesma: ela vai ser lida',
  'daqui a meses, sem esta conversa ao lado. "Ele prefere decidir sozinho em vez de ser',
  'consultado a cada passo" serve; "ele prefere isso" nao serve.',
  '',
  'Se nada valer a pena, responda apenas: NADA',
].join('\n');

type Nova = { id: string; role: string; content: string };

function naoColhidas(conversationId: string): Nova[] {
  const conv = db
    .prepare(`SELECT colhido_ate AS ate FROM conversations WHERE id = ?`)
    .get(conversationId) as { ate: string | null } | undefined;

  if (conv?.ate) {
    return db
      .prepare(
        `SELECT id, role, content FROM messages
          WHERE conversation_id = ? AND role IN ('user','assistant')
            AND created_at > (SELECT created_at FROM messages WHERE id = ?)
          ORDER BY created_at ASC`,
      )
      .all(conversationId, conv.ate) as Nova[];
  }
  return db
    .prepare(
      `SELECT id, role, content FROM messages
        WHERE conversation_id = ? AND role IN ('user','assistant')
        ORDER BY created_at ASC`,
    )
    .all(conversationId) as Nova[];
}

export function vaiColher(conversationId: string): boolean {
  return naoColhidas(conversationId).length >= PASSO;
}

/**
 * Le uma linha da resposta do modelo.
 *
 * O formato pedido e `tipo | importancia | texto`, mas o modelo as vezes
 * devolve sem a importancia. Descartar a memoria por causa disso seria perder
 * conteudo por causa de formatacao — entao a nota vira 3 e segue.
 */
export function lerLinha(
  linha: string,
): { tipo: string; importancia: number; texto: string } | null {
  const partes = linha.split('|');
  if (partes.length < 2) return null;

  const tipo = partes[0].trim().toLowerCase();
  const temNota = partes.length >= 3 && /^[1-5]$/.test(partes[1].trim());
  const importancia = temNota ? Number(partes[1].trim()) : 3;
  const texto = (temNota ? partes.slice(2) : partes.slice(1)).join('|').trim();

  if (!texto || texto.length < 8) return null;
  return { tipo, importancia, texto };
}

/**
 * Colhe. Devolve o que foi guardado.
 *
 * Falha calada: se o modelo auxiliar nao responder, a marca de ate onde leu
 * NAO avanca — entao na proxima vez tenta de novo o mesmo trecho, em vez de
 * pular um pedaco da conversa para sempre.
 */
export async function colher(conversationId: string): Promise<Thought[]> {
  if (!hasKey()) return [];
  const novas = naoColhidas(conversationId);
  if (novas.length < PASSO) return [];

  const corpo = novas
    .map((m) => `${m.role === 'user' ? 'Dono' : 'Assistente'}: ${m.content}`)
    .join('\n\n')
    .slice(0, 60_000);

  let bruto: string;
  try {
    bruto = await complete(MOLDE, corpo, 700, modeloAuxiliar());
  } catch {
    return [];
  }

  const guardados: Thought[] = [];
  if (bruto && !/^\s*NADA\s*$/i.test(bruto)) {
    for (const linha of bruto.split('\n')) {
      const lida = lerLinha(linha);
      if (!lida) continue;
      const t = remember(lida.tipo, lida.texto, null, 0.85, lida.importancia);
      if (t) guardados.push(t);
    }
  }

  // A marca so avanca depois de o modelo ter respondido. Avancar antes seria
  // trocar "guardei nada" por "nunca mais vou olhar isto".
  db.prepare(`UPDATE conversations SET colhido_ate = ?, updated_at = ? WHERE id = ?`).run(
    novas[novas.length - 1].id,
    now(),
    conversationId,
  );

  if (guardados.length) {
    void indexarPendentes();
    reavaliarNucleo();
  }
  return guardados;
}
