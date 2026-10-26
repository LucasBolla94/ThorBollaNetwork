import { db, newId, now } from '../db.ts';
import { coreBlock, extractAndStore, recall } from '../memory.ts';
import { complete, type Prompt, type Tool, type Turn } from '../llm.ts';
import { executar } from '../executar.ts';

// O que o agente usa para pensar: as ferramentas que ele pode chamar, o
// prompt que ele recebe e o que fica guardado depois. O transporte — quem
// entrega isso ao modelo e devolve ao navegador — mora em canal.ts.

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
export const MEMORY_TOOL: Tool = {
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

export const SHELL_TOOL: Tool = {
  name: 'executar',
  description:
    'Roda um comando no servidor dedicated-1 (Ubuntu) e devolve a saida. Use para ' +
    'responder sobre o estado da maquina: servicos, logs, disco, memoria, processos, ' +
    'rede, conteudo de arquivo. ' +
    'Consulta roda na hora. Comando que GRAVA arquivo dentro de /opt/thor/data ou /tmp ' +
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

export async function runTool(name: string, rawArgs: string): Promise<string> {
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
export function buildPrompt(conversationId: string): Prompt {
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

export function saveMessage(
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
export async function improveTitle(conversationId: string, text: string): Promise<string | null> {
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
