import { config } from './config.ts';
import { getSetting } from './db.ts';

// ===========================================================================
// Camada de modelo — fala com o OpenRouter ou direto com a Anthropic.
//
// Os dois formatos sao bem diferentes, e a diferenca nao e cosmetica:
//
//   - OpenRouter usa o formato da OpenAI: o system e uma mensagem dentro do
//     array, ferramentas vao em `tools[].function`, e o resultado de uma
//     ferramenta e uma mensagem de papel "tool".
//   - A Anthropic tem o system como parametro proprio FORA das mensagens,
//     ferramentas com `input_schema`, e o resultado de ferramenta entra como
//     um bloco `tool_result` dentro de uma mensagem do usuario.
//
// Por isso o resto do programa nao fala nenhum dos dois: fala o formato
// neutro definido aqui embaixo, e cada adaptador traduz. Trocar de provedor
// vira trocar uma string na tela de configuracao.
// ===========================================================================

export type Provider = 'openrouter' | 'anthropic';

export const provider = (): Provider =>
  (getSetting('provider') || process.env.LUK_PROVIDER || 'openrouter') as Provider;

export const apiKey = (p: Provider = provider()): string =>
  p === 'anthropic'
    ? getSetting('anthropic_key') || process.env.ANTHROPIC_API_KEY || ''
    : getSetting('openrouter_key') || config.openrouterKey;

export const hasKey = (p: Provider = provider()): boolean => apiKey(p).length > 0;

const DEFAULT_MODEL: Record<Provider, string> = {
  openrouter: 'anthropic/claude-sonnet-5.5',
  anthropic: 'claude-sonnet-5-5',
};

export const activeModel = (): string => {
  const p = provider();
  return getSetting(`model_${p}`) || (p === 'openrouter' ? config.model : '') || DEFAULT_MODEL[p];
};

// ---------------------------------------------------------------------------
// Formato neutro
// ---------------------------------------------------------------------------

export type ToolCall = { id: string; name: string; args: string };

export type Turn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/**
 * O system dividido em duas partes de proposito.
 *
 * `stable` e tudo que nao muda entre turnos e leva o marcador de cache.
 * `volatile` (a data, por exemplo) vai DEPOIS do marcador: nao e cacheado,
 * mas tambem nao invalida o prefixo. Ver plan.md §22.
 */
export type Prompt = {
  systemStable: string;
  systemVolatile: string;
  turns: Turn[];
};

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema dos argumentos. */
  schema: Record<string, unknown>;
};

export type Usage = {
  prompt: number;
  completion: number;
  cached: number;
  written: number;
};

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tools'; calls: ToolCall[] }
  | { type: 'usage'; usage: Usage };

export class LlmError extends Error {
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

function friendlyError(status: number, detail: string): string {
  const quem = provider() === 'anthropic' ? 'A Anthropic' : 'O OpenRouter';
  if (status === 401) return `${quem} recusou a chave (401).`;
  if (status === 402) return `Sem credito (402).`;
  if (status === 429) return `${quem} aplicou limite de uso (429).`;
  if (status === 404) {
    return `O modelo "${activeModel()}" nao existe nesse provedor (404). Troque em Configuracao.`;
  }
  return `${quem} respondeu ${status}. ${detail.slice(0, 240)}`.trim();
}

// ---------------------------------------------------------------------------
// Leitor de SSE — comum aos dois provedores
//
// Duas armadilhas que todo parser de SSE tropeca: um evento pode ser cortado
// no meio da linha entre dois chunks (por isso o buffer sobrevive ao laco), e
// comentarios do protocolo (`: ping`) nao sao JSON.
// ---------------------------------------------------------------------------

async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<any, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';

    for (const raw of parts) {
      const line = raw.trim();
      if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        yield JSON.parse(payload);
      } catch {
        /* pedaco invalido isolado nao derruba o stream inteiro */
      }
    }
  }
}

// ===========================================================================
// Adaptador: OpenRouter (formato OpenAI)
// ===========================================================================

const OPENROUTER_URL =
  process.env.LUK_LLM_ENDPOINT ?? 'https://openrouter.ai/api/v1/chat/completions';

function openrouterBody(prompt: Prompt, tools: Tool[], maxTokens: number) {
  const system = [
    // O marcador de cache. Em modelos da Anthropic o OpenRouter NAO cacheia
    // sozinho — sem isto, nada e cacheado (plan.md §22.1).
    { type: 'text', text: prompt.systemStable, cache_control: { type: 'ephemeral' } },
  ];
  if (prompt.systemVolatile) system.push({ type: 'text', text: prompt.systemVolatile } as any);

  const messages: any[] = [{ role: 'system', content: system }];

  for (const t of prompt.turns) {
    if (t.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: t.toolCallId, content: t.content });
    } else if (t.role === 'assistant' && t.toolCalls?.length) {
      messages.push({
        role: 'assistant',
        content: t.content || null,
        tool_calls: t.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.args },
        })),
      });
    } else {
      messages.push({ role: t.role, content: t.content });
    }
  }

  // Segundo marcador: no fim do historico, para a conversa tambem virar
  // prefixo cacheado conforme cresce.
  const last = messages[messages.length - 1];
  if (last && typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  }

  return {
    model: activeModel(),
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.schema },
          })),
        }
      : {}),
  };
}

async function* openrouterStream(
  prompt: Prompt,
  tools: Tool[],
  opts: { signal?: AbortSignal; maxTokens: number },
): AsyncGenerator<StreamEvent, void, void> {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      Authorization: `Bearer ${apiKey('openrouter')}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.publicUrl,
      'X-Title': config.siteName,
    },
    body: JSON.stringify(openrouterBody(prompt, tools, opts.maxTokens)),
  });

  if (!res.ok || !res.body) {
    throw new LlmError(friendlyError(res.status, await res.text().catch(() => '')), res.status);
  }

  // Chamadas de ferramenta chegam fatiadas: o nome num chunk, os argumentos em
  // varios. Acumula por indice e so emite no fim.
  const partial = new Map<number, ToolCall>();

  for await (const json of sseLines(res.body)) {
    if (json.error) {
      throw new LlmError(`OpenRouter: ${String(json.error.message ?? json.error).slice(0, 240)}`);
    }

    if (json.usage) {
      const d = json.usage.prompt_tokens_details ?? {};
      yield {
        type: 'usage',
        usage: {
          prompt: json.usage.prompt_tokens ?? 0,
          completion: json.usage.completion_tokens ?? 0,
          cached: d.cached_tokens ?? 0,
          written: d.cache_write_tokens ?? json.usage.cache_write_tokens ?? 0,
        },
      };
    }

    const delta = json?.choices?.[0]?.delta;
    if (!delta) continue;

    if (typeof delta.content === 'string' && delta.content) {
      yield { type: 'text', text: delta.content };
    }

    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const slot = partial.get(idx) ?? { id: '', name: '', args: '' };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
      partial.set(idx, slot);
    }
  }

  if (partial.size) {
    yield {
      type: 'tools',
      calls: [...partial.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c),
    };
  }
}

// ===========================================================================
// Adaptador: Anthropic (formato nativo)
// ===========================================================================

const ANTHROPIC_URL =
  process.env.LUK_ANTHROPIC_ENDPOINT ?? 'https://api.anthropic.com/v1/messages';

function anthropicBody(prompt: Prompt, tools: Tool[], maxTokens: number) {
  const system: any[] = [
    { type: 'text', text: prompt.systemStable, cache_control: { type: 'ephemeral' } },
  ];
  if (prompt.systemVolatile) system.push({ type: 'text', text: prompt.systemVolatile });

  // A Anthropic nao tem papel "tool": o resultado volta como bloco dentro de
  // uma mensagem do usuario. E resultados seguidos precisam ser agrupados numa
  // mensagem so, senao o modelo passa a nao chamar ferramentas em paralelo.
  const messages: any[] = [];
  for (const t of prompt.turns) {
    if (t.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: t.toolCallId, content: t.content };
      const last = messages[messages.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block);
      } else {
        messages.push({ role: 'user', content: [block] });
      }
    } else if (t.role === 'assistant' && t.toolCalls?.length) {
      const content: any[] = [];
      if (t.content) content.push({ type: 'text', text: t.content });
      for (const c of t.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.args || '{}');
        } catch {
          input = {};
        }
        content.push({ type: 'tool_use', id: c.id, name: c.name, input });
      }
      messages.push({ role: 'assistant', content });
    } else {
      messages.push({ role: t.role, content: t.content });
    }
  }

  const last = messages[messages.length - 1];
  if (last && typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  }

  return {
    model: activeModel(),
    system,
    messages,
    stream: true,
    max_tokens: maxTokens,
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.schema,
          })),
        }
      : {}),
  };
}

async function* anthropicStream(
  prompt: Prompt,
  tools: Tool[],
  opts: { signal?: AbortSignal; maxTokens: number },
): AsyncGenerator<StreamEvent, void, void> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'x-api-key': apiKey('anthropic'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(anthropicBody(prompt, tools, opts.maxTokens)),
  });

  if (!res.ok || !res.body) {
    throw new LlmError(friendlyError(res.status, await res.text().catch(() => '')), res.status);
  }

  const usage: Usage = { prompt: 0, completion: 0, cached: 0, written: 0 };
  const open = new Map<number, ToolCall>();
  const calls: ToolCall[] = [];

  for await (const ev of sseLines(res.body)) {
    switch (ev.type) {
      case 'error':
        throw new LlmError(`Anthropic: ${String(ev.error?.message ?? '').slice(0, 240)}`);

      case 'message_start': {
        const u = ev.message?.usage ?? {};
        usage.prompt = u.input_tokens ?? 0;
        usage.cached = u.cache_read_input_tokens ?? 0;
        usage.written = u.cache_creation_input_tokens ?? 0;
        break;
      }

      case 'content_block_start':
        if (ev.content_block?.type === 'tool_use') {
          open.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, args: '' });
        }
        break;

      case 'content_block_delta': {
        const d = ev.delta ?? {};
        if (d.type === 'text_delta' && d.text) {
          yield { type: 'text', text: d.text };
        } else if (d.type === 'input_json_delta') {
          const slot = open.get(ev.index);
          if (slot) slot.args += d.partial_json ?? '';
        }
        // thinking_delta e ignorado de proposito: o raciocinio nao vai para a
        // tela e nao entra na resposta guardada.
        break;
      }

      case 'content_block_stop': {
        const slot = open.get(ev.index);
        if (slot) {
          calls.push(slot);
          open.delete(ev.index);
        }
        break;
      }

      case 'message_delta':
        usage.completion = ev.usage?.output_tokens ?? usage.completion;
        break;
    }
  }

  if (calls.length) yield { type: 'tools', calls };
  yield { type: 'usage', usage };
}

// ===========================================================================
// Porta de entrada
// ===========================================================================

export async function* streamChat(
  prompt: Prompt,
  opts: { signal?: AbortSignal; maxTokens?: number; tools?: Tool[] } = {},
): AsyncGenerator<StreamEvent, void, void> {
  const p = provider();
  if (!hasKey(p)) {
    const nome = p === 'anthropic' ? 'da Anthropic' : 'do OpenRouter';
    throw new LlmError(
      `A chave ${nome} ainda nao foi configurada. Abra "Configuracao" no menu lateral e cole a chave.`,
    );
  }

  const args = { signal: opts.signal, maxTokens: opts.maxTokens ?? 4096 };
  const tools = opts.tools ?? [];

  yield* p === 'anthropic'
    ? anthropicStream(prompt, tools, args)
    : openrouterStream(prompt, tools, args);
}

/** Uma chamada curta e sem streaming — usada para dar titulo a conversa. */
export async function complete(systemText: string, userText: string, maxTokens = 64): Promise<string> {
  const p = provider();
  if (!hasKey(p)) throw new LlmError('Sem chave configurada.');

  if (p === 'anthropic') {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey('anthropic'),
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: activeModel(),
        max_tokens: maxTokens,
        system: systemText,
        messages: [{ role: 'user', content: userText }],
      }),
    });
    if (!res.ok) throw new LlmError(friendlyError(res.status, ''), res.status);
    const json = await res.json();
    return String(json?.content?.find((b: any) => b.type === 'text')?.text ?? '').trim();
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey('openrouter')}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.publicUrl,
      'X-Title': config.siteName,
    },
    body: JSON.stringify({
      model: activeModel(),
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: userText },
      ],
    }),
  });
  if (!res.ok) throw new LlmError(friendlyError(res.status, ''), res.status);
  const json = await res.json();
  return String(json?.choices?.[0]?.message?.content ?? '').trim();
}

/** Lista os modelos do provedor ativo, para a tela de configuracao. */
export async function listModels(): Promise<{ id: string; name: string }[]> {
  const p = provider();

  if (p === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': apiKey('anthropic'), 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new LlmError(friendlyError(res.status, ''), res.status);
    const json = await res.json();
    return (json?.data ?? []).map((m: any) => ({ id: m.id, name: m.display_name ?? m.id }));
  }

  const res = await fetch('https://openrouter.ai/api/v1/models', {
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new LlmError(`OpenRouter ${res.status}`, res.status);
  const json = await res.json();
  return (json?.data ?? [])
    .filter((m: any) => typeof m.id === 'string' && !m.id.endsWith(':batch'))
    .map((m: any) => ({ id: m.id, name: m.name ?? m.id }))
    .sort((a: any, b: any) => a.id.localeCompare(b.id));
}
