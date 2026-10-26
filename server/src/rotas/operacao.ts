import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, criarTiquete } from '../auth.ts';
import { historico } from '../executar.ts';
import { aoMudar, decidir, pendentes, historicoAprovacoes } from '../aprovacao.ts';
import { aparelhos, avisarAprovacao, registrarAparelho } from '../push.ts';
import { requireSession } from '../http/contexto.ts';

// Auditoria, aprovacoes e aparelhos.

export async function rotas(app: FastifyInstance): Promise<void> {
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
}
