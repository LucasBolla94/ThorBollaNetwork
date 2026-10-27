// =========================================================================
// Captura do microfone, dentro do thread de audio.
//
// Isto roda num AudioWorklet, nao na pagina. A diferenca importa: o thread de
// audio nunca e interrompido por renderizacao, animacao ou coleta de lixo.
// Capturar na pagina (com ScriptProcessor, o jeito antigo) deixa cair pedacos
// de som exatamente quando a tela esta ocupada — e numa conversa, cada pedaco
// perdido e uma silaba comida.
//
// Sai PCM de 16 bits, mono, na taxa do contexto — que quem cria ja pediu como
// 16 kHz, a unica que o Whisper aceita. Converter aqui, e nao no servidor,
// corta a banda em quatro: float32 a 48 kHz sao 192 KB/s; int16 a 16 kHz sao
// 32 KB/s, menos que uma ligacao telefonica.
// =========================================================================

// 1024 amostras a 16 kHz = 64 ms por pedaco.
//
// O tamanho e um equilibrio: pedaco grande manda menos mensagem, mas atrasa a
// deteccao do fim do turno pelo mesmo tanto, porque o silencio so e percebido
// quando o pedaco chega. 64 ms some dentro dos 520 ms de espera de silencio e
// ainda da 16 envios por segundo, que e nada.
const PEDACO = 1024;

class Captura extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(PEDACO);
    this.usado = 0;
    this.ligado = true;
    this.port.onmessage = (e) => {
      if (e.data === 'parar') this.ligado = false;
    };
  }

  process(entradas) {
    if (!this.ligado) return false;

    const canal = entradas[0]?.[0];
    if (!canal) return true;

    for (let i = 0; i < canal.length; i++) {
      // Trava em -1..1 antes de converter: amostra fora da faixa viraria
      // estalo ao estourar o inteiro de 16 bits.
      const v = canal[i] < -1 ? -1 : canal[i] > 1 ? 1 : canal[i];
      this.buffer[this.usado++] = v < 0 ? v * 0x8000 : v * 0x7fff;

      if (this.usado === PEDACO) {
        // Manda uma copia: o buffer continua sendo escrito no proximo ciclo.
        const copia = this.buffer.slice(0);
        this.port.postMessage(copia.buffer, [copia.buffer]);
        this.usado = 0;
      }
    }
    return true;
  }
}

registerProcessor('captura', Captura);
