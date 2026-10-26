import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';

import { config } from './config.ts';
import { db, getSetting, setSetting, newId, now, DEFAULT_SOUL } from './db.ts';
import {
  SESSION_COOKIE,
  createSession,
  criarTiquete,
  trocarTiquete,
  donoAtual,
  espelharUsuario,
  destroyAllSessions,
  destroySession,
  isLocked,
  listSessions,
  readSession,
  recentFailures,
  recordAttempt,
  sleep,
  throttleDelay,
  userCount,
  type Session,
} from './auth.ts';
import {
  allThoughts,
  coreBlock,
  extractAndStore,
  forget,
  liveThoughts,
  links,
  recall,
  remember,
  searchMessages,
  searchThoughts,
  stats,
  togglePin,
} from './memory.ts';
import {
  LlmError,
  streamChat,
  complete,
  listModels,
  activeModel,
  hasKey,
  apiKey,
  provider,
  type Prompt,
  type Tool,
  type ToolCall,
  type Turn,
  type Usage,
} from './llm.ts';
import {
  AuthError,
  criarConta,
  entrar,
  linkDeConfirmacao,
  linkDeRecuperacao,
  supabaseReady,
  trocarSenha,
  usuarioDoToken,
} from './supabase.ts';
import { sendMail, mailReady } from './mail.ts';
import { confirmacao, recuperacao } from './emails.ts';
import { executar, historico } from './executar.ts';
import { aoMudar, decidir, pendentes, cancelarPendentes, historicoAprovacoes } from './aprovacao.ts';
import { aparelhos, avisarAprovacao, registrarAparelho } from './push.ts';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: true,
  bodyLimit: 1_048_576,
});

await app.register(cookie);
await app.register(websocket, { options: { maxPayload: 1_048_576 } });
/**
 * O service worker, com a versao do cache calculada aqui.
 *
 * Antes a versao era escrita na mao no arquivo, e numa troca de nome ela nao
 * foi trocada junto — o telefone de quem tinha o site instalado ficou com a
 * casca antiga. A correcao seguinte foi o `install.sh` reescrever o arquivo no
 * deploy, e isso passou a ser um problema proprio: com o deploy por `git`, um
 * script que edita arquivo versionado suja a arvore e o `git pull` seguinte
 * para em conflito.
 *
 * Calcular na hora de servir resolve os dois. A versao e o resumo do que a
 * casca realmente contem: nao ha passo para esquecer, nem arquivo para sujar.
 */
const versaoDaCasca = (): string => {
  const soma = createHash('sha256');
  for (const arquivo of ['app.js', 'app.css', 'index.html']) {
    try {
      soma.update(readFileSync(resolve(config.webDir, arquivo)));
    } catch {
      /* arquivo ausente entra no resumo como ausencia, e tudo bem */
    }
  }
  return `thor-${soma.digest('hex').slice(0, 12)}`;
};

let cascaEmCache: { versao: string; corpo: string } | null = null;

app.get('/sw.js', async (_req, reply) => {
  if (!cascaEmCache) {
    const versao = versaoDaCasca();
    const fonte = readFileSync(resolve(config.webDir, 'sw.js'), 'utf8');
    cascaEmCache = { versao, corpo: fonte.replace('__VERSAO__', versao) };
  }
  return reply
    .type('application/javascript; charset=utf-8')
    // O proprio service worker nunca pode vir do cache: e ele que decide o
    // que fica em cache, e uma copia velha dele se perpetua sozinha.
    .header('Cache-Control', 'no-cache, no-store, must-revalidate')
    .send(cascaEmCache.corpo);
});

await app.register(fastifyStatic, { root: config.webDir, index: ['index.html'] });

// Cabecalhos de seguranca. A CSP e restritiva de proposito: nada de script
// externo, nada de CDN. Tudo que a pagina usa vem daqui.
app.addHook('onSend', async (req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Permissions-Policy', 'geolocation=(), camera=(), microphone=(self)');
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' wss: ws:",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  if (config.secureCookies) {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return payload;
});

const clientIp = (req: { ip: string }): string => req.ip || 'desconhecido';

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
function sessionOf(req: any): Session | null {
  const cabecalho = String(req.headers?.authorization ?? '');
  if (cabecalho.startsWith('Bearer ')) {
    const s = readSession(cabecalho.slice(7).trim());
    if (s) return s;
  }
  return readSession(req.cookies?.[SESSION_COOKIE]);
}

/** Portao das rotas privadas. Devolve a sessao ou encerra com 401. */
function requireSession(req: any, reply: any): Session | null {
  const s = sessionOf(req);
  if (!s) {
    reply.code(401).send({ error: 'nao autenticado' });
    return null;
  }
  return s;
}

const setSessionCookie = (reply: any, token: string): void => {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    maxAge: config.sessionDays * 86_400,
  });
};

// ---------------------------------------------------------------------------
// Conta e sessao
//
// As credenciais vivem no Supabase (GoTrue). A sessao do navegador e nossa.
//
// O navegador NUNCA ve um token do Supabase: recebe um cookie opaco, e quem
// fala com o GoTrue e o servidor, pelo localhost. Duas consequencias boas:
// um cookie roubado nao vira acesso a API do Supabase, e as rotas de senha
// nao existem na internet para serem marteladas.
// ---------------------------------------------------------------------------

/** So este endereco pode criar a conta. Vazio = a primeira conta leva. */
const OWNER_EMAIL = (process.env.LUK_OWNER_EMAIL ?? '').trim().toLowerCase();
const normalizar = (e: unknown): string => String(e ?? '').trim().toLowerCase();
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

app.get('/api/state', async (req) => {
  const s = sessionOf(req);
  const dono = donoAtual();
  return {
    setup: !dono,
    authed: Boolean(s),
    user: s ? { username: s.username } : null,
    ownerEmail: dono?.email ?? OWNER_EMAIL ?? null,
    hasLlm: hasKey(),
    model: activeModel(),
    provider: provider(),
    siteName: config.siteName,
  };
});

/**
 * Manda o e-mail. Se o envio falhar, o link vai para o log do servico — sem
 * isso, uma falha de SMTP deixaria a conta inacessivel sem saida nenhuma.
 */
async function enviarLink(
  to: string,
  corpo: { subject: string; text: string; html: string },
  link: string,
): Promise<void> {
  try {
    await sendMail({ to, ...corpo });
  } catch (err) {
    app.log.error({ err }, `falha ao enviar e-mail para ${to}. Link de emergencia: ${link}`);
    throw new Error(
      'A conta foi criada, mas o e-mail nao saiu. O link esta no log do servidor ' +
        '(sudo journalctl -u luk -n 50).',
    );
  }
}

app.post('/api/auth/signup', async (req: any, reply) => {
  if (donoAtual()) return reply.code(409).send({ error: 'ja existe conta neste Thor' });

  const email = normalizar(req.body?.email);
  const password = String(req.body?.password ?? '');

  if (!EMAIL_OK.test(email)) return reply.code(400).send({ error: 'e-mail invalido' });
  if (OWNER_EMAIL && email !== OWNER_EMAIL) {
    // Resposta lenta e generica: nao confirma qual endereco e o do dono.
    await sleep(700);
    return reply.code(403).send({ error: 'esse e-mail nao pode criar conta aqui' });
  }
  if (password.length < 12) {
    return reply.code(400).send({ error: 'a senha precisa de ao menos 12 caracteres' });
  }

  let criada;
  try {
    criada = await criarConta(email, password);
    espelharUsuario(criada.user.id, criada.user.email);
  } catch (err: any) {
    const status = err instanceof AuthError ? err.status : 500;
    return reply.code(status === 500 ? 502 : status).send({ error: err.message });
  }

  // A conta JA existe a partir daqui. Uma falha de e-mail agora nao pode virar
  // erro de cadastro: a pessoa ficaria com conta criada, sem poder criar de
  // novo (409) e sem o link para confirmar. Entao responde sucesso com aviso,
  // e a tela seguinte oferece reenviar.
  try {
    await enviarLink(email, confirmacao(criada.link), criada.link);
    return { ok: true, email, precisaConfirmar: !criada.user.emailConfirmed };
  } catch (err: any) {
    return { ok: true, email, precisaConfirmar: true, avisoEmail: err.message };
  }
});

app.post('/api/auth/resend', async (req: any, reply) => {
  const email = normalizar(req.body?.email);
  const dono = donoAtual();
  // Sempre responde ok: quem nao e o dono nao descobre nada tentando.
  if (!dono || dono.email !== email) {
    await sleep(500);
    return { ok: true };
  }
  try {
    const link = await linkDeConfirmacao(email);
    await enviarLink(email, confirmacao(link), link);
  } catch (err: any) {
    return reply.code(502).send({ error: err.message });
  }
  return { ok: true };
});

app.post('/api/auth/forgot', async (req: any, reply) => {
  const email = normalizar(req.body?.email);
  const dono = donoAtual();
  if (!dono || dono.email !== email) {
    await sleep(500);
    return { ok: true };
  }
  try {
    const link = await linkDeRecuperacao(email);
    await enviarLink(email, recuperacao(link), link);
  } catch (err: any) {
    return reply.code(502).send({ error: err.message });
  }
  return { ok: true };
});

app.post('/api/auth/login', async (req: any, reply) => {
  const ip = clientIp(req);
  if (isLocked(ip)) {
    return reply.code(429).send({ error: 'tentativas demais. Espere 15 minutos e tente de novo.' });
  }
  await sleep(throttleDelay(recentFailures(ip)));

  const email = normalizar(req.body?.email);
  const password = String(req.body?.password ?? '');

  try {
    const sess = await entrar(email, password);
    if (!sess.user.emailConfirmed) {
      recordAttempt(ip, false);
      return reply.code(403).send({
        error: 'Falta confirmar o e-mail. Procure a mensagem na sua caixa de entrada.',
        precisaConfirmar: true,
      });
    }
    espelharUsuario(sess.user.id, sess.user.email);
    recordAttempt(ip, true);
    const token = createSession(sess.user.id, ip, req.headers['user-agent']);
    setSessionCookie(reply, token);
    // O token so sai no corpo quando o app pede. No site ele fica preso no
    // cookie httpOnly, fora do alcance do JavaScript da pagina.
    return req.body?.app === true
      ? { ok: true, email: sess.user.email, token }
      : { ok: true, email: sess.user.email };
  } catch (err: any) {
    recordAttempt(ip, false);
    const status = err instanceof AuthError ? err.status : 500;
    return reply.code(status === 500 ? 502 : status).send({
      error: err.message,
      precisaConfirmar: String(err.message).includes('confirmar'),
    });
  }
});

/**
 * Recebe o token que o link do e-mail devolveu na URL e troca por uma sessao
 * nossa. E o que faz confirmar o e-mail ja deixar a pessoa logada.
 */
app.post('/api/auth/adopt', async (req: any, reply) => {
  const accessToken = String(req.body?.accessToken ?? '');
  if (!accessToken) return reply.code(400).send({ error: 'sem token' });
  try {
    const user = await usuarioDoToken(accessToken);
    if (!user.emailConfirmed) {
      return reply.code(403).send({ error: 'e-mail ainda nao confirmado' });
    }
    espelharUsuario(user.id, user.email);
    setSessionCookie(reply, createSession(user.id, clientIp(req), req.headers['user-agent']));
    return { ok: true, email: user.email };
  } catch (err: any) {
    return reply.code(err instanceof AuthError ? err.status : 401).send({ error: err.message });
  }
});

/** Define a senha nova de quem chegou pelo link de recuperacao. */
app.post('/api/auth/reset', async (req: any, reply) => {
  const accessToken = String(req.body?.accessToken ?? '');
  const password = String(req.body?.password ?? '');
  if (!accessToken) return reply.code(400).send({ error: 'sem token' });
  if (password.length < 12) {
    return reply.code(400).send({ error: 'a senha precisa de ao menos 12 caracteres' });
  }
  try {
    const user = await trocarSenha(accessToken, password);
    espelharUsuario(user.id, user.email);
    // Trocar a senha derruba as outras sessoes: e o ponto de trocar a senha.
    destroyAllSessions(user.id);
    setSessionCookie(reply, createSession(user.id, clientIp(req), req.headers['user-agent']));
    return { ok: true, email: user.email };
  } catch (err: any) {
    return reply.code(err instanceof AuthError ? err.status : 400).send({ error: err.message });
  }
});

app.post('/api/logout', async (req: any, reply) => {
  destroySession(req.cookies?.[SESSION_COOKIE]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

app.get('/api/sessions', async (req: any, reply) => {
  const s = requireSession(req, reply);
  if (!s) return;
  return { sessions: listSessions(s.userId), current: s.id };
});

app.delete('/api/sessions', async (req: any, reply) => {
  const s = requireSession(req, reply);
  if (!s) return;
  destroyAllSessions(s.userId);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Conversas
// ---------------------------------------------------------------------------

app.get('/api/conversations', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.created_at AS createdAt, c.updated_at AS updatedAt,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS count
         FROM conversations c
        WHERE c.archived = 0
        ORDER BY c.updated_at DESC LIMIT 100`,
    )
    .all();
  return { conversations: rows };
});

app.get('/api/conversations/:id', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  const conv = db
    .prepare(`SELECT id, title, created_at AS createdAt FROM conversations WHERE id = ?`)
    .get(req.params.id);
  if (!conv) return reply.code(404).send({ error: 'conversa nao encontrada' });
  const messages = db
    .prepare(
      `SELECT id, role, content, created_at AS createdAt, model
         FROM messages WHERE conversation_id = ? ORDER BY created_at`,
    )
    .all(req.params.id);
  return { conversation: conv, messages };
});

app.delete('/api/conversations/:id', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(req.params.id);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Teia de pensamento
// ---------------------------------------------------------------------------

app.get('/api/thoughts', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  const all = req.query?.all === '1';
  return {
    thoughts: all ? allThoughts() : liveThoughts(),
    links: links(),
    stats: stats(),
  };
});

app.post('/api/thoughts', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  const { kind, content } = req.body ?? {};
  const t = remember(String(kind ?? 'fato'), String(content ?? ''), null, 1);
  if (!t) return reply.code(400).send({ error: 'conteudo invalido ou repetido' });
  return { thought: t };
});

app.delete('/api/thoughts/:id', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  forget(req.params.id);
  return { ok: true };
});

app.post('/api/thoughts/:id/pin', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  togglePin(req.params.id);
  return { ok: true };
});

/** Tudo que o Thor tentou rodar, autorizado ou nao. */
app.get('/api/comandos', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  return { comandos: historico(Number(req.query?.limite ?? 100)) };
});

// Decidir por HTTP, nao so pelo websocket: o pedido pode nascer numa aba e ser
// decidido em outra, ou no celular. Quem resolve a espera e o registro, nao a
// conexao que perguntou.
app.post('/api/aprovacoes/:id', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  const ok = decidir(String(req.params?.id ?? ''), req.body?.aprovado === true);
  if (!ok) return reply.code(409).send({ error: 'pedido ja decidido ou inexistente' });
  return { ok: true };
});

app.get('/api/aprovacoes', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  return { pendentes: pendentes(), historico: historicoAprovacoes(50) };
});

/** O app troca a sessao por um tiquete curto para abrir o websocket. */
app.get('/api/ws-ticket', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  const cabecalho = String(req.headers?.authorization ?? '');
  const token = cabecalho.startsWith('Bearer ')
    ? cabecalho.slice(7).trim()
    : req.cookies?.[SESSION_COOKIE];
  return { ticket: criarTiquete(token) };
});

/** O app registra o aparelho para receber aviso de aprovacao. */
app.post('/api/aparelhos', async (req: any, reply) => {
  const s = requireSession(req, reply);
  if (!s) return;
  const token = String(req.body?.token ?? '').trim();
  if (!token.startsWith('ExponentPushToken') && !token.startsWith('ExpoPushToken')) {
    return reply.code(400).send({ error: 'token de push invalido' });
  }
  registrarAparelho(
    s.userId,
    token,
    String(req.body?.plataforma ?? 'desconhecida'),
    req.body?.nome ? String(req.body.nome).slice(0, 80) : null,
  );
  return { ok: true };
});

app.get('/api/aparelhos', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  // O token nao volta: serve para empurrar aviso, nao para a tela mostrar.
  return { aparelhos: aparelhos().map(({ id, plataforma, nome }) => ({ id, plataforma, nome })) };
});

// O aviso no celular e disparado aqui, e nao dentro de aprovacao.ts, para o
// registro de aprovacoes nao precisar saber que push existe. Ele anuncia o que
// aconteceu; quem se importa, escuta. Se amanha o aviso tambem for por e-mail,
// entra outro ouvinte e aprovacao.ts continua igual.
aoMudar((p) => {
  if (p.estado === 'pendente') void avisarAprovacao(p.id, p.comando);
});

app.get('/api/search', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  const q = String(req.query?.q ?? '').trim();
  if (!q) return { thoughts: [], messages: [] };
  return { thoughts: searchThoughts(q), messages: searchMessages(q) };
});

// ---------------------------------------------------------------------------
// Alma (personalidade)
// ---------------------------------------------------------------------------

app.get('/api/soul', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  return { soul: getSetting('soul', DEFAULT_SOUL), isDefault: getSetting('soul') === DEFAULT_SOUL };
});

app.put('/api/soul', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  const { soul } = req.body ?? {};
  if (typeof soul !== 'string' || soul.length > 20_000) {
    return reply.code(400).send({ error: 'texto invalido' });
  }
  setSetting('soul', soul);
  return { ok: true };
});

app.post('/api/soul/reset', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  setSetting('soul', DEFAULT_SOUL);
  return { ok: true, soul: DEFAULT_SOUL };
});

// ---------------------------------------------------------------------------
// Configuracao (chave da IA e modelo)
//
// Guardados no banco, nao no .env: trocar de modelo ou renovar a chave vira
// um campo na tela em vez de uma sessao de SSH. A chave nunca volta inteira
// para o navegador — so os ultimos caracteres, o bastante para conferir qual e.
// ---------------------------------------------------------------------------

const hint = (k: string) => (k ? `...${k.slice(-6)}` : '');

app.get('/api/config', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  return {
    provider: provider(),
    model: activeModel(),
    openrouter: { hasKey: hasKey('openrouter'), hint: hint(apiKey('openrouter')) },
    anthropic: { hasKey: hasKey('anthropic'), hint: hint(apiKey('anthropic')) },
    ready: hasKey(),
  };
});

/**
 * Cada provedor guarda a propria chave e o proprio modelo. Trocar de provedor
 * nao apaga nada: volta tudo como estava se voce trocar de volta.
 */
app.put('/api/config', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  const body = req.body ?? {};

  if (typeof body.provider === 'string') {
    if (body.provider !== 'openrouter' && body.provider !== 'anthropic') {
      return reply.code(400).send({ error: 'provedor invalido' });
    }
    setSetting('provider', body.provider);
  }

  // O prefixo da chave e a unica validacao barata que existe, e pega o engano
  // mais comum: colar a chave de um provedor no campo do outro.
  for (const [campo, chave, prefixo] of [
    ['openrouterKey', 'openrouter_key', 'sk-or-'],
    ['anthropicKey', 'anthropic_key', 'sk-ant-'],
  ] as const) {
    const v = body[campo];
    if (typeof v === 'string' && v.trim()) {
      const limpa = v.trim();
      if (!limpa.startsWith(prefixo)) {
        return reply.code(400).send({ error: `essa chave deveria comecar com ${prefixo}` });
      }
      setSetting(chave, limpa);
    }
  }

  if (typeof body.model === 'string' && body.model.trim()) {
    setSetting(`model_${provider()}`, body.model.trim());
  }

  return { ok: true, provider: provider(), model: activeModel(), ready: hasKey() };
});

/** Lista os modelos do provedor ativo, para a tela de configuracao. */
app.get('/api/models', async (req: any, reply) => {
  if (!requireSession(req, reply)) return;
  try {
    return { provider: provider(), models: await listModels() };
  } catch (err: any) {
    return reply.code(502).send({ error: err?.message ?? 'nao consegui listar os modelos' });
  }
});

// ---------------------------------------------------------------------------
// Chat por WebSocket
// ---------------------------------------------------------------------------

const MEMORY_WINDOW = Number(process.env.LUK_WINDOW ?? 24);

/**
 * A ferramenta que substitui a injecao automatica de memoria.
 *
 * Antes, todo turno levava um bloco de memoria montado a partir da pergunta —
 * dentro do system prompt. Isso mudava o prefixo a cada mensagem e matava o
 * cache. Agora o Thor decide quando precisa e paga so quando usa.
 */
const MEMORY_TOOL: Tool = {
  name: 'buscar_memoria',
  description:
    'Procura no arquivo de memoria: tudo que voce ja guardou sobre o Lucas e todas as ' +
    'conversas anteriores. Use quando a resposta depender de algo que nao esta na ' +
    'conversa atual nem na memoria fixada — um projeto antigo, uma decisao passada, ' +
    'uma preferencia que voce nao lembra. Nao use para o que ja esta visivel aqui.',
  schema: {
    type: 'object',
    properties: {
      consulta: {
        type: 'string',
        description:
          'Palavras-chave do que procurar. Prefira termos concretos (nomes de projeto, ' +
          'tecnologias, pessoas) a frases inteiras.',
      },
    },
    required: ['consulta'],
    additionalProperties: false,
  },
};

const SHELL_TOOL: Tool = {
  name: 'executar',
  description:
    'Roda um comando no servidor dedicated-1 (Ubuntu) e devolve a saida. Use para ' +
    'responder sobre o estado da maquina: servicos, logs, disco, memoria, processos, ' +
    'rede, conteudo de arquivo. ' +
    'Consulta roda na hora. Comando que GRAVA arquivo dentro de /opt/luk/data ou /tmp ' +
    'tambem funciona, mas para e pede autorizacao ao Lucas primeiro — voce espera a ' +
    'resposta dele. Fora disso nao passa: apagar coisa de outro lugar, reiniciar servico, ' +
    'instalar pacote, mandar dados para fora. Se o comando for recusado, a resposta diz o ' +
    'motivo: explique ao Lucas em vez de tentar contornar. Encadear com pipe funciona.',
  schema: {
    type: 'object',
    properties: {
      comando: {
        type: 'string',
        description:
          'A linha de comando. Exemplos: "systemctl status luk", ' +
          '"journalctl -u luk -n 30 --no-pager", "df -h /", "free -h", ' +
          '"ss -tln", "docker compose ps".',
      },
      motivo: {
        type: 'string',
        description:
          'Obrigatorio quando o comando grava algo. Uma frase curta dizendo para que ' +
          'serve, que aparece no pedido de autorizacao. Escreva para o Lucas ler, nao ' +
          'para me convencer.',
      },
    },
    required: ['comando'],
    additionalProperties: false,
  },
};

async function runTool(name: string, rawArgs: string): Promise<string> {
  let args: any;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    return 'Nao consegui ler os argumentos. Mande JSON valido.';
  }

  if (name === 'buscar_memoria') {
    const q = String(args.consulta ?? '').trim();
    if (!q) return 'A busca veio vazia. Mande palavras-chave em "consulta".';
    return recall(q);
  }

  if (name === 'executar') {
    const cmd = String(args.comando ?? '').trim();
    if (!cmd) return 'Veio vazio. Mande a linha de comando em "comando".';
    const r = await executar(cmd, String(args.motivo ?? '').trim());
    // O motivo da recusa volta para o modelo de proposito: assim ele explica
    // ao Lucas o que esta barrado, em vez de insistir ou inventar.
    return r.ok ? r.saida : `RECUSADO: ${r.motivo}`;
  }

  return `Ferramenta desconhecida: ${name}`;
}

/**
 * Monta o prompt com o prefixo estavel na frente e o marcador de cache.
 *
 * A ordem importa e nao e estetica: o cache casa por prefixo exato, e em
 * modelos da Anthropic ele **nao e automatico** — sem `cache_control`, nada e
 * cacheado. Entao:
 *
 *   1. alma + nucleo da memoria, que mudam raramente  -> marcados, cacheados
 *   2. a data, que muda todo dia                       -> DEPOIS do marcador
 *   3. o historico, que so cresce no fim               -> segundo marcador
 *
 * Por que a data fica depois do marcador: conteudo que vem depois do ultimo
 * `cache_control` nao e cacheado, mas tambem **nao invalida** o que vem antes.
 * Custa uns 10 tokens por requisicao e evita uma invalidacao diaria de tudo.
 */
function buildPrompt(conversationId: string): Prompt {
  const soul = getSetting('soul', DEFAULT_SOUL);
  const core = coreBlock();

  const history = db
    .prepare(
      `SELECT role, content FROM messages
        WHERE conversation_id = ? AND role IN ('user','assistant')
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(conversationId, MEMORY_WINDOW) as { role: string; content: string }[];

  return {
    // Estavel entre turnos: e isto que vai levar o marcador de cache em
    // qualquer um dos dois provedores.
    systemStable: [soul, core].filter(Boolean).join('\n\n'),
    // Muda todo dia, entao fica depois do marcador: nao cacheia, mas tambem
    // nao invalida o prefixo.
    systemVolatile: `Hoje e ${new Date().toISOString().slice(0, 10)}.`,
    turns: history.reverse().map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  };
}

function saveMessage(
  conversationId: string,
  role: string,
  content: string,
  model?: string,
): string {
  const id = newId();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, conversationId, role, content, model ?? null, now());
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(
    now(),
    conversationId,
  );
  return id;
}

const fallbackTitle = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 48 ? `${one.slice(0, 48)}...` : one || 'Conversa';
};

/** Titulo decente sem travar a resposta: tenta o modelo, aceita o corte. */
async function improveTitle(conversationId: string, text: string): Promise<string | null> {
  if (!hasKey()) return null;
  try {
    const t = await complete(
      'Resuma a mensagem do usuario num titulo curto de 2 a 5 palavras, em portugues, ' +
        'sem pontuacao final e sem aspas.',
      text.slice(0, 800),
      24,
    );
    const clean = t.replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 60);
    if (!clean) return null;
    db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(clean, conversationId);
    return clean;
  } catch {
    return null;
  }
}

app.register(async (scope) => {
  scope.get('/ws', { websocket: true }, (conn: any, req: any) => {
    const socket: any = conn?.socket ?? conn;
    // Site manda cookie; app manda tiquete de uso unico na URL.
    const session =
      readSession(req.cookies?.[SESSION_COOKIE]) ?? trocarTiquete(req.query?.ticket);

    const send = (obj: unknown): void => {
      if (socket.readyState === 1) socket.send(JSON.stringify(obj));
    };

    if (!session) {
      send({ t: 'error', message: 'Sessao expirada. Entre de novo.' });
      socket.close(4401, 'nao autenticado');
      return;
    }

    let busy = false;
    let aborter: AbortController | null = null;

    // Pedidos de autorizacao chegam por aqui, e tambem os que foram decididos
    // em outro aparelho — e por isso que isto escuta o registro em vez de
    // mandar direto no ponto onde o pedido nasce: o Lucas pode abrir o site no
    // celular e decidir ali, e esta aba precisa ver o cartao sair da tela.
    const pararDeOuvir = aoMudar((p) => send({ t: 'aprovacao', pedido: p }));
    socket.on('close', pararDeOuvir);

    // Quem entra no meio de um pedido em aberto precisa ve-lo.
    for (const p of pendentes()) send({ t: 'aprovacao', pedido: p });

    socket.on('message', async (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send({ t: 'error', message: 'mensagem invalida' });
      }

      if (msg.t === 'stop') {
        aborter?.abort();
        // Parar tem de alcancar o que estava so esperando resposta: cartao de
        // autorizacao ainda de pe seria um botao vivo de um turno abandonado.
        cancelarPendentes();
        return;
      }
      if (msg.t === 'decidir') {
        const id = String(msg.id ?? '');
        decidir(id, msg.aprovado === true);
        return;
      }
      if (msg.t !== 'chat') return;
      if (busy) return send({ t: 'error', message: 'ainda estou respondendo a anterior' });

      const text = String(msg.text ?? '').trim();
      if (!text) return;
      if (text.length > 32_000) {
        return send({ t: 'error', message: 'mensagem longa demais' });
      }

      busy = true;
      aborter = new AbortController();

      try {
        // Conversa nova, se for o caso.
        let conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : '';
        const exists =
          conversationId &&
          db.prepare(`SELECT 1 FROM conversations WHERE id = ?`).get(conversationId);

        if (!exists) {
          conversationId = newId();
          const title = fallbackTitle(text);
          db.prepare(
            `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
          ).run(conversationId, title, now(), now());
          send({ t: 'conversation', id: conversationId, title });
          improveTitle(conversationId, text).then((better) => {
            if (better) send({ t: 'title', id: conversationId, title: better });
          });
        }

        const userMsgId = saveMessage(conversationId, 'user', text);
        send({ t: 'saved', role: 'user', id: userMsgId, conversationId });

        const prompt = buildPrompt(conversationId);
        send({ t: 'start' });

        let full = '';
        let usage: Usage | null = null;
        let rounds = 0;

        // Laco do agente: o Thor pode pedir uma busca na memoria, ler o
        // resultado e continuar escrevendo. Teto baixo de proposito — cada
        // volta e uma requisicao paga, e precisar de mais de tres buscas
        // seguidas costuma ser pergunta mal formulada, nao teto apertado.
        while (rounds < 4) {
          rounds += 1;
          let calls: ToolCall[] | null = null;
          let roundText = '';

          for await (const ev of streamChat(prompt, {
            signal: aborter.signal,
            tools: [MEMORY_TOOL, SHELL_TOOL],
          })) {
            if (ev.type === 'text') {
              roundText += ev.text;
              full += ev.text;
              // As marcas de memoria sao removidas no fim; enquanto escreve, o
              // cliente esconde o que estiver dentro de uma marca em aberto.
              send({ t: 'delta', text: ev.text });
            } else if (ev.type === 'tools') {
              calls = ev.calls;
            } else if (ev.type === 'usage') {
              usage = ev.usage;
            }
          }

          if (!calls || calls.length === 0) break;

          prompt.turns.push({ role: 'assistant', content: roundText, toolCalls: calls });

          for (const call of calls) {
            let consulta = '';
            try {
              const a = JSON.parse(call.args || '{}');
              consulta = String(a.consulta ?? a.comando ?? '');
            } catch {
              /* argumento ilegivel vira mensagem de erro dentro do runTool */
            }
            send({ t: 'tool', name: call.name, query: consulta });
            prompt.turns.push({
              role: 'tool',
              toolCallId: call.id,
              content: await runTool(call.name, call.args),
            });
          }
        }

        if (usage) {
          const total = usage.prompt || 1;
          const pct = Math.round((usage.cached / total) * 100);
          app.log.info(
            `[${provider()}] cache ${pct}% (${usage.cached}/${total} lidos, ` +
              `${usage.written} escritos) saida ${usage.completion} tokens, ${rounds} volta(s)`,
          );
        }

        const assistantId = newId();
        const { clean, saved } = extractAndStore(full, assistantId);
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, content, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(assistantId, conversationId, 'assistant', clean, activeModel(), now());
        db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(
          now(),
          conversationId,
        );

        send({
          t: 'done',
          id: assistantId,
          conversationId,
          content: clean,
          remembered: saved,
          stats: stats(),
          usage,
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          send({ t: 'aborted' });
        } else {
          const message =
            err instanceof LlmError
              ? err.message
              : `Falhou aqui dentro: ${String(err?.message ?? err).slice(0, 300)}`;
          app.log.error({ err }, 'falha no chat');
          send({ t: 'error', message });
        }
      } finally {
        busy = false;
        aborter = null;
      }
    });

    send({ t: 'ready', model: activeModel(), hasLlm: hasKey(), stats: stats() });
  });
});

// Rotas desconhecidas que nao sao de API caem no index: o front e uma pagina
// unica e cuida das suas proprias telas.
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
    return reply.code(404).send({ error: 'nao encontrado' });
  }
  return reply.sendFile('index.html');
});

const address = await app.listen({ port: config.port, host: config.host });
app.log.info(
  `Thor no ar em ${address} — LLM ${hasKey() ? `ok (${activeModel()})` : 'SEM CHAVE'}, ` +
    `usuarios: ${userCount()}`,
);
