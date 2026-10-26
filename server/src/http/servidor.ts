import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { config } from '../config.ts';

// ===========================================================================
// O servidor HTTP em si: instancia, arquivos estaticos, cabecalhos.
//
// Nenhuma regra de negocio mora aqui. Se um dia houver um segundo processo
// (um worker, um painel separado), ele comeca por este arquivo e registra
// outras rotas — e e por isso que ele nao sabe o que e uma conversa nem o que
// e um pensamento.
// ===========================================================================

/**
 * A versao do cache do service worker, calculada a partir da casca.
 *
 * Ja foi escrita na mao, e numa troca de nome nao foi trocada junto — o
 * telefone de quem tinha o site instalado ficou com a casca antiga. A correcao
 * seguinte foi o instalador reescrever o arquivo no deploy, e isso virou outro
 * problema: com deploy por git, script que edita arquivo versionado suja a
 * arvore e trava o `git pull` seguinte.
 *
 * Calcular na hora de servir resolve os dois. A versao passa a ser o resumo do
 * que a casca realmente contem: nao ha passo para esquecer nem arquivo para
 * sujar.
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

let casca: string | null = null;

export async function criarServidor(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1_048_576 } });

  app.get('/sw.js', async (_req, reply) => {
    if (!casca) {
      const fonte = readFileSync(resolve(config.webDir, 'sw.js'), 'utf8');
      casca = fonte.replace('__VERSAO__', versaoDaCasca());
    }
    return reply
      .type('application/javascript; charset=utf-8')
      // O proprio service worker nunca pode vir do cache: e ele que decide o
      // que fica em cache, e uma copia velha dele se perpetua sozinha.
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .send(casca);
  });

  await app.register(fastifyStatic, { root: config.webDir, index: ['index.html'] });

  // Cabecalhos de seguranca. A CSP e restritiva de proposito: nada de script
  // externo, nada de CDN. Tudo que a pagina usa vem daqui.
  app.addHook('onSend', async (_req, reply, payload) => {
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

  return app;
}

/**
 * Rota desconhecida que nao e de API cai no index: o front e uma pagina unica
 * e cuida das suas proprias telas.
 *
 * Registrado depois de todas as rotas, porque ele e a ultima palavra.
 */
export function rotaDeSobra(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'nao encontrado' });
    }
    return reply.sendFile('index.html');
  });
}
