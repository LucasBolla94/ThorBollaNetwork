import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { requireSession } from '../http/contexto.ts';

// Conversas guardadas.

export async function rotas(app: FastifyInstance): Promise<void> {
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
}
