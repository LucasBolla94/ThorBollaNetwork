// =========================================================================
// Voz, no navegador: pega o microfone e toca o que ele responde.
//
// Dois contextos de audio separados, de proposito:
//
//   captura   criado em 16 kHz. O navegador reamostra na entrada, com
//             qualidade melhor que qualquer conta que eu escrevesse aqui, e o
//             Whisper so trabalha nessa taxa.
//   saida     na taxa que o aparelho preferir. A voz sai em 22,05 kHz e quem
//             converte e o navegador, tocando o buffer na taxa dele.
//
// Juntar os dois num contexto so forcaria reamostrar a voz na mao, com piora
// audivel e nenhum ganho.
// =========================================================================

// Quanta folga dar antes de o primeiro pedaco de audio tocar.
//
// O audio chega em pedacos pela rede e cada um e agendado logo depois do
// anterior. Sem folga, um pedaco que atrase um piscar de olhos chega depois do
// horario dele e abre um buraco audivel. 120 ms some na percepcao e absorve a
// variacao normal de rede local.
const FOLGA = 0.12;

// Nao agendar nada para menos que isto a frente do relogio: o navegador trata
// um horario ja passado como "agora", o que emenda dois pedacos em cima um do
// outro em vez de em sequencia.
const JA_PASSOU = 0.01;

export function criarVoz({ aoPedaco, aoEstado }) {
  let captura = null;      // AudioContext de entrada
  let saida = null;        // AudioContext de saida
  let fluxo = null;        // MediaStream do microfone
  let no = null;           // AudioWorkletNode
  let ligada = false;

  let proximoInicio = 0;
  let tocando = [];

  const estado = (nome, extra) => aoEstado?.(nome, extra);

  // --------------------------------------------------------------- ouvir

  async function ligar() {
    if (ligada) return true;
    try {
      // echoCancellation e o que impede o microfone de ouvir a propria voz
      // dele pelo alto-falante e tratar isso como voce falando. Sem isto, ele
      // se interrompe sozinho — e num aparelho sem fone fica inusavel.
      fluxo = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      estado('negado', { erro: String(e?.name || e) });
      return false;
    }

    try {
      captura = new AudioContext({ sampleRate: 16000 });
      // No iPhone o contexto nasce suspenso e so acorda dentro de um gesto da
      // pessoa. Quem chama isto esta num clique, entao aqui funciona.
      if (captura.state === 'suspended') await captura.resume();
      await captura.audioWorklet.addModule('/voz-captura.js');

      const origem = captura.createMediaStreamSource(fluxo);
      no = new AudioWorkletNode(captura, 'captura');
      no.port.onmessage = (e) => aoPedaco?.(e.data);
      origem.connect(no);
      // O worklet nao produz som, mas em alguns navegadores um no desconectado
      // da saida nao recebe ciclo de processamento. Um ganho zerado resolve
      // sem fazer barulho.
      const mudo = captura.createGain();
      mudo.gain.value = 0;
      no.connect(mudo).connect(captura.destination);
    } catch (e) {
      await desligar();
      estado('erro', { erro: String(e?.message || e) });
      return false;
    }

    ligada = true;
    estado('ouvindo');
    return true;
  }

  async function desligar() {
    ligada = false;
    try {
      no?.port.postMessage('parar');
      no?.disconnect();
    } catch {
      /* ja estava fora */
    }
    for (const t of fluxo?.getTracks() ?? []) t.stop();
    try {
      await captura?.close();
    } catch {
      /* idem */
    }
    no = null;
    fluxo = null;
    captura = null;
    pararDeTocar();
    estado('desligada');
  }

  // --------------------------------------------------------------- falar

  function contextoDeSaida() {
    if (!saida || saida.state === 'closed') saida = new AudioContext();
    if (saida.state === 'suspended') void saida.resume();
    return saida;
  }

  /** Recebe PCM de 16 bits e agenda para tocar logo depois do que ja esta na fila. */
  function tocar(pcm, taxa) {
    const ctx = contextoDeSaida();
    const amostras = new Int16Array(pcm);
    if (!amostras.length) return;

    const buffer = ctx.createBuffer(1, amostras.length, taxa);
    const canal = buffer.getChannelData(0);
    for (let i = 0; i < amostras.length; i++) canal[i] = amostras[i] / 32768;

    // Dois casos caem aqui: o primeiro pedaco de uma resposta, e o caso em
    // que a sintese ficou atras da reproducao e a fila secou. Nos dois, o
    // horario guardado ja passou e tentar emendar nele sobreporia audio.
    // Recomecar com folga custa 120 ms e evita a sobreposicao.
    const agora = ctx.currentTime;
    if (proximoInicio < agora + JA_PASSOU) proximoInicio = agora + FOLGA;

    const fonte = ctx.createBufferSource();
    fonte.buffer = buffer;
    fonte.connect(ctx.destination);
    fonte.start(proximoInicio);
    proximoInicio += buffer.duration;

    tocando.push(fonte);
    fonte.onended = () => {
      tocando = tocando.filter((f) => f !== fonte);
      if (!tocando.length) estado(ligada ? 'ouvindo' : 'parado');
    };
    estado('falando');
  }

  /** Cala a boca na hora: e isto que faz dar para interromper ele falando. */
  function pararDeTocar() {
    for (const f of tocando) {
      try {
        f.stop();
      } catch {
        /* ja terminou */
      }
    }
    tocando = [];
    proximoInicio = 0;
  }

  const estaTocando = () => tocando.length > 0;

  return { ligar, desligar, tocar, pararDeTocar, estaTocando, ligada: () => ligada };
}
