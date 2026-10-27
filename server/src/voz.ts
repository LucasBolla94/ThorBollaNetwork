import { config } from './config.ts';
import { getSetting } from './db.ts';
import { MARCAS } from './memory.ts';

// ===========================================================================
// Ouvir e falar.
//
// Quem faz o trabalho e um servico Python separado (ferramentas/voz/servidor.py).
// A separacao e a mesma do embed e pela mesma razao: um modelo que trava nao
// pode levar o agente junto.
//
// **Tudo aqui falha para o lado macio.** Servico fora do ar devolve vazio, e
// quem chama segue com a conversa por texto. Conversa sem voz e muito melhor
// que conversa que nao responde.
// ===========================================================================

const ENDERECO = process.env.THOR_VOZ_URL ?? 'http://127.0.0.1:8798';
const TEMPO_ESCUTA = 6000;
const TEMPO_FALA = 15000;
// Transcrever fora e rapido (uns 300 ms), mas passa pela internet. Oito
// segundos e paciencia de sobra; alem disso, a conversa ja morreu e insistir
// so faz a pessoa esperar por nada.
const TEMPO_NUVEM = 8000;

let vivoAte = 0;
let vivo = false;
let temFala = false;
let naNuvem = false;
let taxaFala = 22050;

export type EstadoEscuta = {
  falando: boolean;
  parou: boolean;
  texto: string;
  segundos?: number;
  /** No modo nuvem vem o audio do turno, em base64, em vez do texto. */
  wav?: string;
};

// ------------------------------------------------------- transcrever fora

/**
 * Entender fala fora da maquina.
 *
 * **Por que existe.** Medido neste servidor com as 300 frases que o Lucas
 * gravou: o modelo `small` leva 5,6 segundos para entender uma frase de
 * quatro. O gargalo e o processador — um Xeon de 2013 sem AVX2, a instrucao
 * de que o motor do Whisper mais depende. Quantizar diferente nao muda (int8,
 * int16 e float32 ficaram todos no mesmo lugar). Modelo menor fica rapido e
 * passa a errar uma palavra em cinco. A conta esta em
 * `ferramentas/medir-escuta-fundo.py`.
 *
 * **O que sai da maquina.** O audio do que ele falou. O texto dessa mesma
 * conversa ja vai para a LLM na nuvem de qualquer forma, entao o conteudo ja
 * saia — o que passa a sair e a gravacao. O que nunca sai e o modelo da voz
 * dele, que e o que permitiria clonagem: falar continua inteiramente aqui.
 */
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODELO_NUVEM = process.env.THOR_VOZ_MODELO_NUVEM ?? 'whisper-large-v3-turbo';

export const chaveDaEscuta = (): string =>
  getSetting('groq_key') || config.groqKey;

export const podeEscutarNaNuvem = (): boolean => chaveDaEscuta().length > 0;

export async function transcreverNaNuvem(wav: Buffer): Promise<string | null> {
  const chave = chaveDaEscuta();
  if (!chave) return null;
  try {
    const corpo = new FormData();
    corpo.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'turno.wav');
    corpo.append('model', MODELO_NUVEM);
    // Dizer que e portugues importa: sem isto ele adivinha pelo audio e as
    // vezes decide que uma frase curta e espanhol, que e o erro mais comum
    // em frases de duas palavras.
    corpo.append('language', 'pt');
    corpo.append('response_format', 'json');
    // Temperatura zero: numa conversa, inventar e pior que recusar.
    corpo.append('temperature', '0');

    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${chave}` },
      body: corpo,
      signal: AbortSignal.timeout(TEMPO_NUVEM),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { text?: string };
    return (d.text ?? '').trim();
  } catch {
    return null;
  }
}

/** Diz se o servico respondeu. A resposta vale 30s, para nao perguntar sempre. */
export async function vozDisponivel(): Promise<boolean> {
  if (Date.now() < vivoAte) return vivo;
  try {
    const r = await fetch(`${ENDERECO}/saude`, { signal: AbortSignal.timeout(2000) });
    vivo = r.ok;
    if (r.ok) {
      const s = (await r.json()) as {
        fala?: boolean;
        taxa_fala?: number;
        na_nuvem?: boolean;
      };
      temFala = s.fala === true;
      naNuvem = s.na_nuvem === true;
      taxaFala = Number(s.taxa_fala) || 22050;
    }
  } catch {
    vivo = false;
  }
  vivoAte = Date.now() + 30_000;
  return vivo;
}

/** Ele sabe falar, ou so ouvir? Falso ate a primeira conferencia de saude. */
export const sabeFalar = (): boolean => temFala;
export const taxaDaFala = (): number => taxaFala;

/**
 * Ele consegue ouvir de verdade?
 *
 * Duas pecas tem de combinar: o servico de voz esta no ar, e quem transcreve
 * esta alcancavel. No modo nuvem isso exige uma chave — sem ela, o microfone
 * captaria audio que nunca viraria texto, e o botao ficaria la prometendo uma
 * conversa que nao acontece. Melhor nao mostrar o botao.
 */
export const sabeOuvir = (): boolean => vivo && (!naNuvem || podeEscutarNaNuvem());

/** Onde a fala e entendida: aqui ou fora. So para dizer a verdade na tela. */
export const escutaNaNuvem = (): boolean => naNuvem;

// ------------------------------------------------------------------ ouvir

/**
 * Entrega um pedaco de audio e recebe o estado do turno.
 *
 * O audio tem de ser PCM 16 kHz, 16 bits, mono, cru — e o que o navegador
 * manda e o que o Whisper quer, sem conversao no meio.
 */
export async function ouvir(sessao: string, pcm: Buffer): Promise<EstadoEscuta | null> {
  try {
    const r = await fetch(`${ENDERECO}/ouvir/${encodeURIComponent(sessao)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(pcm),
      signal: AbortSignal.timeout(TEMPO_ESCUTA),
    });
    if (!r.ok) return null;
    return (await r.json()) as EstadoEscuta;
  } catch {
    return null;
  }
}

/** Fecha o turno na forca: quem esta do outro lado soltou o botao. */
export async function fecharEscuta(sessao: string): Promise<EstadoEscuta | null> {
  try {
    const r = await fetch(`${ENDERECO}/ouvir/${encodeURIComponent(sessao)}/fim`, {
      method: 'POST',
      signal: AbortSignal.timeout(TEMPO_ESCUTA),
    });
    if (!r.ok) return null;
    return (await r.json()) as EstadoEscuta;
  } catch {
    return null;
  }
}

/** Esquece a sessao. O servico tambem limpa sozinho, isto so adianta. */
export function descartarEscuta(sessao: string): void {
  void fetch(`${ENDERECO}/ouvir/${encodeURIComponent(sessao)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}

// ------------------------------------------------------------------ falar

/** Transforma texto em audio. Devolve PCM cru, ou null se nao der. */
export async function falar(texto: string): Promise<Buffer | null> {
  const limpo = texto.trim();
  if (!limpo) return null;
  try {
    const r = await fetch(`${ENDERECO}/falar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: limpo }),
      signal: AbortSignal.timeout(TEMPO_FALA),
    });
    if (!r.ok) return null;
    const taxa = Number(r.headers.get('X-Taxa'));
    if (taxa) taxaFala = taxa;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

// ------------------------------------------------------- fatiar para falar

/**
 * Corta o texto que esta saindo em pedacos que valem a pena falar.
 *
 * **O problema que isto resolve.** Esperar a resposta inteira para comecar a
 * falar poe uns tres segundos de silencio no meio da conversa. Falar palavra
 * por palavra, do outro lado, sai robotico e entoado errado — a entoacao de
 * uma frase depende de onde ela termina.
 *
 * Entao: corta na pontuacao, que e onde a voz naturalmente pausa.
 *
 * **O primeiro pedaco e tratado diferente de proposito.** E ele que define a
 * demora que a pessoa sente; os seguintes ja tocam enquanto ele fala, e
 * ninguem percebe. Por isso o primeiro aceita cortar numa virgula ou em dois
 * pontos, e os demais esperam ponto final.
 */
const FIM_DE_FRASE = /[.!?](?=\s|$)|[\n\r]|[:;](?=\s)/g;
const FIM_FRACO = /[,](?=\s)/g;

// O primeiro pedaco pode ser curto porque e ele que define a demora que a
// pessoa sente. "Bom dia, Lucas." sao 15 caracteres e e uma fala inteira e
// natural; exigir 40 obrigaria a esperar a frase seguinte para comecar.
const MINIMO_PRIMEIRO = 14;
const MINIMO_DEMAIS = 40;
const TETO = 320;

/**
 * Nao cortar aqui: ponto que nao termina frase.
 *
 * Numero decimal ("3.5"), abreviacao ("Sr."), sigla pontuada ("E.U.A.") e
 * reticencia. Cada um destes, cortado, geraria um pedaco de uma palavra e uma
 * entoacao de fim de frase no meio da ideia.
 */
function fimDeVerdade(texto: string, i: number): boolean {
  const c = texto[i];
  if (c !== '.') return true;
  if (/[0-9]/.test(texto[i - 1] ?? '') && /[0-9]/.test(texto[i + 1] ?? '')) return false;
  // Ponto depois de digito, no fim do que chegou ate agora: pode ser um
  // decimal pela metade — "3." um instante antes de virar "3.5". Esperar o
  // proximo pedaco custa um piscar; falar "tres ponto" e "cinco" em frases
  // separadas sai errado e nao se desfaz. No fim do turno quem fecha e
  // `soltarFala(true)`, que nao passa por aqui, entao nada se perde.
  if (i === texto.length - 1 && /[0-9]/.test(texto[i - 1] ?? '')) return false;
  if (texto[i + 1] === '.' || texto[i - 1] === '.') return false;
  // Uma letra sozinha antes do ponto e sigla ou inicial, nao fim de frase.
  if (/[A-Za-z]/.test(texto[i - 1] ?? '') && !/[A-Za-z]/.test(texto[i - 2] ?? '')) return false;
  const antes = texto.slice(Math.max(0, i - 4), i).toLowerCase();
  if (/\b(sr|sra|dr|dra|etc|ex|prof|núm|num)$/.test(antes)) return false;
  return true;
}

/**
 * Procura, no acumulado, o maior pedaco que ja da para falar.
 *
 * Devolve quantos caracteres consumir, ou 0 se ainda nao vale. Quem chama
 * passa `primeiro` na primeira vez do turno.
 */
export function pedacoFalavel(acumulado: string, primeiro: boolean): number {
  const minimo = primeiro ? MINIMO_PRIMEIRO : MINIMO_DEMAIS;
  if (acumulado.trim().length < minimo) return 0;

  // **O primeiro pedaco para no PRIMEIRO corte valido; os seguintes pegam o
  // ULTIMO.** Nao e capricho, sao dois objetivos diferentes:
  //
  //   o primeiro   define a demora que a pessoa sente. Cortar cedo e falar
  //                antes vale mais que qualquer ganho de entoacao.
  //   os seguintes tocam enquanto ele ja esta falando, e a demora deles nao
  //                aparece. Ai o que importa e a entoacao, que fica melhor
  //                num trecho mais longo — e cada pedaco e uma ida ao
  //                servico de voz, entao menos pedacos tambem e menos
  //                chance de a fila secar e abrir um buraco no meio da fala.
  let corte = 0;
  for (const m of acumulado.matchAll(FIM_DE_FRASE)) {
    const i = m.index ?? 0;
    if (!fimDeVerdade(acumulado, i)) continue;
    if (i + 1 < minimo) continue;
    corte = i + 1;
    if (primeiro) break;
  }
  if (corte) return corte;

  // Sem ponto final ainda. No primeiro pedaco, uma virgula serve — vale mais
  // comecar a falar que esperar a frase fechar.
  if (primeiro) {
    for (const m of acumulado.matchAll(FIM_FRACO)) {
      const i = m.index ?? 0;
      if (i + 1 >= minimo) return i + 1;
    }
  }

  // Texto comprido sem pontuacao nenhuma: corta no ultimo espaco, porque
  // deixar crescer sem limite e o mesmo que nao falar.
  if (acumulado.length > TETO) {
    const espaco = acumulado.lastIndexOf(' ', TETO);
    if (espaco > minimo) return espaco + 1;
  }
  return 0;
}

// ------------------------------------------------------- marcas de memoria

const ABRE_MARCA = new RegExp(`<(${MARCAS.join('|')})\\b`, 'i');
const MARCA_INTEIRA = new RegExp(`<(${MARCAS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`, 'gi');

/**
 * Ate onde da para falar sem ler uma marca de memoria pela metade.
 *
 * **O problema.** O modelo escreve `<lembrar>...</lembrar>` no meio da
 * resposta, e isso e removido antes de o texto ir para a tela. Mas a fala sai
 * enquanto ele escreve, e nesse instante a marca pode estar aberta e nao
 * fechada. Falar o que vem depois de uma marca aberta leria a marca em voz
 * alta — "menor que lembrar maior que" — e isso nao se desfaz.
 *
 * Devolve quantos caracteres do inicio sao seguros. Marca ja fechada nao
 * atrapalha e fica dentro do limite: ela e removida na hora de sintetizar, e
 * contar sobre o texto cru e o que mantem a conta de "o que ja falei" certa.
 */
export function limiteSeguro(cru: string): number {
  let i = 0;
  for (;;) {
    const m = ABRE_MARCA.exec(cru.slice(i));
    if (!m) break;
    const inicio = i + (m.index ?? 0);
    const fecha = `</${m[1].toLowerCase()}>`;
    const fim = cru.toLowerCase().indexOf(fecha, inicio);
    if (fim < 0) return inicio; // ainda esta abrindo: para antes dela
    i = fim + fecha.length;
  }
  // Um "<" solto no fim do que chegou pode ser o comeco de uma marca que o
  // proximo pedaco vai completar. Segurar e barato; falar errado, nao.
  const solto = cru.lastIndexOf('<');
  if (solto >= 0 && /^<[a-z/]*$/i.test(cru.slice(solto))) return solto;
  return cru.length;
}

/**
 * Tira as marcas ja fechadas. O que sobra e o que se le em voz alta.
 *
 * Junta os espacos que a remocao deixa: "Certo.   Agora" viraria uma pausa
 * estranha no meio da fala, e o custo de evitar isso e uma expressao.
 */
export const semMarcas = (texto: string): string =>
  texto.replace(MARCA_INTEIRA, ' ').replace(/[^\S\n]{2,}/g, ' ');

// --------------------------------------------------------------- quadros

/**
 * Formato do quadro binario que vai para o navegador.
 *
 * Carrega o proprio cabecalho em vez de depender de um JSON mandado antes: uma
 * mensagem perdida ou fora de ordem nao desalinha a fila de audio. Nove bytes
 * de cabecalho sao um preco irrisorio por isso.
 *
 *   byte 0      tipo (1 = audio de fala)
 *   bytes 1..4  sequencia, para tocar na ordem certa
 *   bytes 5..8  taxa de amostragem
 *   resto       PCM 16 bits little-endian
 */
export const QUADRO_AUDIO = 1;

export function quadroDeAudio(seq: number, taxa: number, pcm: Buffer): Buffer {
  const cabeca = Buffer.alloc(9);
  cabeca.writeUInt8(QUADRO_AUDIO, 0);
  cabeca.writeUInt32LE(seq >>> 0, 1);
  cabeca.writeUInt32LE(taxa >>> 0, 5);
  return Buffer.concat([cabeca, pcm]);
}

export const enderecoVoz = ENDERECO;
