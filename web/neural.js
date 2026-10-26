// =========================================================================
// A rede neural do Thor.
//
// Nao e enfeite: cada no e um pensamento que ele guardou de verdade, e cada
// aresta e uma ligacao que ele afirmou. Rede vazia significa memoria vazia.
//
// Quando ele busca na memoria, sinais viajam pelas arestas — da para ver o
// pensamento atravessando a teia.
// =========================================================================

// Tudo dentro da familia do HUD: ciano como base, ambar para o que e humano
// ou decidido. Sem roxo — ele puxava a tela para outro genero.
const CORES = {
  fato: [95, 227, 255],
  preferencia: [160, 245, 255],
  projeto: [110, 240, 215],
  pessoa: [255, 179, 71],
  decisao: [255, 214, 110],
};

const rgba = ([r, g, b], a) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

export function criarRede(hospedeiro, { densidade = 1 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'rede-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  hospedeiro.append(canvas);
  const ctx = canvas.getContext('2d');

  const semMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 1;
  let H = 1;
  let nos = [];
  let arestas = [];
  const sinais = [];
  let vivo = true;
  let t = 0;
  // Um painel escondido mede 0x0. Se os nos nascerem com esse tamanho, as
  // posicoes saem todas no canto e a teia aparece vazia quando o painel abre.
  // Entao guardamos se ja houve uma medida util e re-semeamos quando houver.
  let medidaBoa = false;

  function medir() {
    const r = hospedeiro.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, r.width);
    H = Math.max(1, r.height);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const agoraBoa = W > 40 && H > 40;
    if (agoraBoa && !medidaBoa) {
      medidaBoa = true;
      reposicionar();
    } else {
      for (const n of nos) {
        n.x = Math.min(Math.max(n.x, 12), W - 12);
        n.y = Math.min(Math.max(n.y, 12), H - 12);
      }
    }
  }

  /** Recoloca todos os nos a partir da semente, com o tamanho atual. */
  function reposicionar() {
    nos.forEach((n, i) => {
      const p = semente(n.id, i, nos.length);
      n.x = p.x;
      n.y = p.y;
      n.vx = 0;
      n.vy = 0;
    });
  }

  const ro = new ResizeObserver(medir);
  ro.observe(hospedeiro);
  medir();

  /**
   * Posicao inicial determinista a partir do id: a mesma memoria desenha no
   * mesmo lugar toda vez, entao da para reconhecer a forma da teia com o tempo.
   */
  function semente(id, i, total) {
    let h = 0;
    for (let k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) >>> 0;
    const ang = (i / Math.max(1, total)) * Math.PI * 2 + (h % 100) / 240;
    const raio = 0.22 + ((h >>> 8) % 100) / 290;
    return {
      x: W / 2 + Math.cos(ang) * raio * W * 0.78,
      y: H / 2 + Math.sin(ang) * raio * H * 0.78,
    };
  }

  function fantasmas() {
    // Teia vazia ainda precisa parecer viva, senao o painel parece quebrado.
    const n = Math.round(11 * densidade);
    nos = Array.from({ length: n }, (_, i) => {
      const p = semente(`vazio-${i}`, i, n);
      return {
        id: `vazio-${i}`,
        x: p.x,
        y: p.y,
        vx: 0,
        vy: 0,
        cor: [70, 120, 140],
        r: 1.8,
        fixo: false,
        fantasma: true,
      };
    });
    arestas = [];
    for (let i = 0; i < n; i++) arestas.push({ a: i, b: (i + 1) % n, tipo: 'vazio' });
  }

  fantasmas();

  function carregar(pensamentos, ligacoes) {
    const vivos = (pensamentos ?? []).filter((p) => !p.supersededBy).slice(0, 60);
    if (vivos.length === 0) {
      fantasmas();
      return;
    }

    const antes = new Map(nos.map((n) => [n.id, n]));
    nos = vivos.map((p, i) => {
      const velho = antes.get(p.id);
      const pos = velho ?? semente(p.id, i, vivos.length);
      return {
        id: p.id,
        x: pos.x,
        y: pos.y,
        vx: velho?.vx ?? 0,
        vy: velho?.vy ?? 0,
        cor: CORES[p.kind] ?? [95, 227, 255],
        r: p.pinned ? 3.6 : 2.4,
        fixo: Boolean(p.pinned),
        fantasma: false,
        nascido: t,
      };
    });

    if (!medidaBoa) {
      // Ainda invisivel: as posicoes sao provisorias e serao refeitas assim
      // que o elemento ganhar tamanho de verdade.
      medidaBoa = W > 40 && H > 40;
    }

    const ind = new Map(nos.map((n, i) => [n.id, i]));
    arestas = [];
    for (const l of ligacoes ?? []) {
      const a = ind.get(l.fromId);
      const b = ind.get(l.toId);
      if (a !== undefined && b !== undefined && a !== b) {
        arestas.push({ a, b, tipo: l.relation });
      }
    }

    // Sem nenhuma ligacao declarada, liga cada no ao mais proximo so para a
    // teia ter forma. Essas arestas sao desenhadas mais fracas de proposito:
    // elas nao sao conhecimento, sao enfeite.
    if (arestas.length === 0 && nos.length > 1) {
      for (let i = 0; i < nos.length; i++) {
        let melhor = -1;
        let dist = Infinity;
        for (let j = 0; j < nos.length; j++) {
          if (i === j) continue;
          const d = (nos[i].x - nos[j].x) ** 2 + (nos[i].y - nos[j].y) ** 2;
          if (d < dist) {
            dist = d;
            melhor = j;
          }
        }
        if (melhor >= 0) arestas.push({ a: i, b: melhor, tipo: 'perto' });
      }
    }
  }

  /** Dispara sinais viajando pelas arestas. */
  function sinal(quantos = 3) {
    if (!arestas.length) return;
    for (let i = 0; i < quantos; i++) {
      const e = arestas[(Math.random() * arestas.length) | 0];
      sinais.push({
        a: e.a,
        b: e.b,
        p: 0,
        vel: 0.5 + Math.random() * 0.8,
        cor: nos[e.b]?.cor ?? [95, 227, 255],
      });
    }
  }

  function passo(dt) {
    t += dt;

    for (const n of nos) {
      if (!n.fixo) {
        // Deriva lenta com um empurrao de volta ao centro: sem isso os nos
        // escapam da area e a teia esvazia.
        n.vx += (Math.sin(t * 0.3 + n.x * 0.01) * 0.5 + (W / 2 - n.x) * 0.0004) * dt * 60;
        n.vy += (Math.cos(t * 0.26 + n.y * 0.01) * 0.5 + (H / 2 - n.y) * 0.0004) * dt * 60;
      }
      n.vx *= 0.94;
      n.vy *= 0.94;
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      n.x = Math.min(Math.max(n.x, 10), W - 10);
      n.y = Math.min(Math.max(n.y, 10), H - 10);
    }

    for (let i = sinais.length - 1; i >= 0; i--) {
      sinais[i].p += sinais[i].vel * dt;
      if (sinais[i].p >= 1) sinais.splice(i, 1);
    }
  }

  function desenhar() {
    ctx.clearRect(0, 0, W, H);

    // arestas
    for (const e of arestas) {
      const a = nos[e.a];
      const b = nos[e.b];
      if (!a || !b) continue;
      const corrige = e.tipo === 'corrige';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = corrige
        ? 'rgba(255,179,71,0.4)'
        : e.tipo === 'perto' || e.tipo === 'vazio'
          ? 'rgba(95,227,255,0.14)'
          : 'rgba(95,227,255,0.34)';
      ctx.lineWidth = corrige ? 1.2 : 1;
      if (corrige) ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // sinais viajando
    for (const s of sinais) {
      const a = nos[s.a];
      const b = nos[s.b];
      if (!a || !b) continue;
      const x = a.x + (b.x - a.x) * s.p;
      const y = a.y + (b.y - a.y) * s.p;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 7);
      g.addColorStop(0, rgba(s.cor, 0.95));
      g.addColorStop(1, rgba(s.cor, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    // nos
    for (const n of nos) {
      const pulso = n.fixo ? 1 + Math.sin(t * 1.8 + n.x) * 0.14 : 1;
      const r = n.r * pulso;
      const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 4.5);
      g.addColorStop(0, rgba(n.cor, n.fantasma ? 0.32 : 0.7));
      g.addColorStop(1, rgba(n.cor, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r * 4.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(n.cor, n.fantasma ? 0.45 : 0.95);
      ctx.fill();
    }
  }

  let ultimo = performance.now();
  function laco(agora) {
    if (!vivo) return;
    const dt = Math.min(0.05, (agora - ultimo) / 1000 || 0.016);
    ultimo = agora;
    if (!document.hidden) {
      passo(dt);
      desenhar();
    }
    requestAnimationFrame(laco);
  }

  if (semMovimento) desenhar();
  else requestAnimationFrame(laco);

  return {
    carregar,
    sinal,
    destruir() {
      vivo = false;
      ro.disconnect();
      canvas.remove();
    },
  };
}
