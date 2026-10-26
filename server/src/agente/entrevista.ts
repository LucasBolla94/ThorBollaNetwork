import { getSetting, setSetting, db } from '../db.ts';
import { complete, hasKey, modeloAuxiliar } from '../llm.ts';
import { escreverPerfil, temPerfil } from '../alma.ts';

// ===========================================================================
// A primeira conversa: o agente se monta para quem instalou.
//
// Quem conduz e o SERVIDOR, nao o modelo. A pesquisa sobre entrevistar para
// montar persona bate em dois pontos — uma pergunta por vez, e nao deixar a
// conversa divagar — e os dois sao garantia que codigo da e modelo nao. Um
// modelo conduzindo tende a juntar duas perguntas numa, ou a puxar assunto.
//
// O modelo entra uma vez so, no fim: ele le as respostas e ESCREVE o perfil.
// E a unica parte que precisa de julgamento.
//
// O que da para descobrir sozinho nao se pergunta. Data, fuso, o que esta
// instalado: isso o agente ja sabe, e perguntar faria dele um formulario.
// ===========================================================================

type Resposta = { pergunta: string; resposta: string };
type Estado = { passo: number; respostas: Resposta[]; concluida: boolean };

const VAZIO: Estado = { passo: 0, respostas: [], concluida: false };

export const PERGUNTAS = [
  {
    chave: 'nome',
    texto:
      'Antes de começarmos, preciso te conhecer um pouco — são cinco perguntas rápidas e ' +
      'depois nunca mais.\n\nComo devo te chamar?',
  },
  {
    chave: 'tratamento',
    texto:
      'Prefere que eu te trate de forma mais formal, tipo "senhor", ou mais direta, por você?',
  },
  {
    chave: 'decisao',
    texto:
      'Quando você me pedir uma decisão, o que ajuda mais: eu escolher por você e explicar ' +
      'o porquê, ou eu te mostrar os caminhos com o que cada um ganha e arrisca?',
  },
  {
    chave: 'detalhe',
    texto:
      'E o tamanho da resposta: curta e direta por padrão, ou completa com o raciocínio junto?',
  },
  {
    chave: 'uso',
    texto: 'Por último: em que você mais quer a minha ajuda no dia a dia?',
  },
] as const;

function estado(): Estado {
  try {
    const bruto = getSetting('entrevista');
    return bruto ? { ...VAZIO, ...JSON.parse(bruto) } : { ...VAZIO };
  } catch {
    return { ...VAZIO };
  }
}

const salvar = (e: Estado): void => setSetting('entrevista', JSON.stringify(e));

/** Ainda falta entrevistar? */
export function precisaEntrevistar(): boolean {
  if (temPerfil()) return false;
  return !estado().concluida;
}

/** A pergunta de agora, ou null se acabaram. */
export function perguntaAtual(): string | null {
  const e = estado();
  return e.passo < PERGUNTAS.length ? PERGUNTAS[e.passo].texto : null;
}

export type PassoDaEntrevista =
  | { tipo: 'pergunta'; texto: string; numero: number; total: number }
  | { tipo: 'pronto'; texto: string };

/**
 * Registra a resposta e devolve o proximo passo.
 *
 * Resposta vazia nao avanca: sem conteudo, a pergunta seguinte deixaria um
 * buraco no perfil que ninguem notaria depois.
 */
export async function responder(texto: string): Promise<PassoDaEntrevista> {
  const e = estado();
  const limpo = texto.trim();

  if (limpo && e.passo < PERGUNTAS.length) {
    e.respostas.push({ pergunta: PERGUNTAS[e.passo].chave, resposta: limpo.slice(0, 600) });
    e.passo++;
    salvar(e);
  }

  if (e.passo < PERGUNTAS.length) {
    return {
      tipo: 'pergunta',
      texto: PERGUNTAS[e.passo].texto,
      numero: e.passo + 1,
      total: PERGUNTAS.length,
    };
  }

  const perfil = await montarPerfil(e.respostas);
  e.concluida = true;
  salvar(e);

  return {
    tipo: 'pronto',
    texto:
      'Pronto. Foi isto que eu entendi sobre você:\n\n' +
      `${perfil}\n\n` +
      'Está guardado e vale daqui para a frente. Se eu errei em alguma coisa, é só me ' +
      'dizer que eu ajusto — e você pode reescrever isso quando quiser, que a partir daí ' +
      'eu não mexo mais sozinho.',
  };
}

const MOLDE =
  'Você recebe as respostas de alguém a cinco perguntas sobre como quer ser atendido por um ' +
  'assistente pessoal. Escreva o PERFIL dele, que o assistente vai ler no começo de toda ' +
  'conversa.\n\n' +
  'Escreva em português do Brasil, em tópicos curtos, na segunda pessoa dirigida ao ' +
  'assistente ("trate-o por...", "prefira respostas...").\n\n' +
  'Cubra, nesta ordem, só o que as respostas sustentam:\n' +
  '- como chamá-lo\n' +
  '- como tratá-lo (formal ou direto)\n' +
  '- o que fazer quando ele pedir uma decisão\n' +
  '- o tamanho padrão da resposta\n' +
  '- em que ele mais quer ajuda\n\n' +
  'Máximo 15 linhas. Sem título, sem introdução, sem despedida. Não invente nada que as ' +
  'respostas não digam — se ele foi vago num ponto, escreva o que der e pare. Perfil curto e ' +
  'verdadeiro vale mais que perfil completo e inventado.';

async function montarPerfil(respostas: Resposta[]): Promise<string> {
  const corpo = respostas.map((r) => `${r.pergunta}: ${r.resposta}`).join('\n');

  let texto = '';
  if (hasKey()) {
    try {
      texto = await complete(MOLDE, corpo, 600, modeloAuxiliar());
    } catch {
      /* cai no perfil cru logo abaixo */
    }
  }

  // Sem modelo, o perfil vira as proprias respostas. Feio e honesto: melhor um
  // perfil cru que funciona do que nenhum perfil porque a chave nao estava la.
  if (!texto || texto.length < 30) {
    texto = respostas.map((r) => `- ${r.pergunta}: ${r.resposta}`).join('\n');
  }

  escreverPerfil(texto.trim());
  return texto.trim();
}

/** Recomeça a entrevista. Só a pedido — apaga o progresso, não o perfil. */
export function reiniciarEntrevista(): void {
  db.prepare(`DELETE FROM settings WHERE key = 'entrevista'`).run();
}

export const totalDePerguntas = PERGUNTAS.length;
