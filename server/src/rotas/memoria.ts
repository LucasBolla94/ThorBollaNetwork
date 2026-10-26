import type { FastifyInstance } from 'fastify';
import { allThoughts, forget, liveThoughts, links, remember, searchMessages, searchThoughts, stats, togglePin } from '../memory.ts';
import { requireSession } from '../http/contexto.ts';

// A teia de pensamento e a busca.

export async function rotas(app: FastifyInstance): Promise<void> {
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


  app.get('/api/search', async (req: any, reply) => {
    if (!requireSession(req, reply)) return;
    const q = String(req.query?.q ?? '').trim();
    if (!q) return { thoughts: [], messages: [] };
    return { thoughts: searchThoughts(q), messages: searchMessages(q) };
  });
}
