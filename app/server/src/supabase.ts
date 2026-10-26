/**
 * Cliente do GoTrue (o servico de autenticacao do Supabase).
 *
 * Desenho que vale explicar: **o navegador nunca fala com o GoTrue.** Ele fala
 * so com o Thor, e o Thor fala com o GoTrue pelo localhost. So uma rota do
 * Supabase e publica — `/auth/v1/verify`, que o link do e-mail precisa abrir.
 *
 * Isso tira da internet as rotas de login, cadastro e administracao: nao ha
 * onde tentar senha em massa nem onde criar conta por fora. Em troca, o Thor
 * carrega a responsabilidade de repassar os erros direito.
 */
import { config } from './config.ts';

const BASE = process.env.SUPABASE_URL ?? 'http://127.0.0.1:8000';
const ANON = () => process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE = () => process.env.SUPABASE_SERVICE_KEY ?? '';

export const supabaseReady = (): boolean => Boolean(ANON() && SERVICE());

export class AuthError extends Error {
  status: number;
  code: string | undefined;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

type Keyed = { admin?: boolean; accessToken?: string };

async function call(path: string, body: unknown, opts: Keyed = {}): Promise<any> {
  if (!supabaseReady()) {
    throw new AuthError('Supabase nao configurado no servidor.', 503);
  }
  const key = opts.admin ? SERVICE() : ANON();
  const res = await fetch(`${BASE}/auth/v1${path}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${opts.accessToken ?? key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* resposta nao-JSON vira erro generico abaixo */
  }

  if (!res.ok) {
    const msg = json?.msg ?? json?.error_description ?? json?.message ?? json?.error ?? text;
    throw new AuthError(traduzir(String(msg), res.status), res.status, json?.error_code);
  }
  return json;
}

/**
 * O GoTrue responde em ingles e com texto tecnico. Como o navegador nunca
 * fala com ele, a unica chance de o usuario ver uma mensagem decente e aqui.
 */
function traduzir(msg: string, status: number): string {
  const m = msg.toLowerCase();
  if (m.includes('invalid login credentials')) return 'E-mail ou senha incorretos.';
  if (m.includes('email not confirmed')) {
    return 'Falta confirmar o e-mail. Procure a mensagem na sua caixa de entrada.';
  }
  if (m.includes('user already registered') || m.includes('already been registered')) {
    return 'Ja existe conta com esse e-mail.';
  }
  if (m.includes('password should be') || m.includes('password must')) {
    return 'A senha e curta demais. Use ao menos 12 caracteres.';
  }
  if (m.includes('signups not allowed') || m.includes('signup is disabled')) {
    return 'O cadastro esta fechado neste servidor.';
  }
  if (m.includes('for security purposes') || m.includes('rate limit') || status === 429) {
    return 'Tentativas demais. Espere um minuto e tente de novo.';
  }
  if (m.includes('token has expired') || m.includes('expired')) {
    return 'Esse link ja venceu. Peca outro.';
  }
  if (status >= 500) return 'O servico de autenticacao falhou. Tente de novo em instantes.';
  return msg.slice(0, 200);
}

export type SupabaseUser = {
  id: string;
  email: string;
  emailConfirmed: boolean;
};

const toUser = (u: any): SupabaseUser => ({
  id: u.id,
  email: u.email,
  emailConfirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at),
});

/**
 * Cria a conta e devolve o link de confirmacao — sem enviar nada.
 *
 * Usa `admin/generate_link` em vez de `/signup` de proposito: o cadastro fica
 * desligado no GoTrue (ninguem cria conta por fora, nem que ache a rota), e o
 * e-mail sai pelo nosso remetente, com a cara do Thor.
 */
export async function criarConta(
  email: string,
  password: string,
): Promise<{ user: SupabaseUser; link: string }> {
  const r = await call(
    '/admin/generate_link',
    { type: 'signup', email, password, redirect_to: config.publicUrl },
    { admin: true },
  );
  const u = r.user ?? r;
  return { user: toUser(u), link: String(r.action_link ?? '') };
}

/**
 * Convida alguem: cria o usuario SEM senha e devolve o link onde ele escolhe
 * uma. E diferente de `criarConta` — aqui a senha nunca passa por ninguem
 * alem do proprio convidado.
 *
 * O nivel vai no `data`, que o GoTrue guarda como metadado do usuario. Hoje so
 * existe "dono"; ficar registrado desde ja evita migrar conta depois.
 */
export async function convidar(
  email: string,
  nivel = 'dono',
): Promise<{ user: SupabaseUser; link: string }> {
  const r = await call(
    '/admin/generate_link',
    { type: 'invite', email, data: { nivel }, redirect_to: config.publicUrl },
    { admin: true },
  );
  const u = r.user ?? r;
  return { user: toUser(u), link: String(r.action_link ?? '') };
}

/** Gera um novo link de confirmacao para quem ja tem conta e nao confirmou. */
export async function linkDeConfirmacao(email: string): Promise<string> {
  const r = await call(
    '/admin/generate_link',
    { type: 'signup', email, redirect_to: config.publicUrl },
    { admin: true },
  );
  return String(r.action_link ?? '');
}

/** Gera o link de redefinicao de senha. */
export async function linkDeRecuperacao(email: string): Promise<string> {
  const r = await call(
    '/admin/generate_link',
    { type: 'recovery', email, redirect_to: config.publicUrl },
    { admin: true },
  );
  return String(r.action_link ?? '');
}

export type Sessao = { user: SupabaseUser; accessToken: string; refreshToken: string };

export async function entrar(email: string, password: string): Promise<Sessao> {
  const r = await call('/token?grant_type=password', { email, password });
  return {
    user: toUser(r.user),
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
  };
}

/** Troca a senha de quem chegou pelo link de recuperacao. */
export async function trocarSenha(accessToken: string, password: string): Promise<SupabaseUser> {
  if (!supabaseReady()) throw new AuthError('Supabase nao configurado.', 503);
  const res = await fetch(`${BASE}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: ANON(),
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.msg ?? json?.message ?? json?.error ?? 'nao consegui trocar a senha';
    throw new AuthError(traduzir(String(msg), res.status), res.status);
  }
  return toUser(json);
}

/** Quem e o dono deste access token — usado quando o link do e-mail volta. */
export async function usuarioDoToken(accessToken: string): Promise<SupabaseUser> {
  if (!supabaseReady()) throw new AuthError('Supabase nao configurado.', 503);
  const res = await fetch(`${BASE}/auth/v1/user`, {
    headers: { apikey: ANON(), Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new AuthError('Esse link nao vale mais. Peca outro.', 401);
  return toUser(await res.json());
}

export async function listarUsuarios(): Promise<SupabaseUser[]> {
  if (!supabaseReady()) return [];
  const res = await fetch(`${BASE}/auth/v1/admin/users`, {
    headers: { apikey: SERVICE(), Authorization: `Bearer ${SERVICE()}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return [];
  const json = await res.json().catch(() => ({ users: [] }));
  return (json.users ?? []).map(toUser);
}

export async function apagarUsuario(id: string): Promise<void> {
  await fetch(`${BASE}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE(), Authorization: `Bearer ${SERVICE()}` },
    signal: AbortSignal.timeout(20_000),
  });
}
