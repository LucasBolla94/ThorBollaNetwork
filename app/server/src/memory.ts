import { db, newId, now } from './db.ts';

export type Thought = {
  id: string;
  kind: string;
  content: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  pinned: number;
  supersededBy: string | null;
};

export const KINDS = ['fato', 'preferencia', 'projeto', 'pessoa', 'decisao'] as const;

const normalizeKind = (kind: string): string => {
  const k = kind.trim().toLowerCase();
  return (KINDS as readonly string[]).includes(k) ? k : 'fato';
};

/** Pensamentos em circulacao: os que ninguem substituiu. */
export function liveThoughts(limit = 200): Thought[] {
  return db
    .prepare(
      `SELECT id, kind, content, confidence, created_at AS createdAt,
              updated_at AS updatedAt, pinned, superseded_by AS supersededBy
         FROM thoughts
        WHERE superseded_by IS NULL
        ORDER BY pinned DESC, created_at DESC
        LIMIT ?`,
    )
    .all(limit) as Thought[];
}

export function allThoughts(limit = 500): Thought[] {
  return db
    .prepare(
      `SELECT id, kind, content, confidence, created_at AS createdAt,
              updated_at AS updatedAt, pinned, superseded_by AS supersededBy
         FROM thoughts ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Thought[];
}

export function links() {
  return db
    .prepare(
      `SELECT from_id AS fromId, to_id AS toId, relation, weight FROM thought_links`,
    )
    .all();
}

/**
 * Guarda um pensamento novo. Deduplica por conteudo identico entre os vivos —
 * o modelo tende a reafirmar a mesma coisa em conversas diferentes, e sem isso
 * a teia enche de copias.
 */
export function remember(
  kind: string,
  content: string,
  sourceMessageId: string | null,
  confidence = 0.8,
): Thought | null {
  const text = content.trim();
  if (text.length < 3 || text.length > 2000) return null;

  const dup = db
    .prepare(
      `SELECT id FROM thoughts
        WHERE superseded_by IS NULL AND lower(content) = lower(?)`,
    )
    .get(text) as { id: string } | undefined;
  if (dup) return null;

  const id = newId();
  const ts = now();
  db.prepare(
    `INSERT INTO thoughts
       (id, kind, content, confidence, source_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, normalizeKind(kind), text, confidence, sourceMessageId, ts, ts);

  return db
    .prepare(
      `SELECT id, kind, content, confidence, created_at AS createdAt,
              updated_at AS updatedAt, pinned, superseded_by AS supersededBy
         FROM thoughts WHERE id = ?`,
    )
    .get(id) as Thought;
}

/**
 * Correcao sem perda. O pensamento antigo continua no banco apontando para o
 * novo, entao da para reconstruir o que o Thor acreditava em qualquer data.
 * Tambem registra a ligacao `corrige`, que e o que faz a teia mostrar a
 * evolucao de uma ideia em vez de so o estado atual.
 */
export function correct(
  oldId: string,
  kind: string,
  content: string,
  sourceMessageId: string | null,
): Thought | null {
  const old = db.prepare(`SELECT id, kind FROM thoughts WHERE id = ?`).get(oldId) as
    | { id: string; kind: string }
    | undefined;
  if (!old) return null;

  const fresh = remember(kind || old.kind, content, sourceMessageId, 0.9);
  if (!fresh) return null;

  db.prepare(`UPDATE thoughts SET superseded_by = ?, updated_at = ? WHERE id = ?`).run(
    fresh.id,
    now(),
    oldId,
  );
  link(fresh.id, oldId, 'corrige', 1);
  return fresh;
}

export function link(fromId: string, toId: string, relation: string, weight = 1): void {
  if (fromId === toId) return;
  db.prepare(
    `INSERT INTO thought_links (from_id, to_id, relation, weight, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(from_id, to_id, relation) DO UPDATE SET weight = excluded.weight`,
  ).run(fromId, toId, relation, weight, now());
}

export function forget(id: string): void {
  db.prepare(`DELETE FROM thoughts WHERE id = ?`).run(id);
}

export function togglePin(id: string): void {
  db.prepare(`UPDATE thoughts SET pinned = 1 - pinned, updated_at = ? WHERE id = ?`).run(
    now(),
    id,
  );
}

/** Escapa a consulta para o FTS5, que trata aspas e operadores como sintaxe. */
const ftsQuery = (q: string): string =>
  q
    .split(/\s+/)
    .map((t) => t.replace(/["^*:()]/g, '').trim())
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(' OR ');

export function searchThoughts(q: string, limit = 20): Thought[] {
  const query = ftsQuery(q);
  if (!query) return [];
  try {
    return db
      .prepare(
        `SELECT t.id, t.kind, t.content, t.confidence, t.created_at AS createdAt,
                t.updated_at AS updatedAt, t.pinned, t.superseded_by AS supersededBy
           FROM thoughts_fts f JOIN thoughts t ON t.rowid = f.rowid
          WHERE f.content MATCH ? AND t.superseded_by IS NULL
          ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as Thought[];
  } catch {
    return [];
  }
}

export function searchMessages(q: string, limit = 20) {
  const query = ftsQuery(q);
  if (!query) return [];
  try {
    return db
      .prepare(
        `SELECT m.id, m.conversation_id AS conversationId, m.role, m.content,
                m.created_at AS createdAt, c.title
           FROM messages_fts f
           JOIN messages m ON m.rowid = f.rowid
           JOIN conversations c ON c.id = m.conversation_id
          WHERE f.content MATCH ?
          ORDER BY rank LIMIT ?`,
      )
      .all(query, limit);
  } catch {
    return [];
  }
}

export function stats() {
  const live = (
    db.prepare(`SELECT COUNT(*) AS n FROM thoughts WHERE superseded_by IS NULL`).get() as {
      n: number;
    }
  ).n;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM thoughts`).get() as { n: number }).n;
  const linkCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM thought_links`).get() as { n: number }
  ).n;
  const msgs = (db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n;
  const convs = (
    db.prepare(`SELECT COUNT(*) AS n FROM conversations`).get() as { n: number }
  ).n;
  return { live, total, superseded: total - live, links: linkCount, messages: msgs, conversations: convs };
}

// ---------------------------------------------------------------------------
// Extracao das marcas que o Thor escreve na resposta
//
// Em vez de uma segunda chamada de LLM para "resumir o que aprendeu" (que
// dobra o custo de cada turno), o proprio modelo marca o que vale guardar
// durante a resposta. As marcas sao removidas antes do texto ir para a tela.
// ---------------------------------------------------------------------------

const RE_REMEMBER = /<lembrar(?:\s+tipo=["']?([a-zA-Zçã]+)["']?)?\s*>([\s\S]*?)<\/lembrar>/gi;
const RE_CORRECT = /<corrigir\s+id=["']?([0-9a-fA-F-]{8,})["']?\s*>([\s\S]*?)<\/corrigir>/gi;

export type Extracted = { clean: string; saved: Thought[] };

export function extractAndStore(raw: string, sourceMessageId: string | null): Extracted {
  const saved: Thought[] = [];

  for (const m of raw.matchAll(RE_CORRECT)) {
    const t = correct(m[1], 'fato', m[2], sourceMessageId);
    if (t) saved.push(t);
  }
  for (const m of raw.matchAll(RE_REMEMBER)) {
    const t = remember(m[1] ?? 'fato', m[2], sourceMessageId);
    if (t) saved.push(t);
  }

  const clean = raw
    .replace(RE_CORRECT, '')
    .replace(RE_REMEMBER, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Pensamentos nascidos do mesmo turno ficam ligados entre si: e a origem
  // comum, nao coincidencia de palavra.
  for (let i = 0; i < saved.length; i++) {
    for (let j = i + 1; j < saved.length; j++) {
      link(saved[i].id, saved[j].id, 'mesmo-turno', 0.5);
    }
  }

  return { clean, saved };
}

/**
 * O NUCLEO: o pedaco de memoria que vive dentro do system prompt.
 *
 * Regra que manda aqui: **isto tem de ser estavel entre turnos.** O cache de
 * prompt casa por prefixo exato — se este texto mudar de uma mensagem para a
 * outra, o cache nunca acerta e cada mensagem passa a custar o preco cheio do
 * prefixo inteiro (umas 10x mais caro).
 *
 * Por isso o nucleo nao depende da pergunta. Entra so o que o Lucas fixou, em
 * ordem deterministica (data de criacao), com teto de tamanho. O resto da
 * memoria o Thor busca por ferramenta quando precisar.
 */
export function coreBlock(budget = 3000): string {
  const pinned = db
    .prepare(
      `SELECT id, kind, content FROM thoughts
        WHERE superseded_by IS NULL AND pinned = 1
        ORDER BY created_at ASC
        LIMIT 60`,
    )
    .all() as { id: string; kind: string; content: string }[];

  if (pinned.length === 0) return '';

  const lines: string[] = [];
  let used = 0;
  for (const t of pinned) {
    const line = `- [${t.kind}] ${t.content}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length;
  }

  return `O que voce sabe sobre o Lucas (memoria fixada):\n${lines.join('\n')}`;
}

/**
 * O ARQUIVO: tudo o que nao cabe no nucleo, alcancado por busca.
 *
 * Isto e o que a ferramenta `buscar_memoria` executa. Roda inteiro no banco,
 * **sem chamar o LLM** — e por isso que buscar e barato e injetar tudo todo
 * turno nao e.
 */
export function recall(query: string, limit = 12) {
  const thoughts = searchThoughts(query, limit);
  const messages = searchMessages(query, Math.ceil(limit / 2)) as {
    content: string;
    title: string;
    createdAt: number;
    role: string;
  }[];

  const parts: string[] = [];

  if (thoughts.length) {
    parts.push(
      'Pensamentos guardados:\n' +
        thoughts.map((t) => `- [${t.kind}] ${t.content} (id: ${t.id})`).join('\n'),
    );
  }
  if (messages.length) {
    parts.push(
      'Trechos de conversas antigas:\n' +
        messages
          .map((m) => {
            const when = new Date(m.createdAt).toISOString().slice(0, 10);
            const who = m.role === 'user' ? 'Lucas' : 'voce';
            return `- ${when}, em "${m.title}", ${who} disse: ${m.content.slice(0, 220)}`;
          })
          .join('\n'),
    );
  }

  if (!parts.length) return 'Nada encontrado na memoria para essa busca.';
  return parts.join('\n\n');
}
