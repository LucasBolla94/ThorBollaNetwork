import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { getSetting, setSetting, DEFAULT_SOUL } from '../db.ts';
import { listModels, activeModel, hasKey, apiKey, provider } from '../llm.ts';
import { requireSession } from '../http/contexto.ts';

// A alma e a configuracao do modelo.

export async function rotas(app: FastifyInstance): Promise<void> {
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
}
