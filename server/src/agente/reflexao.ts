import { db, getSetting, newId, now, setSetting } from '../db.ts';
import { complete, hasKey, modeloAuxiliar } from '../llm.ts';
import { deBytes, proximidade } from '../embed.ts';
import {
  calibrarLimiar,
  correct,
  esquecerIndice,
  indexarPendentes,
  reavaliarNucleo,
  remember,
} from '../memory.ts';

// ===========================================================================
// A reflexao: o agente olha para a propria memoria e a melhora.
//
// **O achado da pesquisa que define este arquivo:** autocritica solta nao
// funciona. Pedir a um modelo que "reflita sobre a propria memoria" produz
// texto bonito e mudanca nenhuma. O que funciona e critica ANCORADA em
// evidencia — numeros medidos, pares concretos, fatos.
//
// Entao a reflexao nao recebe a memoria inteira e uma pergunta vaga. Ela
// recebe:
//
//   - os pares mais parecidos entre si, que sao os candidatos reais a
//     repeticao ou contradicao
//   - o que nunca foi usado em muito tempo
//   - as contagens
//
// E devolve OPERACOES, nao opiniao. Quatro, so:
//
//   JUNTAR    duas memorias que dizem a mesma coisa viram uma, melhor escrita
//   CORRIGIR  duas que se contradizem: uma vence, a outra fica superada
//   ARQUIVAR  tira do nucleo o que nao serve mais (nao apaga)
//   ENTENDER  escreve uma memoria NOVA, de nivel mais alto
//
// A ultima e a que faz ele evoluir: tres observacoes parecidas viram um
// entendimento. E o padrao dos Generative Agents — reflexao que vira memoria e
// volta para o mesmo acervo, em vez de virar relatorio a parte.
//
// **Nada e apagado, nunca.** Toda operacao passa por `correct`, que deixa a
// versao antiga registrada como superada. Da para olhar depois e ver o que ele
// mudou sozinho e por que.
//
// **E ele nao alcanca o que o limita.** Estas quatro operacoes mexem em
// `thoughts` e em nada mais. A lista de comandos, o tempo de uma autorizacao,
// o que nunca roda — nada disso esta ao alcance daqui, e nao e por descuido.
// Um agente que afrouxa a propria trava aprendendo nao e evoluido.
// ===========================================================================

/** Quantas memorias novas antes de valer a pena refletir de novo. */
const PASSO = Number(process.env.THOR_PASSO_REFLEXAO ?? 12);

/** Quantos pares parecidos mostrar. Mais que isso vira ruido no prompt. */
const PARES = 12;

/**
 * Acima de quanto duas memorias sao candidatas a dizer a mesma coisa.
 *
 * Isto ja foi 0,55 fixo, e era um chute que nao achava nada: medido neste
 * servidor, duas frases que dizem o mesmo com outras palavras ficam perto de
 * 0,40 — abaixo da barra. A reflexao rodava e nunca via par nenhum.
 *
 * Agora sai do limiar calibrado pelo proprio acervo, mais uma margem. "Mesma
 * coisa" tem de ser claramente mais perto que "mesmo assunto", e o quanto isso
 * vale em numero depende do que esta guardado — nao de um palpite meu.
 */
const margemDeRepeticao = (): number => calibrarLimiar().limiar + 0.08;

/** Sem uso por tantos dias, uma memoria vira candidata a sair do nucleo. */
const DIAS_PARADA = 60;

type Viva = {
  id: string;
  kind: string;
  content: string;
  importancia: number;
  usos: number;
  ultimoUso: number | null;
  createdAt: number;
  pinned: number;
  vetor: Uint8Array | null;
};

const vivas = (): Viva[] =>
  db
    .prepare(
      `SELECT id, kind, content, importancia, usos, ultimo_uso AS ultimoUso,
              created_at AS createdAt, pinned, vetor
         FROM thoughts WHERE superseded_by IS NULL
         ORDER BY created_at`,
    )
    .all() as Viva[];

export function vaiRefletir(): boolean {
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM thoughts WHERE superseded_by IS NULL`).get() as {
      n: number;
    }
  ).n;
  const naUltima = Number(getSetting('reflexao_contagem') || 0);
  return total - naUltima >= PASSO;
}

// ------------------------------------------------------------- a evidencia

type Evidencia = {
  pares: { a: Viva; b: Viva; perto: number }[];
  paradas: Viva[];
  total: number;
};

export function levantarEvidencia(): Evidencia {
  const todas = vivas();
  const comVetor = todas.filter((t) => t.vetor);

  const limite = margemDeRepeticao();
  const pares: { a: Viva; b: Viva; perto: number }[] = [];
  for (let i = 0; i < comVetor.length; i++) {
    for (let j = i + 1; j < comVetor.length; j++) {
      const perto = proximidade(deBytes(comVetor[i].vetor!), deBytes(comVetor[j].vetor!));
      if (perto >= limite) pares.push({ a: comVetor[i], b: comVetor[j], perto });
    }
  }
  pares.sort((x, y) => y.perto - x.perto);

  const corte = Date.now() - DIAS_PARADA * 86_400_000;
  const paradas = todas.filter(
    (t) => t.pinned === 1 && t.usos === 0 && (t.ultimoUso ?? t.createdAt) < corte,
  );

  return { pares: pares.slice(0, PARES), paradas: paradas.slice(0, 10), total: todas.length };
}

function descrever(e: Evidencia): string {
  const linhas: string[] = [`Ao todo: ${e.total} memorias vivas.`, ''];

  if (e.pares.length) {
    linhas.push('PARES MUITO PARECIDOS (candidatos a repeticao ou contradicao):');
    for (const { a, b, perto } of e.pares) {
      linhas.push(`  proximidade ${perto.toFixed(2)}`);
      linhas.push(`    A ${a.id} [${a.kind}, imp ${a.importancia}, ${a.usos} usos] ${a.content}`);
      linhas.push(`    B ${b.id} [${b.kind}, imp ${b.importancia}, ${b.usos} usos] ${b.content}`);
    }
    linhas.push('');
  }

  if (e.paradas.length) {
    linhas.push('NO NUCLEO MAS NUNCA USADAS (candidatas a sair):');
    for (const t of e.paradas) {
      linhas.push(`  ${t.id} [${t.kind}, imp ${t.importancia}] ${t.content}`);
    }
    linhas.push('');
  }

  return linhas.join('\n');
}

// ------------------------------------------------------------------ molde

const MOLDE = [
  'Voce revisa a memoria de um assistente pessoal. Recebe EVIDENCIA medida, nao a memoria',
  'inteira: pares que o sistema achou parecidos demais, e itens que estao na memoria',
  'principal sem nunca terem sido usados.',
  '',
  'Responda SO com linhas de operacao. Formatos:',
  '',
  '  JUNTAR | idA,idB | o texto unico que substitui os dois',
  '  CORRIGIR | idPerdedor | o texto que passa a valer',
  '  ARQUIVAR | id | por que nao merece mais estar na memoria principal',
  '  ENTENDER | importancia | um entendimento novo que vem de varias delas',
  '',
  'Quando usar cada uma:',
  '',
  'JUNTAR  os dois dizem a MESMA coisa com palavras diferentes. O texto novo tem de',
  '        conter o que os dois diziam, melhor escrito, sem perder detalhe.',
  '',
  'CORRIGIR  os dois se CONTRADIZEM. Decida qual reflete o estado atual (normalmente o',
  '          mais recente ou o mais usado) e escreva o texto certo. O perdedor fica',
  '          registrado como superado, nao apagado.',
  '',
  'ARQUIVAR  esta na memoria principal, nunca foi usada, e ao ler da para ver que era',
  '          circunstancial. Nao use para o que e raro mas importante.',
  '',
  'ENTENDER  varias observacoes apontam para a mesma conclusao que nenhuma delas diz',
  '          sozinha. Exemplo: tres memorias sobre ele cortar conversa, pedir resumo e',
  '          reclamar de texto longo viram "ele le pouco e decide rapido; va direto ao',
  '          ponto". Importancia de 1 a 5.',
  '',
  'Regras:',
  '- Na duvida, NAO mexa. Memoria errada apagada e pior que memoria repetida.',
  '- Parecido nao e igual. Duas preferencias sobre assuntos vizinhos continuam duas.',
  '- No maximo 6 operacoes. Prefira as que mais limpam.',
  '- Se nao houver nada a fazer, responda apenas: NADA',
].join('\n');

// --------------------------------------------------------------- aplicacao

type Operacao = { tipo: string; alvos: string[]; texto: string; importancia: number };

export function lerOperacao(linha: string): Operacao | null {
  const partes = linha.split('|');
  if (partes.length < 3) return null;

  const tipo = partes[0].trim().toUpperCase();
  if (!['JUNTAR', 'CORRIGIR', 'ARQUIVAR', 'ENTENDER'].includes(tipo)) return null;

  const meio = partes[1].trim();
  const texto = partes.slice(2).join('|').trim();
  if (!texto) return null;

  if (tipo === 'ENTENDER') {
    const imp = /^[1-5]$/.test(meio) ? Number(meio) : 3;
    return { tipo, alvos: [], texto, importancia: imp };
  }
  const alvos = meio.split(',').map((s) => s.trim()).filter(Boolean);
  if (alvos.length === 0) return null;
  return { tipo, alvos, texto, importancia: 3 };
}

const existe = (id: string): boolean =>
  Boolean(
    db
      .prepare(`SELECT 1 FROM thoughts WHERE id = ? AND superseded_by IS NULL`)
      .get(id),
  );

export function aplicar(op: Operacao): string | null {
  // Toda operacao confere que o alvo existe e ainda esta vivo. O modelo as
  // vezes inventa id, ou cita um que outra operacao desta mesma rodada ja
  // superou.
  if (op.tipo === 'JUNTAR') {
    const vivos = op.alvos.filter(existe);
    if (vivos.length < 2) return null;
    // O primeiro recebe o texto novo; os demais passam a apontar para ele.
    const novo = correct(vivos[0], '', op.texto, null);
    if (!novo) return null;
    for (const outro of vivos.slice(1)) {
      db.prepare(`UPDATE thoughts SET superseded_by = ?, updated_at = ? WHERE id = ?`).run(
        novo.id,
        now(),
        outro,
      );
    }
    return `juntou ${vivos.length} em ${novo.id}`;
  }

  if (op.tipo === 'CORRIGIR') {
    const alvo = op.alvos.find(existe);
    if (!alvo) return null;
    const novo = correct(alvo, '', op.texto, null);
    return novo ? `corrigiu ${alvo}` : null;
  }

  if (op.tipo === 'ARQUIVAR') {
    const alvo = op.alvos.find(existe);
    if (!alvo) return null;
    // Sai do nucleo, continua no acervo. E por isso que a operacao se chama
    // arquivar e nao apagar: apagar nao existe aqui.
    db.prepare(
      `UPDATE thoughts SET pinned = 0, updated_at = ?
        WHERE id = ? AND fixado_por IS NOT 'lucas'`,
    ).run(now(), alvo);
    return `arquivou ${alvo}`;
  }

  if (op.tipo === 'ENTENDER') {
    const t = remember('fato', op.texto, null, 0.9, op.importancia);
    return t ? `entendeu: ${t.id}` : null;
  }

  return null;
}

// ------------------------------------------------------------------ rodada

export type Resultado = { operacoes: string[]; observacao: string; evidencia: Evidencia };

/**
 * Uma rodada de reflexao.
 *
 * Uma so. A pesquisa e clara em que o ganho esta na primeira ou segunda
 * passada e que insistir alem disso nao melhora — entao nao ha laco aqui, de
 * proposito.
 */
export async function refletir(): Promise<Resultado | null> {
  if (!hasKey()) return null;

  const evidencia = levantarEvidencia();
  if (evidencia.pares.length === 0 && evidencia.paradas.length === 0) {
    // Sem evidencia nao ha o que criticar. Chamar o modelo aqui seria pagar
    // para ele inventar problema.
    setSetting('reflexao_contagem', String(evidencia.total));
    return null;
  }

  let bruto: string;
  try {
    bruto = await complete(MOLDE, descrever(evidencia), 900, modeloAuxiliar());
  } catch {
    return null;
  }

  const feitas: string[] = [];
  if (bruto && !/^\s*NADA\s*$/i.test(bruto)) {
    for (const linha of bruto.split('\n')) {
      const op = lerOperacao(linha);
      if (!op) continue;
      const feito = aplicar(op);
      if (feito) feitas.push(feito);
      if (feitas.length >= 6) break;
    }
  }

  if (feitas.length) {
    esquecerIndice();
    void indexarPendentes();
    reavaliarNucleo();
  }

  db.prepare(
    `INSERT INTO reflexoes (id, observacao, acoes, memorias, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(newId(), bruto.slice(0, 4000), JSON.stringify(feitas), evidencia.total, now());

  setSetting('reflexao_contagem', String(evidencia.total));
  return { operacoes: feitas, observacao: bruto, evidencia };
}

export function historicoReflexoes(limite = 20) {
  return db
    .prepare(
      `SELECT id, observacao, acoes, memorias, created_at AS createdAt
         FROM reflexoes ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limite);
}
