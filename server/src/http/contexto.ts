import { config } from '../config.ts';
import { SESSION_COOKIE, readSession, type Session } from '../auth.ts';

// ===========================================================================
// O que toda rota precisa saber: quem esta falando.
//
// Fica num modulo proprio porque e usado por todos os grupos de rota, e porque
// e o unico lugar onde se decide o que conta como estar autenticado. Espalhar
// essa decisao por cinco arquivos seria criar cinco oportunidades de divergir.
// ===========================================================================

export const clientIp = (req: { ip: string }): string => req.ip || 'desconhecido';

/**
 * Acha a sessao no cookie (site) ou no cabecalho Authorization (app).
 *
 * A sessao sempre foi um token aleatorio guardado so como hash no banco — o
 * cookie era apenas o transporte. Entao atender o app nao exigiu inventar um
 * segundo sistema de login: e o mesmo token por outro caminho.
 *
 * O site continua com cookie `httpOnly`, que o JavaScript da pagina nao le. O
 * app precisa ler o token para guardar no Keychain do iPhone, e por isso ele
 * so e devolvido no corpo quando o cliente pede explicitamente.
 */
export function sessionOf(req: any): Session | null {
  const cabecalho = String(req.headers?.authorization ?? '');
  if (cabecalho.startsWith('Bearer ')) {
    const s = readSession(cabecalho.slice(7).trim());
    if (s) return s;
  }
  return readSession(req.cookies?.[SESSION_COOKIE]);
}

/** Portao das rotas privadas. Devolve a sessao ou encerra com 401. */
export function requireSession(req: any, reply: any): Session | null {
  const s = sessionOf(req);
  if (!s) {
    reply.code(401).send({ error: 'nao autenticado' });
    return null;
  }
  return s;
}

export const setSessionCookie = (reply: any, token: string): void => {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    maxAge: config.sessionDays * 86_400,
  });
};

export const normalizar = (e: unknown): string => String(e ?? '').trim().toLowerCase();

export const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** So este endereco pode criar a conta. Vazio = a primeira conta leva. */
export const OWNER_EMAIL = (process.env.THOR_OWNER_EMAIL ?? process.env.LUK_OWNER_EMAIL ?? '')
  .trim()
  .toLowerCase();
