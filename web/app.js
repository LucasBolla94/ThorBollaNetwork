// =========================================================================
// Thor — cliente. Modulo unico, sem dependencia externa (a CSP nao permite).
// =========================================================================

import { criarReator } from './hud.js';
import { criarRede } from './neural.js';
import { criarEscutaDoNavegador, criarVoz, navegadorSabeOuvir } from './voz.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  conversationId: null,
  conversations: [],
  model: '',
  streaming: false,
  ws: null,
  retry: 0,
  // voz. `servidorOuve` e `servidorFala` vem do servidor; `vozLigada` e a
  // escolha dele no botao; `comoOuvir` diz quem esta ouvindo de fato.
  servidorOuve: false,
  servidorFala: false,
  vozLigada: false,
  queriaVoz: false,
  comoOuvir: '',
};

// ------------------------------------------------------------------ utils

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* resposta sem corpo */
  }
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `erro ${res.status}`), { data, status: res.status });
  return data;
};

// Todos os reatores da pagina respondem juntos: o da barra lateral, o da tela
// de entrada, o do heroi. E o mesmo instrumento em varios lugares.
const reatores = [];
let redeTeia = null;
let redeFundo = null;

/**
 * Os numeros que os aneis desenham. Nada aqui e inventado para parecer bonito:
 * sao os mesmos valores que aparecem escritos embaixo do reator. Se o anel
 * externo esta cheio, e porque a memoria tem 60 pensamentos.
 */
const tele = { pensamentos: 0, cache: 0, conversas: 0, voltas: 0 };

function acenderReatores(raiz = document) {
  for (const el of raiz.querySelectorAll('[data-reator]:not([data-aceso])')) {
    el.dataset.aceso = '1';
    reatores.push(criarReator(el, () => tele));
  }
}

const nucleoEstado = (nome) => {
  for (const n of reatores) n.estado(nome);
  const txt = $('#estado-txt');
  if (txt && reatores[0]) txt.textContent = reatores[0].rotulo();
};
const nucleoPulso = (f) => {
  for (const n of reatores) n.pulsar(f);
};

/** Reescreve as leituras embaixo do reator. */
function mostrarTelemetria() {
  const set = (id, v) => {
    const el = $(id);
    if (el) el.textContent = v;
  };
  set('#ler-mem', String(tele.pensamentos));
  set('#ler-cache', tele.cache > 0 ? `${Math.round(tele.cache * 100)}%` : '--');
  set('#ler-conv', String(tele.conversas));
  set('#ler-voltas', String(tele.voltas));
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const show = (id) => {
  for (const s of [
    'boot',
    'screen-signup',
    'screen-check',
    'screen-login',
    'screen-forgot',
    'screen-reset',
    'screen-app',
  ]) {
    $(`#${s}`).hidden = s !== id;
  }
};

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'ontem' : `${d} dias`;
}

// --------------------------------------------------- markdown (seguro)

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Renderiza um subconjunto de markdown. O texto vem de um modelo, entao a
 * ordem importa: escapa HTML primeiro, depois formata. Nunca o contrario.
 */
function md(src) {
  let text = esc(src ?? '');

  // Blocos de codigo saem de cena antes do processamento em linha, senao
  // asterisco e underscore dentro de codigo viram negrito.
  const blocks = [];
  text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code data-lang="${lang}">${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  const inline = (s) =>
    s
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const lines = text.split('\n');
  const out = [];
  let list = null;
  let quote = [];
  let table = null;

  const closeList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };
  const closeQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.map((q) => `<p>${inline(q)}</p>`).join('')}</blockquote>`);
      quote = [];
    }
  };
  const closeTable = () => {
    if (table) {
      const head = `<tr>${table.head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`;
      const body = table.rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table><thead>${head}</thead><tbody>${body}</tbody></table>`);
      table = null;
    }
  };
  const closeAll = () => {
    closeList();
    closeQuote();
    closeTable();
  };

  const cells = (line) =>
    line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^\u0000B\d+\u0000$/.test(line.trim())) {
      closeAll();
      out.push(line.trim());
      continue;
    }
    if (!line.trim()) {
      closeAll();
      continue;
    }
    // Tabela
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const row = cells(line);
      if (!table) {
        table = { head: row, rows: [], seenSep: false };
      } else if (!table.seenSep && row.every((c) => /^:?-{2,}:?$/.test(c))) {
        table.seenSep = true;
      } else {
        table.rows.push(row);
      }
      continue;
    }
    closeTable();

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      closeQuote();
      const level = Math.min(h[1].length + 1, 4);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      closeList();
      quote.push(q[1]);
      continue;
    }
    closeQuote();

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        closeList();
        list = { tag, items: [] };
      }
      list.items.push((ul ?? ol)[1]);
      continue;
    }
    closeList();

    if (out.length && out[out.length - 1].startsWith('<p>') && !out[out.length - 1].endsWith('</p>')) {
      out[out.length - 1] += ` ${inline(line)}`;
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeAll();

  return out.join('').replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

/**
 * Durante o streaming, uma marca de memoria pode chegar pela metade.
 * Esconder o que esta dentro de marca aberta evita o usuario ver
 * `<lembrar tipo="fato">` aparecendo na tela antes de ser removido.
 */
const hideTags = (s) =>
  s
    .replace(/<(lembrar|corrigir)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(lembrar|corrigir)\b[\s\S]*$/i, '');

// ----------------------------------------------------------- mensagens

function clearEmpty() {
  const e = $('#empty');
  if (e) e.remove();
}

function addMessage(role, content) {
  clearEmpty();
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `<div class="who">${role === 'user' ? 'EU' : 'L'}</div><div class="body"></div>`;
  wrap.querySelector('.body').innerHTML = md(content);
  $('#stream').append(wrap);
  scrollDown();
  return wrap;
}

/**
 * Aviso do sistema. Nao apaga o heroi de proposito: a primeira tela e a cara
 * do Thor, e um aviso de configuracao nao deveria custar isso.
 */
function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'sys';
  el.textContent = text;
  const vazio = $('#empty');
  if (vazio) $('#stream').insertBefore(el, vazio);
  else $('#stream').append(el);
  scrollDown();
}

function addRemembered(items) {
  if (!items?.length) return;
  const el = document.createElement('div');
  el.className = 'remembered';
  el.innerHTML = items
    .map(
      (t) =>
        `<span class="chip${t.confidence >= 0.9 ? ' fix' : ''}">guardei: ${esc(
          t.content.slice(0, 70),
        )}${t.content.length > 70 ? '...' : ''}</span>`,
    )
    .join('');
  $('#stream').append(el);
  scrollDown();
}


// ---------------------------------------------------------- autorizacao

const cartoes = new Map();

/**
 * O cartao de autorizacao.
 *
 * O desenho tem uma regra que nao e estetica: **o comando cru em cima, grande,
 * e a frase do Thor embaixo, menor e rotulada como fala dele.** Se um dia ele
 * ler uma pagina envenenada e pedir autorizacao com uma justificativa
 * convincente, o que decide a aprovacao tem de ser o que vai rodar, nao a
 * historia contada em volta. Por isso a justificativa nunca recebe destaque,
 * nunca e formatada como markdown e vem com "ele disse" na frente.
 */
function mostrarPedido(p) {
  const existente = cartoes.get(p.id);

  if (p.estado !== 'pendente') {
    if (existente) {
      clearInterval(existente.relogio);
      existente.el.classList.add('decidido');
      existente.el.dataset.estado = p.estado;
      existente.el.querySelector('.aprov-acoes').innerHTML =
        `<span class="aprov-selo">${
          { aprovado: 'autorizado', negado: 'negado', expirado: 'venceu sem resposta' }[p.estado]
        }</span>`;
      cartoes.delete(p.id);
    }
    return;
  }
  if (existente) return;

  clearEmpty();
  const el = document.createElement('div');
  el.className = 'aprov';
  el.innerHTML = `
    <div class="aprov-topo">
      <span class="aprov-tag">precisa da sua autorizacao</span>
      <span class="aprov-tempo"></span>
    </div>
    <pre class="aprov-cmd"></pre>
    <div class="aprov-fala"><span>ele disse</span><p></p></div>
    <div class="aprov-acoes">
      <button class="aprov-sim">autorizar</button>
      <button class="aprov-nao">negar</button>
    </div>`;

  // textContent, nao innerHTML: o comando e a justificativa vem do modelo, e
  // nada que ele escreva deveria virar marcacao nesta tela.
  el.querySelector('.aprov-cmd').textContent = p.comando;
  el.querySelector('.aprov-fala p').textContent = p.justificativa || '(sem motivo)';

  const tempo = el.querySelector('.aprov-tempo');
  const tique = () => {
    const resta = Math.max(0, Math.round((p.expiraEm - Date.now()) / 1000));
    tempo.textContent = `${resta}s`;
    tempo.classList.toggle('urgente', resta <= 20);
    if (resta === 0) clearInterval(relogio);
  };
  const relogio = setInterval(tique, 1000);
  tique();

  const decidir = (aprovado) => {
    el.querySelectorAll('button').forEach((b) => (b.disabled = true));
    if (state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({ t: 'decidir', id: p.id, aprovado }));
    } else {
      api(`/api/aprovacoes/${p.id}`, { method: 'POST', body: { aprovado } }).catch(() =>
        toast('nao consegui enviar a decisao'),
      );
    }
  };
  el.querySelector('.aprov-sim').addEventListener('click', () => decidir(true));
  el.querySelector('.aprov-nao').addEventListener('click', () => decidir(false));

  $('#stream').append(el);
  cartoes.set(p.id, { el, relogio });
  nucleoEstado('ouvindo');
  scrollDown();
}

function addToolNote(query) {
  clearEmpty();
  const el = document.createElement('div');
  el.className = 'tool-note';
  el.innerHTML =
    '<span class="dot"></span>procurando na memoria: <b>' + esc(query || '...') + '</b>';
  $('#stream').append(el);
  scrollDown();
}

/**
 * Mostra quanto do prompt veio do cache. Serve de alarme: se isto ficar em 0%
 * por varias mensagens seguidas, alguma coisa voltou a mudar o inicio do
 * prompt e o custo subiu ~10x sem aviso.
 */
function showUsage(u) {
  if (!u || !u.prompt) return;
  tele.cache = u.cached / u.prompt;
  mostrarTelemetria();
  const pct = Math.round((u.cached / u.prompt) * 100);
  const bits = [`${u.prompt} tokens de entrada`];
  if (u.cached) bits.push(`${pct}% do cache`);
  else if (u.written) bits.push('cache gravado');
  bits.push(`${u.completion} de saida`);
  $('#conn-hint').textContent = bits.join(' · ');
}

let pinned = true;
function scrollDown(force = false) {
  const s = $('#stream');
  if (force || pinned) s.scrollTop = s.scrollHeight;
}
$('#stream')?.addEventListener('scroll', () => {
  const s = $('#stream');
  pinned = s.scrollHeight - s.scrollTop - s.clientHeight < 90;
});

// -------------------------------------------------------------- websocket

// -------------------------------------------------------------------- voz

const voz = criarVoz({
  // Cada pedaco do microfone vai como quadro BINARIO. E so por isso que o
  // servidor sabe separar microfone de comando: mesma conexao, dois formatos.
  aoPedaco: (pcm) => {
    if (state.vozLigada && state.ws?.readyState === 1) state.ws.send(pcm);
  },
  aoEstado: (nome, extra) => dizerDaVoz(nome, extra),
});

const RECADOS_DA_VOZ = {
  ouvindo: 'Pode falar.',
  parado: 'Pode falar.',
  falando: '',
  desligada: '',
  negado: 'O navegador nao liberou o microfone. Procure o icone de microfone na barra de endereco.',
};

function dizerDaVoz(nome, extra) {
  const dica = $('#voz-hint');
  if (!dica) return;
  const texto =
    nome === 'erro'
      ? `Nao consegui abrir o microfone${extra?.erro ? `: ${extra.erro}` : '.'}`
      : (RECADOS_DA_VOZ[nome] ?? '');
  dica.textContent = texto;
  dica.hidden = !texto;
  document.body.classList.toggle('voz-falando', nome === 'falando');
  document.body.classList.toggle('voz-ouvindo', nome === 'ouvindo' || nome === 'parado');
  if (nome === 'negado' || nome === 'erro') desligarVoz();
}

let escutaNavegador = null;

/**
 * Quem vai ouvir: o servidor ou o navegador.
 *
 * O do servidor ganha quando esta disponivel, por dois motivos: funciona em
 * qualquer navegador (o do navegador nao existe no Firefox) e vai continuar
 * funcionando no app, que nao tem navegador nenhum. O do navegador e o plano
 * B que permite conversar sem depender de criar conta em lugar nenhum.
 */
function quemOuve() {
  if (state.servidorOuve) return 'servidor';
  if (navegadorSabeOuvir()) return 'navegador';
  return '';
}

function mostrarBotaoDaVoz() {
  const b = $('#btn-mic');
  if (!b) return;
  // Sem ninguem para ouvir e sem ninguem para falar, o botao nao prometeria
  // nada. Com qualquer um dos dois ele ja serve.
  b.hidden = !quemOuve() && !state.servidorFala;
}

async function ligarVoz() {
  state.queriaVoz = true;
  if (state.vozLigada) return;
  const como = quemOuve();
  if (!como && !state.servidorFala) return;

  // A ordem importa: pede o microfone ANTES de avisar o servidor. Se ele
  // recusar a permissao, o servidor nunca cria uma sessao de escuta que
  // ficaria esperando audio que nunca vem.
  if (como === 'servidor') {
    if (!(await voz.ligar())) return;
  } else if (como === 'navegador') {
    escutaNavegador ??= criarEscutaDoNavegador({
      aoTexto: (texto) => {
        // Falar por cima e interromper: cala a boca dele e cancela o turno
        // antes de mandar o que foi dito, senao `send` recusa por estar
        // ocupado e a frase se perde.
        voz.pararDeTocar();
        if (state.streaming) {
          state.ws?.send(JSON.stringify({ t: 'stop' }));
          state.streaming = false;
        }
        send(texto);
      },
      aoFalando: () => {
        if (voz.estaTocando()) voz.pararDeTocar();
      },
      aoEstado: dizerDaVoz,
    });
    if (!escutaNavegador.ligar()) return;
  }

  state.comoOuvir = como;
  state.vozLigada = true;
  $('#btn-mic')?.setAttribute('aria-pressed', 'true');
  state.ws?.send(
    JSON.stringify({ t: 'voz', ligado: true, ouvir: como === 'servidor', falar: true }),
  );
}

/**
 * Desliga o microfone.
 *
 * `porVontade` separa dois casos que parecem iguais e nao sao: ele apertou o
 * botao (nao quer mais voz), ou a conexao caiu (ainda quer, e e para voltar
 * sozinho quando reconectar). Sem essa distincao, perder o sinal no celular
 * obrigaria a apertar o botao de novo a cada tunel.
 */
function desligarVoz(porVontade = true) {
  if (porVontade) state.queriaVoz = false;
  if (!state.vozLigada) return;
  state.vozLigada = false;
  state.comoOuvir = '';
  $('#btn-mic')?.setAttribute('aria-pressed', 'false');
  void voz.desligar();
  escutaNavegador?.desligar();
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ t: 'voz', ligado: false }));
}

/**
 * Um quadro de audio da fala dele.
 *
 * O cabecalho vem dentro do proprio quadro (tipo, sequencia, taxa) em vez de
 * num JSON mandado antes. Assim um quadro perdido ou fora de ordem nao
 * desalinha a fila de audio inteira.
 */
function aoQuadroBinario(buf) {
  if (buf.byteLength < 11) return;
  const cabeca = new DataView(buf, 0, 9);
  if (cabeca.getUint8(0) !== 1) return;
  voz.tocar(buf.slice(9), cabeca.getUint32(5, true));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  // Sem isto o audio chegaria como Blob, que so se le de forma assincrona —
  // e audio que espera para ser lido e audio que atrasa.
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  let bubble = null;
  let body = null;
  let buffer = '';

  const finish = () => {
    state.streaming = false;
    nucleoEstado('dormindo');
    document.body.classList.remove('thinking');
    $('#btn-send').hidden = false;
    $('#btn-stop').hidden = true;
    body?.classList.remove('cursor');
    bubble = null;
    body = null;
    buffer = '';
  };

  ws.addEventListener('open', () => {
    state.retry = 0;
    $('#conn-hint').textContent = '';
  });

  ws.addEventListener('message', (ev) => {
    if (ev.data instanceof ArrayBuffer) return aoQuadroBinario(ev.data);
    const m = JSON.parse(ev.data);
    switch (m.t) {
      case 'voz':
        // Chega duas vezes com sentidos diferentes: logo apos conectar, dizendo
        // se o servico esta no ar; e como confirmacao de ligar ou desligar.
        if (typeof m.disponivel === 'boolean') {
          state.servidorOuve = m.ouve === true;
          state.servidorFala = m.fala === true;
          mostrarBotaoDaVoz();
          // Falta a chave, mas o navegador sabe ouvir: nao e um problema, e
          // uma diferenca que vale dizer uma vez — o caminho do navegador so
          // funciona com a aba na frente, e nao vai existir no app.
          if (m.faltaChave) {
            const d = $('#voz-hint');
            if (d) {
              d.textContent = navegadorSabeOuvir()
                ? 'Ouvindo pelo navegador. Para ele te ouvir sempre, falta uma chave em Configuracao.'
                : 'Para ele te ouvir, falta uma chave em Configuracao.';
              d.hidden = false;
            }
          }
          // Reconectou e ele ainda queria conversar falando: volta sozinho.
          if (state.queriaVoz && !state.vozLigada) void ligarVoz();
        }
        if (m.ligado === false) dizerDaVoz('desligada');
        break;
      case 'ouvindo':
        dizerDaVoz(m.falando ? 'falando' : 'ouvindo');
        break;
      case 'ouvi':
        // O que ele falou entra como mensagem dele na tela, igual ao digitado.
        addMessage('user', m.texto);
        state.streaming = true;
        pinned = true;
        tele.voltas = 0;
        mostrarTelemetria();
        nucleoEstado('pensando');
        document.body.classList.add('thinking');
        $('#btn-send').hidden = true;
        $('#btn-stop').hidden = false;
        scrollDown(true);
        break;
      case 'calar':
        // Ele falou por cima: cala na hora. Esperar o audio na fila terminar
        // faria o Thor continuar falando depois de ser interrompido.
        voz.pararDeTocar();
        break;
      case 'falou':
        dizerDaVoz(state.vozLigada ? 'ouvindo' : 'desligada');
        break;
      case 'ready':
        state.model = m.model;
        $('#model-pill').textContent = m.hasLlm ? m.model : 'sem chave de IA';
        if (!m.hasLlm) {
          addSystem('Falta a chave da IA. Abra Configuracao no menu ao lado para colar a sua.');
        }
        break;
      case 'conversation':
        state.conversationId = m.id;
        $('#chat-title').textContent = m.title;
        loadConversations();
        break;
      case 'title':
        $('#chat-title').textContent = m.title;
        loadConversations();
        break;
      case 'start':
        nucleoEstado('falando');
        bubble = addMessage('assistant', '');
        body = bubble.querySelector('.body');
        body.classList.add('cursor');
        break;
      case 'tool':
        tele.voltas += 1;
        mostrarTelemetria();
        addToolNote(m.query);
        // Sinais atravessando a teia: da para ver ele procurando.
        redeFundo?.sinal(6);
        redeTeia?.sinal(6);
        nucleoPulso(0.5);
        break;
      case 'delta':
        // O pulso por pedaco de texto e o que faz a luz piscar enquanto fala.
        nucleoPulso(0.085);
        buffer += m.text;
        if (body) body.innerHTML = md(hideTags(buffer));
        scrollDown();
        break;
      case 'done':
        if (body) body.innerHTML = md(m.content);
        finish();
        showUsage(m.usage);
        addRemembered(m.remembered);
        if (m.remembered?.length) refreshTeia();
        break;
      case 'aprovacao':
        mostrarPedido(m.pedido);
        break;
      case 'aborted':
        finish();
        toast('parei');
        break;
      case 'error':
        finish();
        nucleoEstado('erro');
        setTimeout(() => nucleoEstado('dormindo'), 2600);
        addSystem(m.message);
        break;
    }
  });

  ws.addEventListener('close', (ev) => {
    finish();
    // A sessao de escuta vive na conexao: caiu a conexao, caiu a escuta. Mas a
    // vontade dele continua, e por isso nao e "por vontade".
    desligarVoz(false);
    if (ev.code === 4401) {
      location.reload();
      return;
    }
    state.retry += 1;
    const wait = Math.min(12000, 700 * 2 ** (state.retry - 1));
    $('#conn-hint').textContent = `conexao caiu, voltando em ${Math.round(wait / 1000)}s`;
    setTimeout(connect, wait);
  });

  ws.addEventListener('error', () => {
    $('#conn-hint').textContent = 'problema na conexao';
  });
}

// ------------------------------------------------------------------ envio

function send(text) {
  if (!text.trim() || state.streaming) return;
  if (state.ws?.readyState !== 1) {
    toast('sem conexao com o servidor');
    return;
  }
  addMessage('user', text);
  state.streaming = true;
  pinned = true;
  tele.voltas = 0;
  mostrarTelemetria();
  nucleoEstado('pensando');
  document.body.classList.add('thinking');
  $('#btn-send').hidden = true;
  $('#btn-stop').hidden = false;
  state.ws.send(JSON.stringify({ t: 'chat', text, conversationId: state.conversationId }));
}

function wireComposer() {
  const input = $('#input');
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  };
  input.addEventListener('input', grow);

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = '';
    grow();
    send(text);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  $('#btn-mic')?.addEventListener('click', () => {
    if (state.vozLigada) desligarVoz();
    else void ligarVoz();
  });

  $('#btn-stop').addEventListener('click', () => {
    state.ws?.send(JSON.stringify({ t: 'stop' }));
  });

  $('#suggestions')?.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) send(b.textContent.trim());
  });
}

// ---------------------------------------------------------- conversas

async function loadConversations() {
  const { conversations } = await api('/api/conversations');
  state.conversations = conversations;
  tele.conversas = conversations.length;
  mostrarTelemetria();
  const list = $('#conv-list');
  list.innerHTML = '';

  if (!conversations.length) {
    list.innerHTML = '<p class="group-label">nenhuma conversa ainda</p>';
    return;
  }
  const today = [];
  const older = [];
  for (const c of conversations) {
    (Date.now() - c.updatedAt < 86400000 ? today : older).push(c);
  }
  const section = (label, items) => {
    if (!items.length) return;
    const h = document.createElement('p');
    h.className = 'group-label';
    h.textContent = label;
    list.append(h);
    for (const c of items) {
      const b = document.createElement('button');
      b.className = `conv${c.id === state.conversationId ? ' active' : ''}`;
      b.innerHTML = `${esc(c.title)}<small>${c.count} msgs · ${timeAgo(c.updatedAt)}</small>`;
      b.addEventListener('click', () => openConversation(c.id));
      list.append(b);
    }
  };
  section('hoje', today);
  section('antes', older);
}

async function openConversation(id) {
  const { conversation, messages } = await api(`/api/conversations/${id}`);
  state.conversationId = id;
  $('#chat-title').textContent = conversation.title;
  const s = $('#stream');
  s.innerHTML = '';
  for (const m of messages) addMessage(m.role, m.content);
  scrollDown(true);
  $('#rail').classList.remove('open');
  loadConversations();
}

function newConversation() {
  state.conversationId = null;
  $('#chat-title').textContent = 'Conversa nova';
  $('#stream').innerHTML = `
    <div class="empty" id="empty">
      <div class="rede-fundo" id="rede-fundo-2" aria-hidden="true"></div>
      <div class="instrumento">
        <div class="reator reator-lg" data-reator></div>
        <div class="estado-linha"><i></i><span id="estado-txt">em espera</span></div>
        <div class="leituras">
          <div><b id="ler-mem">0</b><span>memoria</span></div>
          <div><b id="ler-cache">--</b><span>cache</span></div>
          <div><b id="ler-conv">0</b><span>conversas</span></div>
          <div><b id="ler-voltas">0</b><span>buscas</span></div>
        </div>
      </div>
      <h3>canal limpo</h3>
      <p class="muted">Conversa nova. Eu continuo lembrando de voce.</p>
    </div>`;
  mostrarTelemetria();
  acenderReatores($('#stream'));
  $('#rail').classList.remove('open');
  $('#input').focus();
  loadConversations();
}

// ------------------------------------------------------- teia de pensamento

async function refreshTeia() {
  const { thoughts, links, stats } = await api('/api/thoughts?all=1');

  $('#teia-stats').innerHTML = `
    <div><b>${stats.live}</b>vivos</div>
    <div><b>${stats.superseded}</b>corrigidos</div>
    <div><b>${stats.links}</b>ligacoes</div>
    <div><b>${stats.messages}</b>mensagens</div>`;

  redeTeia?.carregar(thoughts, links);
  redeFundo?.carregar(thoughts, links);
  tele.pensamentos = stats.live;
  mostrarTelemetria();

  const list = $('#teia-list');
  list.innerHTML = '';
  if (!thoughts.length) {
    list.innerHTML =
      '<p class="muted sm">Nada guardado ainda. Conversa comigo que eu vou anotando o que importa — ou ensina algo aqui embaixo.</p>';
    return;
  }
  for (const t of thoughts) {
    const el = document.createElement('div');
    el.className = `thought${t.supersededBy ? ' dead' : ''}${t.pinned ? ' pin' : ''}`;
    el.innerHTML = `
      <div class="meta">
        <span class="kind" data-k="${esc(t.kind)}">${esc(t.kind)}</span>
        <span>${timeAgo(t.createdAt)}</span>
        ${t.supersededBy ? '<span>corrigido</span>' : ''}
        <span class="acts">
          <button data-pin="${t.id}" title="Fixar">${t.pinned ? '★' : '☆'}</button>
          <button data-del="${t.id}" title="Esquecer">✕</button>
        </span>
      </div>
      <div>${esc(t.content)}</div>`;
    list.append(el);
  }
}

// --------------------------------------------------------- configuracao

let cfgProvider = 'openrouter';

async function loadConfig() {
  const c = await api('/api/config');
  cfgProvider = c.provider;

  for (const b of $$('#cfg-provider button')) {
    b.classList.toggle('on', b.dataset.p === c.provider);
    b.setAttribute('aria-checked', String(b.dataset.p === c.provider));
  }

  const atual = c.provider === 'anthropic' ? c.anthropic : c.openrouter;
  const nome = c.provider === 'anthropic' ? 'da Anthropic' : 'do OpenRouter';
  $('#cfg-provider-state').textContent = atual.hasKey
    ? `usando a chave ${nome} (${atual.hint})`
    : `sem chave ${nome} — o chat nao vai funcionar ate voce colar uma`;

  for (const [p, el] of [
    ['openrouter', $('#cfg-key-openrouter')],
    ['anthropic', $('#cfg-key-anthropic')],
  ]) {
    el.value = '';
    el.placeholder = c[p].hasKey
      ? `guardada (${c[p].hint})`
      : p === 'anthropic'
        ? 'sk-ant-...'
        : 'sk-or-v1-...';
  }

  $('#cfg-model').value = c.model;
  $('#cfg-model-for').textContent = `(${c.provider})`;

  const estadoEscuta = $('#cfg-escuta-state');
  if (estadoEscuta) {
    estadoEscuta.textContent = c.escuta?.hasKey
      ? `chave guardada (${c.escuta.hint}) — ele te ouve`
      : 'sem chave: o microfone fica escondido ate voce colar uma';
  }

  loadModels();
}

/**
 * A lista de modelos e so conveniencia. Se o provedor nao responder, o campo
 * continua aceitando o id digitado na mao — nao vale travar a configuracao
 * por causa de uma lista.
 */
async function loadModels() {
  $('#cfg-model-state').textContent = 'carregando modelos...';
  try {
    const { models } = await api('/api/models');
    $('#model-list').innerHTML = models
      .map((m) => `<option value="${esc(m.id)}">${esc(m.name ?? '')}</option>`)
      .join('');
    $('#cfg-model-state').textContent = `${models.length} modelos disponiveis`;
  } catch (ex) {
    $('#cfg-model-state').textContent = `nao consegui listar (${ex.message}) — pode digitar o id`;
  }
}

async function saveConfig() {
  const body = { provider: cfgProvider };
  const or = $('#cfg-key-openrouter').value.trim();
  const an = $('#cfg-key-anthropic').value.trim();
  const gq = $('#cfg-key-groq')?.value.trim();
  const model = $('#cfg-model').value.trim();
  if (or) body.openrouterKey = or;
  if (an) body.anthropicKey = an;
  if (gq) body.groqKey = gq;
  if (model) body.model = model;

  try {
    const r = await api('/api/config', { method: 'PUT', body });
    $('#cfg-ok').textContent = 'salvo';
    $('#model-pill').textContent = r.ready ? r.model : 'sem chave de IA';
    setTimeout(() => ($('#cfg-ok').textContent = ''), 2000);
    loadConfig();
    toast(r.ready ? 'pronto, ja posso pensar' : 'salvo, mas falta a chave');
  } catch (ex) {
    toast(ex.message);
  }
}

// ------------------------------------------------------------------ busca

let searchTimer;
function wireSearch() {
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(async () => {
      if (!q) return loadConversations();
      const { thoughts, messages } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      const list = $('#conv-list');
      list.innerHTML = '';
      if (thoughts.length) {
        const h = document.createElement('p');
        h.className = 'group-label';
        h.textContent = `memoria (${thoughts.length})`;
        list.append(h);
        for (const t of thoughts) {
          const d = document.createElement('div');
          d.className = 'conv';
          d.style.whiteSpace = 'normal';
          d.innerHTML = `${esc(t.content.slice(0, 120))}<small>${esc(t.kind)}</small>`;
          list.append(d);
        }
      }
      if (messages.length) {
        const h = document.createElement('p');
        h.className = 'group-label';
        h.textContent = `conversas (${messages.length})`;
        list.append(h);
        for (const m of messages) {
          const b = document.createElement('button');
          b.className = 'conv';
          b.style.whiteSpace = 'normal';
          b.innerHTML = `${esc(m.content.slice(0, 110))}<small>${esc(m.title)} · ${timeAgo(m.createdAt)}</small>`;
          b.addEventListener('click', () => openConversation(m.conversationId));
          list.append(b);
        }
      }
      if (!thoughts.length && !messages.length) {
        list.innerHTML = '<p class="group-label">nada encontrado</p>';
      }
    }, 240);
  });
}

// ------------------------------------------------------------------ telas

// --------------------------------------------------------- a aplicacao

function wireApp() {
  $('#btn-new').addEventListener('click', newConversation);
  $('#btn-rail').addEventListener('click', () => $('#rail').classList.toggle('open'));
  $('#btn-logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  });

  const openPanel = (id) => {
    for (const p of ['panel-teia', 'panel-soul', 'panel-config']) {
      $(`#${p}`).hidden = p !== id;
    }
    $('#rail').classList.remove('open');
  };

  $('#btn-teia').addEventListener('click', () => {
    openPanel('panel-teia');
    refreshTeia();
  });
  $('#link-teia')?.addEventListener('click', () => {
    openPanel('panel-teia');
    refreshTeia();
  });
  $('#btn-soul').addEventListener('click', () => {
    openPanel('panel-soul');
    loadSoul();
  });
  $('#btn-config').addEventListener('click', () => {
    openPanel('panel-config');
    loadConfig();
  });
  $('#btn-config-save').addEventListener('click', saveConfig);
  $('#cfg-provider').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]');
    if (!b) return;
    cfgProvider = b.dataset.p;
    for (const x of $$('#cfg-provider button')) {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-checked', String(x === b));
    }
    $('#cfg-model-for').textContent = `(${cfgProvider})`;
  });

  for (const b of $$('[data-close]')) {
    b.addEventListener('click', () => {
      $(`#${b.dataset.close}`).hidden = true;
    });
  }

  $('#teia-list').addEventListener('click', async (e) => {
    const pin = e.target.closest('[data-pin]');
    const del = e.target.closest('[data-del]');
    if (pin) {
      await api(`/api/thoughts/${pin.dataset.pin}/pin`, { method: 'POST' });
      refreshTeia();
    }
    if (del) {
      await api(`/api/thoughts/${del.dataset.del}`, { method: 'DELETE' });
      refreshTeia();
    }
  });

  $('#form-thought').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/thoughts', {
        method: 'POST',
        body: { kind: f.get('kind'), content: f.get('content') },
      });
      e.target.reset();
      refreshTeia();
      toast('guardado');
    } catch (ex) {
      toast(ex.message);
    }
  });

  $('#btn-soul-save').addEventListener('click', async () => {
    await api('/api/soul', { method: 'PUT', body: { soul: $('#soul-text').value } });
    $('#soul-ok').textContent = 'salvo';
    setTimeout(() => ($('#soul-ok').textContent = ''), 2000);
  });
  $('#btn-soul-reset').addEventListener('click', async () => {
    const { soul } = await api('/api/soul/reset', { method: 'POST' });
    $('#soul-text').value = soul;
    toast('alma restaurada');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      for (const p of ['panel-teia', 'panel-soul', 'panel-config']) $(`#${p}`).hidden = true;
      $('#rail').classList.remove('open');
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      $('#rail').classList.add('open');
      $('#search').focus();
    }
  });

  wireComposer();
  wireSearch();
}

async function enterApp() {
  show('screen-app');
  acenderReatores();
  if (!redeFundo && $('#rede-fundo')) redeFundo = criarRede($('#rede-fundo'), { densidade: 1.4 });
  if (!redeTeia && $('#rede-teia')) redeTeia = criarRede($('#rede-teia'));
  const st = await api('/api/state');
  $('#model-pill').textContent = st.hasLlm ? st.model : 'sem chave de IA';
  await loadConversations();
  connect();
  refreshTeia();
  $('#input').focus();
}

// ------------------------------------------------------- telas de conta

/** Guardado so em memoria: o token do link nunca encosta em localStorage. */
let tokenDoLink = '';

/**
 * O GoTrue devolve os tokens no FRAGMENTO da URL (depois do #), nao na query.
 * Fragmento nao e enviado ao servidor em requisicao nenhuma, que e justamente
 * o que faz esse formato ser o certo para um token: ele fica no navegador.
 * Ainda assim limpamos a barra de endereco, para nao sobrar no historico.
 */
function lerLinkDoEmail() {
  const h = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (!h) return null;
  const p = new URLSearchParams(h);
  const erro = p.get('error_description') || p.get('error');
  const token = p.get('access_token');
  const tipo = p.get('type');
  if (!erro && !token) return null;
  history.replaceState(null, '', location.pathname);
  return { erro, token, tipo };
}

function wireGates() {
  // --- criar conta ---
  $('#form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const err = $('#signup-error');
    err.textContent = '';
    if (f.get('password') !== f.get('password2')) {
      err.textContent = 'as senhas nao batem';
      return;
    }
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api('/api/auth/signup', {
        method: 'POST',
        body: { email: f.get('email'), password: f.get('password') },
      });
      $('#check-email').textContent = r.email;
      show('screen-check');
      if (r.avisoEmail) {
        $('#check-msg').style.color = '';
        $('#check-msg').textContent = r.avisoEmail;
      }
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });

  // --- entrar ---
  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const err = $('#login-error');
    err.textContent = '';
    const btn = e.target.querySelector('button.primary');
    btn.disabled = true;
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: { email: f.get('email'), password: f.get('password') },
      });
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
      // Conta criada mas nao confirmada: manda para a tela que resolve isso,
      // em vez de deixar a pessoa tentando a senha de novo.
      if (ex.data?.precisaConfirmar) {
        $('#check-email').textContent = String(f.get('email') ?? '');
        show('screen-check');
      }
    } finally {
      btn.disabled = false;
    }
  });

  // --- confirmar e-mail ---
  $('#btn-resend').addEventListener('click', async () => {
    const msg = $('#check-msg');
    msg.textContent = '';
    try {
      await api('/api/auth/resend', {
        method: 'POST',
        body: { email: $('#check-email').textContent.trim() },
      });
      msg.style.color = 'var(--ok)';
      msg.textContent = 'mandei de novo';
    } catch (ex) {
      msg.style.color = '';
      msg.textContent = ex.message;
    }
  });
  $('#btn-back-login').addEventListener('click', () => show('screen-login'));

  // --- esqueci a senha ---
  $('#btn-forgot').addEventListener('click', () => {
    $('#form-forgot').email.value = $('#form-login').email.value;
    show('screen-forgot');
  });
  $('#btn-back-login2').addEventListener('click', () => show('screen-login'));

  $('#form-forgot').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#forgot-msg');
    msg.textContent = '';
    const btn = e.target.querySelector('button.primary');
    btn.disabled = true;
    try {
      await api('/api/auth/forgot', {
        method: 'POST',
        body: { email: new FormData(e.target).get('email') },
      });
      msg.style.color = 'var(--ok)';
      msg.textContent = 'se esse e-mail tiver conta aqui, o link ja esta a caminho';
    } catch (ex) {
      msg.style.color = '';
      msg.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });

  // --- nova senha ---
  $('#form-reset').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const err = $('#reset-error');
    err.textContent = '';
    if (f.get('password') !== f.get('password2')) {
      err.textContent = 'as senhas nao batem';
      return;
    }
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await api('/api/auth/reset', {
        method: 'POST',
        body: { accessToken: tokenDoLink, password: f.get('password') },
      });
      tokenDoLink = '';
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });
}

async function boot() {
  wireGates();
  wireApp();
  acenderReatores();

  const link = lerLinkDoEmail();

  if (link?.erro) {
    show('screen-login');
    $('#login-error').textContent = decodeURIComponent(link.erro).replace(/\+/g, ' ');
    return;
  }

  if (link?.token) {
    // Convite e recuperacao caem no mesmo lugar: nos dois casos a pessoa chega
    // sem senha valida e precisa escolher uma. A diferenca e so o texto.
    if (link.tipo === 'recovery' || link.tipo === 'invite') {
      tokenDoLink = link.token;
      const convite = link.tipo === 'invite';
      $('#reset-titulo').textContent = convite ? 'Escolha sua senha' : 'Escolha uma senha nova';
      $('#reset-sub').textContent = convite
        ? 'E o ultimo passo. Depois disso o Thor e seu.'
        : 'Depois de salvar, as outras sessoes sao desconectadas.';
      $('#reset-acao').textContent = convite ? 'Entrar no Thor' : 'Salvar e entrar';
      show('screen-reset');
      $('#form-reset').password.focus();
      return;
    }
    // Confirmacao de e-mail: troca o token por uma sessao nossa e ja entra.
    try {
      await api('/api/auth/adopt', { method: 'POST', body: { accessToken: link.token } });
      await enterApp();
      toast('e-mail confirmado');
      return;
    } catch (ex) {
      show('screen-login');
      $('#login-error').textContent = ex.message;
      return;
    }
  }

  try {
    const st = await api('/api/state');
    if (st.authed) {
      await enterApp();
    } else if (st.setup) {
      show('screen-signup');
      if (st.ownerEmail) $('#form-signup').email.value = st.ownerEmail;
      $('#form-signup').password.focus();
    } else {
      show('screen-login');
      $('#form-login').email.focus();
    }
  } catch {
    show('screen-login');
    $('#login-error').textContent = 'o servidor nao respondeu';
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
