import { config } from './config.ts';

// ===========================================================================
// Busca por sentido.
//
// O embed transforma uma frase num vetor de numeros que representa o que ela
// QUER DIZER. Frases parecidas em sentido ficam com vetores proximos, mesmo
// sem nenhuma palavra em comum — e e exatamente ai que a busca por palavra do
// SQLite falha: "nao gosto de texto longo" nunca acharia "prefere mensagens
// curtas".
//
// Quem calcula e um servico Python separado (ferramentas/embed/servidor.py).
// A separacao e deliberada: um modelo que trava nao pode levar o agente junto.
//
// **Tudo aqui falha para o lado macio.** Se o servico estiver fora do ar, as
// funcoes devolvem vazio e quem chama segue com a busca por palavra. Memoria
// um pouco pior e muito melhor que conversa que nao responde.
// ===========================================================================

const ENDERECO = process.env.THOR_EMBED_URL ?? 'http://127.0.0.1:8799';
const TEMPO_LIMITE = 8000;

let vivoAte = 0;
let vivo = false;

/** Diz se o servico respondeu. A resposta vale 30s, para nao perguntar sempre. */
export async function embedDisponivel(): Promise<boolean> {
  if (Date.now() < vivoAte) return vivo;
  try {
    const r = await fetch(`${ENDERECO}/saude`, { signal: AbortSignal.timeout(2000) });
    vivo = r.ok;
  } catch {
    vivo = false;
  }
  vivoAte = Date.now() + 30_000;
  return vivo;
}

/** Vetores para varios textos de uma vez. Vazio se o servico nao responder. */
export async function vetorizar(textos: string[]): Promise<Float32Array[]> {
  const limpos = textos.map((t) => t.trim()).filter(Boolean);
  if (limpos.length === 0) return [];

  try {
    const r = await fetch(`${ENDERECO}/vetor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ textos: limpos }),
      signal: AbortSignal.timeout(TEMPO_LIMITE),
    });
    if (!r.ok) return [];
    const dados = (await r.json()) as { vetores: number[][] };
    return (dados.vetores ?? []).map((v) => Float32Array.from(v));
  } catch {
    // Silencio proposital: isto roda em caminho quente e o barulho de um
    // servico fora do ar nao ajuda ninguem a consertar nada.
    return [];
  }
}

export async function vetorizarUm(texto: string): Promise<Float32Array | null> {
  const [v] = await vetorizar([texto]);
  return v ?? null;
}

// ------------------------------------------------------------------ bytes

/**
 * O vetor vai para o SQLite como BLOB.
 *
 * Nao e elegancia, e economia: 768 numeros como texto JSON ocupam ~9 KB por
 * memoria; como float32 cru, 3 KB. Com milhares de memorias a diferenca passa
 * a aparecer no tempo de leitura do banco.
 */
export const paraBytes = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

export const deBytes = (b: Buffer | Uint8Array): Float32Array =>
  new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));

/**
 * Proximidade entre dois vetores, de -1 a 1.
 *
 * Os vetores que o modelo devolve ja vem normalizados, entao o produto escalar
 * bastaria. A divisao pelas normas fica porque custa quase nada e protege de
 * um dia o modelo mudar esse detalhe sem avisar.
 */
export function proximidade(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let escalar = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    escalar += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return escalar / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Abaixo disto, "parecido" deixa de significar alguma coisa.
 *
 * Medido neste servidor (ferramentas/medir-embed.py): pares que dizem a mesma
 * coisa com outras palavras ficaram em 0,35 ou mais; pares sem relacao
 * nenhuma, em 0,07 ou menos. 0,30 fica dentro dessa folga, do lado seguro.
 */
export const PROXIMO = Number(process.env.THOR_EMBED_LIMIAR ?? 0.3);

export const enderecoEmbed = ENDERECO;
export const raizDados = config.dataDir;
