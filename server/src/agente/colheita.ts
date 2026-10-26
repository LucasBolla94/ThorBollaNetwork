import { db, now } from '../db.ts';
import { complete, hasKey, modeloAuxiliar } from '../llm.ts';
import { remember, indexarPendentes, type Thought } from '../memory.ts';

// ===========================================================================
// A colheita: o que valeu a pena desta conversa.
//
// O Thor ja marca `<lembrar>` no meio da resposta, e isso e bom porque nao
// custa uma segunda chamada de modelo. Mas e o modelo decidindo no calor da
// resposta, enquanto esta ocupado com outra coisa — e muito escapa.
//
// Entao, de tempos em tempos, um modelo BARATO le o trecho recente e responde
// uma pergunta so: o que aqui vale lembrar daqui a um mes?
//
// O criterio e o mesmo da personalidade, e e o que separa memoria de tarefa:
// vale se continuar verdade depois que esta conversa acabar.
// ===========================================================================

/** De quantas mensagens novas em diante vale a pena colher. */
const PASSO = Number(process.env.THOR_PASSO_COLHEITA ?? 6);

const MOLDE =
  'Voce le um trecho de conversa entre o Lucas e o assistente dele, e extrai o que vale ' +
  'guardar como memoria DURAVEL.\n\n' +
  'Responda SO com linhas no formato:\n' +
  'tipo | texto\n\n' +
  'Tipos possiveis: preferencia, decisao, projeto, pessoa, fato.\n\n' +
  'O criterio e um so: **continua verdade depois que esta conversa acabar?**\n\n' +
  'Guarde:\n' +
  '- como o Lucas gosta de trabalhar (preferencia)\n' +
  '- o que foi decidido e vale daqui para a frente (decisao)\n' +
  '- o que existe no mundo dele: projetos, pessoas, sistemas (projeto, pessoa, fato)\n\n' +
  'NAO guarde:\n' +
  '- o que ele pediu para fazer agora — isso e tarefa, nao memoria\n' +
  '- estado passageiro ("o disco esta em 21%")\n' +
  '- o que o assistente fez nesta conversa\n\n' +
  'Escreva cada linha curta, em terceira pessoa, completa em si mesma: ela vai ser lida ' +
  'daqui a meses, sem esta conversa ao lado. "Ele prefere decidir sozinho em vez de ser ' +
  'consultado a cada passo" serve; "ele prefere isso" nao serve.\n\n' +
  'Se nada valer a pena, responda apenas: NADA';

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
    .map((m) => `${m.role === 'user' ? 'Lucas' : 'Thor'}: ${m.content}`)
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
      const [tipo, ...resto] = linha.split('|');
      const texto = resto.join('|').trim();
      if (!texto || texto.length < 8) continue;
      const t = remember(tipo.trim().toLowerCase(), texto, null, 0.85);
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

  if (guardados.length) void indexarPendentes();
  return guardados;
}
