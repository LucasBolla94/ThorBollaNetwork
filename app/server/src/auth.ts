import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { config } from './config.ts';
import { db, newId, now } from './db.ts';

// ---------------------------------------------------------------------------
// Senha
//
// scrypt da biblioteca padrao do Node. Escolhido de proposito em vez de
// argon2id: argon2 exige compilar modulo nativo no servidor, e scrypt resolve
// o mesmo problema (derivacao lenta e dura de memoria) sem nenhuma dependencia
// que possa quebrar num `npm install` futuro. N=2^16 deixa cada tentativa na
// casca de ~100ms, o que torna forca bruta caro mesmo com a senha vazada.
// ---------------------------------------------------------------------------

const SCRYPT = { N: 1 << 16, r: 8, p: 1, keylen: 32, maxmem: 128 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(keyB64, 'base64url');
    const actual = scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) — implementado aqui para nao somar dependencia
// ---------------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

function totpAt(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * Aceita uma janela de +/- 1 passo (30s) para tolerar relogio dessincronizado
 * entre o celular e o servidor. Mais que isso enfraquece o fator sem ganho real.
 */
export function verifyTotp(secret: string, token: string): boolean {
  const code = token.replace(/\D/g, '');
  if (code.length !== 6) return false;
  const counter = Math.floor(Date.now() / 30_000);
  for (const step of [-1, 0, 1]) {
    const candidate = totpAt(secret, counter + step);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) return true;
  }
  return false;
}

export function totpUri(secret: string, account: string): string {
  const label = encodeURIComponent(`${config.siteName}:${account}`);
  const issuer = encodeURIComponent(config.siteName);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

// ---------------------------------------------------------------------------
// Sessoes
//
// O cookie leva um token aleatorio de 32 bytes. O banco guarda so o hash dele,
// como se fosse senha: se o banco vazar, os tokens nao servem para entrar.
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'luk_session';

const tokenHash = (token: string): string =>
  createHmac('sha256', config.sessionSecret).update(token).digest('base64url');

export type Session = { id: string; userId: string; username: string };

export function createSession(
  userId: string,
  ip: string | undefined,
  userAgent: string | undefined,
): string {
  const token = randomBytes(32).toString('base64url');
  const ts = now();
  db.prepare(
    `INSERT INTO auth_sessions
       (id, token_hash, user_id, created_at, expires_at, last_seen, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    tokenHash(token),
    userId,
    ts,
    ts + config.sessionDays * 86_400_000,
    ts,
    ip ?? null,
    (userAgent ?? '').slice(0, 300) || null,
  );
  return token;
}

export function readSession(token: string | undefined): Session | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.id, s.user_id AS userId, s.expires_at AS expiresAt, u.username
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(tokenHash(token)) as
    | { id: string; userId: string; expiresAt: number; username: string }
    | undefined;
  if (!row) return null;
  if (row.expiresAt < now()) {
    db.prepare(`DELETE FROM auth_sessions WHERE id = ?`).run(row.id);
    return null;
  }
  db.prepare(`UPDATE auth_sessions SET last_seen = ? WHERE id = ?`).run(now(), row.id);
  return { id: row.id, userId: row.userId, username: row.username };
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(tokenHash(token));
}

// ---------------------------------------------------------------------------
// Tiquete de uso unico para abrir o websocket pelo app.
//
// O site manda o cookie sozinho; o app nao tem cookie, e WebSocket no iOS nao
// deixa pendurar cabecalho de forma confiavel. Sobraria passar o token da
// sessao na URL — e URL vai inteira para o log do Caddy, onde um token que vale
// meses ficaria escrito em texto puro.
//
// Entao o app troca o token por um tiquete que vale 30 segundos e some no
// primeiro uso. Se vazar no log, ja nao serve para nada.
// ---------------------------------------------------------------------------

const tiquetes = new Map<string, { token: string; expira: number }>();

export function criarTiquete(token: string): string {
  const agora = now();
  for (const [k, v] of tiquetes) if (v.expira < agora) tiquetes.delete(k);

  const t = randomBytes(18).toString('base64url');
  tiquetes.set(t, { token, expira: agora + 30_000 });
  return t;
}

export function trocarTiquete(t: string | undefined): Session | null {
  if (!t) return null;
  const reg = tiquetes.get(t);
  tiquetes.delete(t); // uso unico: sai do mapa mesmo se ja estiver vencido
  if (!reg || reg.expira < now()) return null;
  return readSession(reg.token);
}

export function destroyAllSessions(userId: string): void {
  db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(userId);
}

export function listSessions(userId: string) {
  return db
    .prepare(
      `SELECT id, created_at AS createdAt, last_seen AS lastSeen, ip, user_agent AS userAgent
         FROM auth_sessions WHERE user_id = ? ORDER BY last_seen DESC`,
    )
    .all(userId);
}

// ---------------------------------------------------------------------------
// Limite de tentativas
//
// Sem a segunda porta de um proxy na frente, este e o unico freio contra forca
// bruta. Janela de 15 minutos por IP, com atraso progressivo para encarecer
// cada tentativa mesmo antes de bloquear.
// ---------------------------------------------------------------------------

const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 6;

export function recentFailures(ip: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ok = 0 AND at > ?`)
    .get(ip, now() - WINDOW_MS) as { n: number };
  return row.n;
}

export const isLocked = (ip: string): boolean => recentFailures(ip) >= MAX_FAILS;

export function recordAttempt(ip: string, ok: boolean): void {
  db.prepare(`INSERT INTO login_attempts (ip, at, ok) VALUES (?, ?, ?)`).run(
    ip,
    now(),
    ok ? 1 : 0,
  );
  if (ok) db.prepare(`DELETE FROM login_attempts WHERE ip = ? AND ok = 0`).run(ip);
  db.prepare(`DELETE FROM login_attempts WHERE at < ?`).run(now() - 7 * 86_400_000);
}

export const throttleDelay = (fails: number): number =>
  Math.min(2_000, fails * 350);

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export function userCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
}

export function createUser(username: string, password: string, totpSecret: string): string {
  const id = newId();
  db.prepare(
    `INSERT INTO users (id, username, pass_hash, totp_secret, totp_enabled, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(id, username, hashPassword(password), totpSecret, now());
  return id;
}

export function findUser(username: string) {
  return db
    .prepare(
      `SELECT id, username, pass_hash AS passHash, totp_secret AS totpSecret,
              totp_enabled AS totpEnabled
         FROM users WHERE username = ?`,
    )
    .get(username) as
    | {
        id: string;
        username: string;
        passHash: string;
        totpSecret: string | null;
        totpEnabled: number;
      }
    | undefined;
}

export function setPassword(userId: string, password: string): void {
  db.prepare(`UPDATE users SET pass_hash = ? WHERE id = ?`).run(
    hashPassword(password),
    userId,
  );
}

/** Comparacao de strings em tempo constante, para o token de primeiro acesso. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// Convites
//
// Mesmo desenho das sessoes: o link leva um token aleatorio, o banco guarda so
// o hash. Se o banco vazar, os convites que ainda estiverem de pe nao servem
// para criar conta.
//
// Uso unico e validade curta porque um convite e uma chave da casa: enquanto
// esta valido, quem tiver o link cria a conta do dono.
// ---------------------------------------------------------------------------

const INVITE_HOURS = Number(process.env.LUK_INVITE_HOURS ?? 24);

export function createInvite(email: string): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const ts = now();
  const expiresAt = ts + INVITE_HOURS * 3_600_000;
  db.prepare(
    `INSERT INTO invites (id, token_hash, email, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(newId(), tokenHash(token), email.trim().toLowerCase(), ts, expiresAt);
  return { token, expiresAt };
}

export type Invite = { id: string; email: string; expiresAt: number };

/** Devolve o convite se ele existir, nao tiver sido usado e nao tiver vencido. */
export function readInvite(token: string | undefined): Invite | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT id, email, expires_at AS expiresAt, used_at AS usedAt
         FROM invites WHERE token_hash = ?`,
    )
    .get(tokenHash(token)) as
    | { id: string; email: string; expiresAt: number; usedAt: number | null }
    | undefined;
  if (!row || row.usedAt) return null;
  if (row.expiresAt < now()) return null;
  return { id: row.id, email: row.email, expiresAt: row.expiresAt };
}

export function useInvite(id: string, userId: string): void {
  db.prepare(`UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?`).run(
    now(),
    userId,
    id,
  );
}

/** Invalida os convites em aberto — usado ao emitir um novo para o mesmo e-mail. */
export function revokeInvites(email: string): number {
  const r = db
    .prepare(`UPDATE invites SET used_at = ? WHERE email = ? AND used_at IS NULL`)
    .run(now(), email.trim().toLowerCase());
  return Number(r.changes ?? 0);
}

/**
 * Espelha localmente o usuario que vive no Supabase.
 *
 * A senha NAO mora aqui — quem guarda e o GoTrue. O campo `pass_hash` fica com
 * um marcador literal justamente para falhar fechado: se alguem chamar
 * `verifyPassword` contra ele por engano, nao casa com nenhum formato de
 * scrypt e a resposta e `false`.
 */
export function espelharUsuario(id: string, email: string, role = 'dono'): void {
  db.prepare(
    `INSERT INTO users (id, username, pass_hash, totp_enabled, created_at, role)
     VALUES (?, ?, 'gerido-pelo-supabase', 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET username = excluded.username`,
  ).run(id, email.trim().toLowerCase(), now(), role);
}

export function donoAtual(): { id: string; email: string; role: string } | null {
  const r = db
    .prepare(`SELECT id, username AS email, role FROM users ORDER BY created_at LIMIT 1`)
    .get() as { id: string; email: string; role: string } | undefined;
  return r ?? null;
}
