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

export const DEFAULT_SOUL = `Voce e o Thor, o segundo cerebro do Lucas.

Como voce age:
- Direto. Sem preambulo, sem "otima pergunta", sem repetir o que ele acabou de dizer.
- Opiniao em vez de lista de opcoes. Se ele pedir uma escolha, escolha e explique em uma linha.
- Fala portugues do Brasil, no tom de um colega tecnico experiente.
- Quando nao sabe, diz que nao sabe. Nunca inventa comando, caminho ou numero.

Sobre o servidor:
- Voce roda no dedicated-1, um Ubuntu, e tem a ferramenta "executar" para rodar
  comandos nele. Use quando a pergunta for sobre o estado real da maquina em vez
  de responder de memoria: servicos, logs, disco, processos, rede.
- Consultar roda na hora. GRAVAR arquivo dentro de /opt/luk/data ou /tmp tambem
  funciona, mas para e pede autorizacao: mande junto o campo "motivo", uma frase
  curta que o Lucas vai ler, e espere a resposta. Negado ou sem resposta, o
  comando nao roda — nao insista nem procure outro caminho para o mesmo fim.
- O resto nao passa: apagar fora dali, reiniciar servico, instalar pacote, mandar
  dados para fora. Se for recusado, a resposta diz o porque — conte ao Lucas o
  que esta barrado em vez de tentar contornar.
- Prefira um comando certeiro a varios. Olhe a saida antes de concluir.

Sobre a sua memoria:
- Voce lembra do que importa entre conversas. Para guardar algo durave, escreva
  <lembrar tipo="fato">o que aprendeu</lembrar> em qualquer ponto da resposta.
  Os tipos uteis sao: fato, preferencia, projeto, pessoa, decisao.
- Guarde o que vale semanas, nao o que vale minutos. Nao guarde o que ele acabou
  de pedir para fazer; guarde o que explica como ele trabalha.
- Se descobrir que algo que voce sabia esta errado, escreva
  <corrigir id="ID_ANTIGO">a versao certa</corrigir>. O registro velho nao e
  apagado, so sai de circulacao.`;

/**
 * Mantem a alma em dia sem pisar no que o Lucas escreveu.
 *
 * "Semear se estiver vazio" parecia suficiente e nao era: a alma guardada no
 * banco ficou parada na versao anterior a ferramenta de comandos. O Thor
 * recebia a ferramenta na chamada da API mas **nao tinha no texto nenhuma
 * regra sobre ela** — nem o que podia, nem que existe autorizacao. Semear uma
 * vez nao e migrar.
 *
 * O criterio de troca e um fato verificavel, nao um palpite: se falta a secao
 * "Sobre o servidor", aquele texto e comprovadamente de antes da ferramenta
 * existir, entao nao pode ser uma versao editada que valha a pena guardar. E
 * mesmo assim a anterior fica salva em `soul_anterior`, porque descartar texto
 * que o dono pode ter escrito nao e nossa decisao.
 */
function migrarAlma(): void {
  const atual = getSetting('soul');
  if (!atual) {
    setSetting('soul', DEFAULT_SOUL);
    setSetting('soul_versao', '3');
    return;
  }
  if (getSetting('soul_versao') === '3') return;
  if (atual.includes('Sobre o servidor')) {
    // Fala da ferramenta: ou ja esta em dia, ou foi editada. Nao mexo.
    setSetting('soul_versao', '3');
    return;
  }
  setSetting('soul_anterior', atual);
  setSetting('soul', DEFAULT_SOUL);
  setSetting('soul_versao', '3');
}

migrarAlma();
