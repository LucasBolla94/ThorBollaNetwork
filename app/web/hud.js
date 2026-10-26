// =========================================================================
// O reator — o instrumento central do Thor.
//
// A regra que manda aqui vem do desenho das HUDs do Homem de Ferro: o diretor
// perguntava para que servia cada elemento na tela, e o que nao tinha funcao
// saia. Entao aqui **nenhum anel e enfeite**:
//
//   anel externo com marcacoes  -> quantos pensamentos ele tem guardados
//   arco medidor                -> quanto do prompt veio do cache (economia)
//   anel segmentado             -> gira no ritmo do estado; os segmentos acesos
//                                  sao as voltas de ferramenta do turno
//   raios internos              -> energia: pulsam no ritmo da fala
//   nucleo                      -> o estado, pela cor
//
// Quem olhar e entender uma coisa so ja tirou informacao real da tela.
// =========================================================================

const PALETA = {
  dormindo: { tom: [95, 227, 255], frio: [34, 211, 238], rotulo: 'EM ESPERA' },
  ouvindo: { tom: [125, 240, 255], frio: [34, 211, 238], rotulo: 'OUVINDO' },
  pensando: { tom: [160, 245, 255], frio: [99, 230, 255], rotulo: 'PROCESSANDO' },
  falando: { tom: [110, 235, 255], frio: [56, 220, 245], rotulo: 'RESPONDENDO' },
  erro: { tom: [255, 160, 90], frio: [255, 120, 80], rotulo: 'FALHA' },
};

const VEL = { dormindo: 0.055, ouvindo: 0.16, pensando: 0.62, falando: 0.3, erro: 0.1 };
const PISO = { dormindo: 0.1, ouvindo: 0.3, pensando: 0.52, falando: 0.38, erro: 0.3 };

const instancias = new Set();
let rodando = false;
let anterior = 0;

const rgba = ([r, g, b], a) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
const entre = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

function laco(agora) {
  const dt = Math.min(0.05, (agora - anterior) / 1000 || 0.016);
  anterior = agora;
  for (const n of instancias) n.quadro(dt, agora / 1000);
  if (instancias.size) requestAnimationFrame(laco);
  else rodando = false;
}

function ligar() {
  if (rodando) return;
  rodando = true;
  anterior = performance.now();
  requestAnimationFrame(laco);
}

/**
 * @param hospedeiro elemento que define o tamanho
 * @param dados      funcao que devolve os numeros reais a desenhar
 */
export function criarReator(hospedeiro, dados = () => ({})) {
  const canvas = document.createElement('canvas');
  canvas.className = 'reator-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  hospedeiro.append(canvas);
  const ctx = canvas.getContext('2d');

  const parado = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let L = 1;
  let energia = 0;
  let nome = 'dormindo';
  let cor = [...PALETA.dormindo.tom];
  let giro = 0;
  let giro2 = 0;
  let varredura = 0;

  function medir() {
    const r = hospedeiro.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    L = Math.max(1, Math.min(r.width, r.height));
    canvas.width = L * dpr;
    canvas.height = L * dpr;
    canvas.style.width = `${L}px`;
    canvas.style.height = `${L}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const ro = new ResizeObserver(medir);
  ro.observe(hospedeiro);
  medir();

  /** Anel de marcacoes. As longas a cada 5, como em instrumento de verdade. */
  function anelMarcas(c, raio, qtd, rot, alpha, escala) {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(rot);
    for (let i = 0; i < qtd; i++) {
      const grande = i % 5 === 0;
      const comp = raio * (grande ? 0.085 : 0.045) * escala;
      const a = (i / qtd) * TAU;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * raio, Math.sin(a) * raio);
      ctx.lineTo(Math.cos(a) * (raio - comp), Math.sin(a) * (raio - comp));
      ctx.strokeStyle = rgba(cor, alpha * (grande ? 1 : 0.45));
      ctx.lineWidth = grande ? 1.1 : 0.7;
      ctx.stroke();
    }
    ctx.restore();
  }

  function arco(c, raio, de, ate, largura, alpha, tracejado) {
    ctx.beginPath();
    ctx.arc(c, c, raio, de, ate);
    ctx.strokeStyle = rgba(cor, alpha);
    ctx.lineWidth = largura;
    if (tracejado) ctx.setLineDash(tracejado);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function desenhar(t) {
    const c = L / 2;
    const R = c * 0.94;
    const e = energia;
    const d = dados() ?? {};

    ctx.clearRect(0, 0, L, L);
    ctx.lineCap = 'butt';

    // ---- halo ----
    const halo = ctx.createRadialGradient(c, c, R * 0.1, c, c, R);
    halo.addColorStop(0, rgba(cor, 0.16 + e * 0.2));
    halo.addColorStop(0.6, rgba(cor, 0.04 + e * 0.05));
    halo.addColorStop(1, rgba(cor, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, L, L);

    // ---- 1. anel externo: quantidade de memoria ----
    // 60 marcacoes; as acesas sao a proporcao de pensamentos guardados.
    const memoria = Math.max(0, Math.min(1, (d.pensamentos ?? 0) / 60));
    anelMarcas(c, R, 60, giro * 0.12, 0.22 + e * 0.12, 1);
    if (memoria > 0) {
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(giro * 0.12);
      const n = Math.max(1, Math.round(memoria * 60));
      for (let i = 0; i < n; i++) {
        const grande = i % 5 === 0;
        const comp = R * (grande ? 0.085 : 0.045);
        const a = (i / 60) * TAU;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R);
        ctx.lineTo(Math.cos(a) * (R - comp), Math.sin(a) * (R - comp));
        ctx.strokeStyle = rgba(cor, 0.85);
        ctx.lineWidth = grande ? 1.4 : 0.9;
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- 2. arco medidor: cache aproveitado ----
    const cache = Math.max(0, Math.min(1, d.cache ?? 0));
    arco(c, R * 0.86, -Math.PI * 0.75, Math.PI * 0.75, 1, 0.12);
    if (cache > 0) {
      arco(c, R * 0.86, -Math.PI * 0.75, -Math.PI * 0.75 + Math.PI * 1.5 * cache, 2.4, 0.9);
    }

    // ---- 3. anel segmentado: gira pelo estado, acende pelas voltas ----
    const voltas = Math.max(0, Math.min(4, d.voltas ?? 0));
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(-giro2);
    for (let i = 0; i < 12; i++) {
      const a0 = (i / 12) * TAU + 0.04;
      const a1 = ((i + 1) / 12) * TAU - 0.04;
      const aceso = i < voltas * 3;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.7, a0, a1);
      ctx.strokeStyle = rgba(cor, aceso ? 0.75 : 0.14 + e * 0.1);
      ctx.lineWidth = aceso ? 3 : 1.6;
      ctx.stroke();
    }
    ctx.restore();

    // ---- 4. raios internos: a energia ----
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(giro * 0.4);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const r0 = R * 0.3;
      const r1 = R * (0.42 + e * 0.16);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.strokeStyle = rgba(cor, 0.2 + e * 0.6);
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();

    // anel fino interno
    arco(c, R * 0.52, 0, TAU, 1, 0.3 + e * 0.3);
    arco(c, R * 0.6, -0.6, 1.1, 1.6, 0.5 + e * 0.3);
    arco(c, R * 0.6, Math.PI - 0.6, Math.PI + 1.1, 1.6, 0.5 + e * 0.3);

    // ---- 5. nucleo ----
    const raioN = R * (0.2 + e * 0.05);
    const gn = ctx.createRadialGradient(c, c, 0, c, c, raioN * 2.2);
    gn.addColorStop(0, rgba([255, 255, 255], 0.95));
    gn.addColorStop(0.3, rgba(cor, 0.9));
    gn.addColorStop(1, rgba(cor, 0));
    ctx.fillStyle = gn;
    ctx.beginPath();
    ctx.arc(c, c, raioN * 2.2, 0, TAU);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(c, c, raioN * 0.5, 0, TAU);
    ctx.fillStyle = rgba([255, 255, 255], 0.75 + e * 0.25);
    ctx.fill();

    // ---- 6. varredura: linha que roda, como radar ----
    if (nome === 'pensando' || nome === 'ouvindo') {
      const g = ctx.createLinearGradient(
        c,
        c,
        c + Math.cos(varredura) * R,
        c + Math.sin(varredura) * R,
      );
      g.addColorStop(0, rgba(cor, 0));
      g.addColorStop(1, rgba(cor, 0.5));
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(c + Math.cos(varredura) * R * 0.92, c + Math.sin(varredura) * R * 0.92);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }

  const reator = {
    quadro(dt, t) {
      const piso = PISO[nome] + Math.sin(t * 1.7) * 0.03;
      energia = Math.max(piso, Math.min(1, energia - dt * 1.7));
      const alvo = PALETA[nome].tom;
      for (let i = 0; i < 3; i++) cor[i] = entre(cor[i], alvo[i], dt * 4);
      giro += dt * (0.2 + VEL[nome] + energia * 0.4);
      giro2 += dt * (0.12 + VEL[nome] * 0.7);
      varredura += dt * 2.4;
      desenhar(t);
    },
    pulsar(f = 0.3) {
      energia = Math.min(1, energia + f);
    },
    estado(n) {
      if (PALETA[n]) nome = n;
    },
    rotulo: () => PALETA[nome].rotulo,
    destruir() {
      instancias.delete(reator);
      ro.disconnect();
      canvas.remove();
    },
  };

  if (parado) {
    energia = 0.5;
    desenhar(0);
  } else {
    instancias.add(reator);
    ligar();
  }
  return reator;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && instancias.size) ligar();
});
