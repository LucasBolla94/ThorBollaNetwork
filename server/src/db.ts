import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.ts';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);
db.exec(`PRAGMA busy_timeout = 5000`);

// ---------------------------------------------------------------------------
// Esquema
//
// Tres grupos: quem entra (users/auth_sessions), o que foi dito
// (conversations/messages) e o que o Thor sabe (thoughts/thought_links).
//
// O terceiro grupo e a teia de pensamento. Duas escolhas de desenho merecem
// nota, porque sao as perguntas que a A10 do plano levanta:
//
//   - Um pensamento nunca e sobrescrito. Quando o Thor descobre que estava
//     errado, o registro velho recebe `superseded_by` apontando para o novo e
//     sai de circulacao sem desaparecer. Da para reconstruir o que ele
//     acreditava em qualquer data, e um fato corrigido nao apaga a historia.
//   - As ligacoes sao explicitas, com um tipo (`relation`) e um peso. Nada de
//     deduzir aresta por coincidencia de palavra: se a ligacao nao foi
//     afirmada, ela nao existe.
// ---------------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  pass_hash    TEXT NOT NULL,
  totp_secret  TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  model           TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS thoughts (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  content           TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 0.8,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  superseded_by     TEXT REFERENCES thoughts(id) ON DELETE SET NULL,
  pinned            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_thoughts_live
  ON thoughts(superseded_by, created_at DESC);

CREATE TABLE IF NOT EXISTS thought_links (
  from_id    TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);

CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_fts USING fts5(
  content,
  content='thoughts',
  content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  used_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email, created_at DESC);

CREATE TABLE IF NOT EXISTS comandos (
  id         TEXT PRIMARY KEY,
  comando    TEXT NOT NULL,
  permitido  INTEGER NOT NULL,
  motivo     TEXT,
  saida      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comandos_data ON comandos(created_at DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip      TEXT NOT NULL,
  at      INTEGER NOT NULL,
  ok      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON login_attempts(ip, at DESC);

-- Pedidos de autorizacao. O estado 'expirado' existe separado de 'negado' de
-- proposito: na pratica os dois barram o comando, mas so um deles significa
-- que o Lucas olhou e disse nao. Saber a diferenca importa para medir se o
-- canal esta sendo usado ou so ignorado.
CREATE TABLE IF NOT EXISTS aprovacoes (
  id            TEXT PRIMARY KEY,
  comando       TEXT NOT NULL,
  justificativa TEXT NOT NULL,
  estado        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expira_em     INTEGER NOT NULL,
  decided_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_aprov_data ON aprovacoes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aprov_pend ON aprovacoes(estado, expira_em);

-- Aparelhos que recebem aviso de aprovacao.
--
-- O token do push e a chave: ele identifica o aparelho, e o mesmo telefone
-- reinstalando o app gera token novo. Por isso a limpeza nao e por tempo, e
-- sim por falha de entrega — quando a Apple responde que o aparelho nao existe
-- mais, a linha sai.
CREATE TABLE IF NOT EXISTS aparelhos (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  plataforma TEXT NOT NULL,
  nome       TEXT,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
`);

// Gatilhos que mantem os indices de busca em dia. Sem eles o FTS vira
// mentira silenciosa: a tabela existe, a busca devolve vazio.
db.exec(`
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS thoughts_ai AFTER INSERT ON thoughts BEGIN
  INSERT INTO thoughts_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS thoughts_ad AFTER DELETE ON thoughts BEGIN
  INSERT INTO thoughts_fts(thoughts_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS thoughts_au AFTER UPDATE ON thoughts BEGIN
  INSERT INTO thoughts_fts(thoughts_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
  INSERT INTO thoughts_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`);

/**
 * Acrescenta uma coluna se ela ainda nao existir.
 *
 * O SQLite nao tem "ADD COLUMN IF NOT EXISTS", e repetir o ALTER da erro. Como
 * o esquema roda inteiro a cada arranque, isso precisa ser idempotente.
 */
function acrescentarColuna(tabela: string, coluna: string, definicao: string): void {
  const cols = db.prepare(`PRAGMA table_info(${tabela})`).all() as { name: string }[];
  if (cols.some((c) => c.name === coluna)) return;
  db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
}

// Niveis de acesso. Hoje so existe o dono; a coluna entra agora para que o dia
// de ter convidados nao exija migrar conta nenhuma.
acrescentarColuna('users', 'role', "TEXT NOT NULL DEFAULT 'dono'");

// O vetor do pensamento, para a busca por sentido. Fica NULL ate o servico de
// embed indexar — que pode ser depois, se ele estiver fora do ar na hora em
// que o pensamento nasceu. Coluna em vez de tabela porque e um-para-um e
// sempre lido junto.
acrescentarColuna('thoughts', 'vetor', 'BLOB');
acrescentarColuna('thoughts', 'vetor_em', 'INTEGER');

// Ate onde a colheita de memoria ja leu esta conversa. Sem isto ela releria
// tudo toda vez e guardaria a mesma coisa de novo.
acrescentarColuna('conversations', 'colhido_ate', 'TEXT');

// Quantas vezes esta memoria ja foi util de verdade, e quando pela ultima vez.
//
// E a unica evidencia que existe sobre o que importa. Sem ela, "o que o Thor
// sabe de cor" seria para sempre o que EU decidi que deveria ser — uma lista
// de tipos escrita a mao. Com ela, o proprio uso responde.
acrescentarColuna('thoughts', 'usos', 'INTEGER NOT NULL DEFAULT 0');
acrescentarColuna('thoughts', 'ultimo_uso', 'INTEGER');

// Quem fixou: 'lucas' ou 'thor'. O Thor reavalia o proprio nucleo, mas nunca
// derruba o que o Lucas fixou na mao — ele pode errar sobre o que importa, e
// escolha explicita do dono nao e palpite a ser revisado.
acrescentarColuna('thoughts', 'fixado_por', 'TEXT');

// Quanto esta memoria importa, de 1 a 5, dada por um modelo no momento em que
// ela nasce. Sem isto, "o disco estava em 21%" e "ele decide rapido e odeia
// ser perguntado duas vezes" valem o mesmo na hora de recuperar — e nao valem.
// 3 e o meio: o que entrou antes desta coluna existir fica ali, sem fingir
// que alguem a avaliou.
acrescentarColuna('thoughts', 'importancia', 'INTEGER NOT NULL DEFAULT 3');

// O que o Thor decidiu sobre a propria memoria, e por que.
//
// Guardado separado das memorias de proposito: aqui fica o RACIOCINIO dele, e
// misturar isso com o que ele sabe sobre o Lucas embaralharia as duas coisas.
// Serve para a gente poder olhar depois e entender o que ele mudou sozinho.
db.exec(`
CREATE TABLE IF NOT EXISTS reflexoes (
  id         TEXT PRIMARY KEY,
  observacao TEXT NOT NULL,
  acoes      TEXT NOT NULL,
  memorias   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reflexoes_data ON reflexoes(created_at DESC);
`);

// Resumo de conversa comprimida. A conversa cresce e, quando enche, o meio
// vira um resumo — mas o original NUNCA e apagado: fica tudo em `messages`, e
// isto aqui so substitui o que e ENVIADO ao modelo.
db.exec(`
CREATE TABLE IF NOT EXISTS resumos (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  conteudo        TEXT NOT NULL,
  ate_mensagem    TEXT NOT NULL,
  mensagens       INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resumos_conv ON resumos(conversation_id, created_at DESC);
`);

export const now = (): number => Date.now();
export const newId = (): string => randomUUID();

export function getSetting(key: string, fallback = ''): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

// ---------------------------------------------------------------------------
// A alma saiu daqui.
//
// Ela morava numa linha desta tabela, semeada "se estivesse vazia". Isso nao
// era migrar: o texto ficou parado numa versao anterior a ferramenta de
// comandos sem ninguem ver, depois ficou com o nome errado do agente, e foi
// preciso inventar marcacao por hash so para decidir se dava para trocar.
//
// Agora mora em `server/personalidade.md`, onde o git ja faz esse trabalho.
// Ver `alma.ts`. O que sobra no banco e so a sobreposicao, quando o Lucas
// escreve a propria versao pela tela.
//
// A linha antiga (`soul`) e o entulho da tentativa anterior saem na primeira
// vez que o servidor sobe com esta versao. Nao ha o que preservar: o conteudo
// dela virou o arquivo.
// ---------------------------------------------------------------------------
db.prepare(`DELETE FROM settings WHERE key IN ('soul','soul_versao','soul_semente')`).run();
