import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { SESSION_COOKIE, createSession, donoAtual, espelharUsuario, destroyAllSessions, destroySession, isLocked, listSessions, recentFailures, recordAttempt, sleep, throttleDelay } from '../auth.ts';
import { activeModel, hasKey, provider } from '../llm.ts';
import { AuthError, criarConta, entrar, linkDeConfirmacao, linkDeRecuperacao, trocarSenha, usuarioDoToken } from '../supabase.ts';
import { sendMail } from '../mail.ts';
import { confirmacao, recuperacao } from '../emails.ts';
import { clientIp, sessionOf, requireSession, setSessionCookie, normalizar, EMAIL_OK, OWNER_EMAIL } from '../http/contexto.ts';

// Conta e sessao.

export async function rotas(app: FastifyInstance): Promise<void> {
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
          '(sudo journalctl -u thor -n 50).',
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
}
