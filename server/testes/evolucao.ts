// Teste do que o agente faz sozinho: a entrevista que o monta, a memoria que
// se reordena por uso, e a reflexao que a melhora.
//
//   THOR_DB=/tmp/t.db THOR_DATA=/tmp/tdata node testes/evolucao.ts
//
// Roda contra banco e pasta de dados descartaveis. As partes que chamam o
// modelo pago so rodam com THOR_TESTE_PAGO=1.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, newId, now } from '../src/db.ts';
import { config } from '../src/config.ts';
import {
  base,
  caminhoPerfil,
  escreverPerfil,
  perfil,
  perfilEhDoDono,
  temPerfil,
} from '../src/alma.ts';
import { PERGUNTAS, perguntaAtual, precisaEntrevistar, responder } from '../src/agente/entrevista.ts';
import { lerLinha } from '../src/agente/colheita.ts';
import {
  aplicar,
  lerOperacao,
  levantarEvidencia,
  refletir,
  vaiRefletir,
} from '../src/agente/reflexao.ts';
import {
  buscarPorSentido,
  calibrarLimiar,
  coreBlock,
  esquecerIndice,
  esquecerLimiar,
  fixados,
  indexarPendentes,
  marcarUso,
  pontuarMemoria,
  reavaliarNucleo,
  remember,
  togglePin,
} from '../src/memory.ts';
import { embedDisponivel } from '../src/embed.ts';
import { hasKey } from '../src/llm.ts';

let falhas = 0;
let passou = 0;
const ok = (nome: string, certo: boolean, detalhe = '') => {
  if (certo) passou++;
  else falhas++;
  console.log(`  ${certo ? 'ok     ' : 'ERRADO '} ${nome}${detalhe ? `   (${detalhe})` : ''}`);
};
const secao = (t: string) => console.log(`\n=== ${t} ===`);

const limpar = () => {
  db.exec(`DELETE FROM thoughts; DELETE FROM thought_links; DELETE FROM messages;
           DELETE FROM conversations; DELETE FROM resumos; DELETE FROM reflexoes;`);
  db.exec(`DELETE FROM settings WHERE key IN ('entrevista','perfil_marca','reflexao_contagem')`);
  esquecerIndice();
  esquecerLimiar();
  if (existsSync(caminhoPerfil)) rmSync(caminhoPerfil);
};

mkdirSync(config.dataDir, { recursive: true });

// ============================================================ a base e o perfil

secao('Duas camadas: a base e o perfil');

limpar();
ok('a base existe e e grande', base().length > 1000, `${base().length} caracteres`);
ok('a base NAO fala de uma pessoa especifica', !/\bLucas\b/.test(base()),
  'e produto, serve para quem instalar');
ok('a base ensina a calcular os dois lados', /o que ganha, o que perde/i.test(base()));
ok('a base proibe mexer no que limita', /n[aã]o mexe no que te limita|afrouxa a pr[oó]pria trava/i.test(base()));
ok('sem perfil no comeco', !temPerfil());

escreverPerfil('- chame-o de Teste\n- trate por voce');
ok('escreveu o perfil', temPerfil() && perfil().includes('Teste'));
ok('o perfil fica fora do repositorio', caminhoPerfil.startsWith(config.dataDir),
  'deploy apaga o que nao e versionado');
ok('ainda nao foi editado pelo dono', !perfilEhDoDono());

// A garantia que importa: depois que o dono escreve, nada automatico sobrescreve.
writeFileSync(caminhoPerfil, '- chame-o de OUTRO NOME\n', 'utf8');
ok('detecta a edicao do dono', perfilEhDoDono());
ok('recusa sobrescrever o que o dono escreveu', escreverPerfil('tentativa') === false);
ok('o texto do dono ficou', readFileSync(caminhoPerfil, 'utf8').includes('OUTRO NOME'));
ok('forcar ainda funciona (restaurar pela tela)', escreverPerfil('novo', { forcar: true }));

// ================================================================= entrevista

secao('A entrevista que monta o agente');

limpar();
ok('instalacao nova precisa entrevistar', precisaEntrevistar());
ok('comeca pela primeira pergunta', perguntaAtual() === PERGUNTAS[0].texto);
ok('a primeira pergunta e o nome', /como devo te chamar/i.test(perguntaAtual() ?? ''));
ok('sao cinco perguntas', PERGUNTAS.length === 5, `${PERGUNTAS.length}`);

// Uma por vez, na ordem.
let passo = await responder('Me chame de Teste');
ok('avanca uma pergunta por vez', passo.tipo === 'pergunta' && passo.numero === 2,
  passo.tipo === 'pergunta' ? `numero ${passo.numero}` : passo.tipo);
ok('a segunda e sobre tratamento', passo.tipo === 'pergunta' && /formal|senhor/i.test(passo.texto));

// Resposta vazia nao pode avancar: deixaria um buraco no perfil.
const antes = perguntaAtual();
await responder('   ');
ok('resposta vazia nao avanca', perguntaAtual() === antes);

if (!hasKey() || process.env.THOR_TESTE_PAGO !== '1') {
  console.log('  resto da entrevista pulado (precisa de THOR_TESTE_PAGO=1)');
} else {
  await responder('Por voce, direto');
  await responder('Mostra os caminhos, eu decido');
  await responder('Curta');
  const fim = await responder('Servidores e automacao');

  ok('termina com o perfil pronto', fim.tipo === 'pronto');
  ok('nao precisa mais entrevistar', !precisaEntrevistar());
  ok('o perfil foi escrito', temPerfil());

  const p = perfil().toLowerCase();
  ok('o perfil guardou o nome', p.includes('teste'), perfil().slice(0, 70));
  ok('o perfil fala de como decidir', /caminho|op[cç]|decid/i.test(p));
  ok('o perfil nao inventa o que nao foi dito', !/\b(cafe|aniversario|esposa)\b/i.test(p));
}

// ================================================= importancia e as tres notas

secao('Importancia: nem toda memoria pesa igual');

limpar();
ok('le a linha com importancia', lerLinha('preferencia | 5 | ele decide rapido')?.importancia === 5);
ok('le o tipo certo', lerLinha('decisao | 4 | o deploy e por git')?.tipo === 'decisao');
ok('linha sem importancia vira media', lerLinha('fato | o disco encheu')?.importancia === 3,
  'formato nao pode custar o conteudo');
ok('importancia fora da faixa e ignorada', lerLinha('fato | 9 | algo')?.importancia === 3);
ok('linha sem barra e descartada', lerLinha('isso nao e operacao') === null);

const importante = remember('preferencia', 'ele decide rapido e odeia ser perguntado duas vezes', null, 0.9, 5);
const trivial = remember('fato', 'o disco estava em vinte e um por cento naquele dia', null, 0.8, 1);
ok('guardou a importancia alta', importante?.importancia === 5, `${importante?.importancia}`);
ok('guardou a importancia baixa', trivial?.importancia === 1, `${trivial?.importancia}`);

// ======================================================= o nucleo por evidencia

secao('O nucleo se reordena por uso, nao por regra minha');

limpar();
const usada = remember('fato', 'o servidor fica em Roubaix e chama dedicated-1', null, 0.8, 3)!;
const parada = remember('preferencia', 'ele gosta de graficos coloridos', null, 0.9, 3)!;

const notaAntes = pontuarMemoria({
  kind: usada.kind, confidence: usada.confidence, usos: 0, ultimoUso: null, createdAt: usada.createdAt,
});
const notaDepois = pontuarMemoria({
  kind: usada.kind, confidence: usada.confidence, usos: 8, ultimoUso: Date.now(), createdAt: usada.createdAt,
});
ok('usar aumenta a nota', notaDepois > notaAntes, `${notaAntes.toFixed(2)} -> ${notaDepois.toFixed(2)}`);

const velhaSemUso = pontuarMemoria({
  kind: 'preferencia', confidence: 0.9, usos: 0,
  ultimoUso: Date.now() - 200 * 86_400_000, createdAt: Date.now() - 200 * 86_400_000,
});
const novaUsada = pontuarMemoria({
  kind: 'fato', confidence: 0.8, usos: 6, ultimoUso: Date.now(), createdAt: Date.now(),
});
ok('uso vence tipo', novaUsada > velhaSemUso,
  `fato usado ${novaUsada.toFixed(2)} > preferencia parada ${velhaSemUso.toFixed(2)}`);

marcarUso([usada.id, usada.id]);
const conferir = db.prepare(`SELECT usos FROM thoughts WHERE id = ?`).get(usada.id) as { usos: number };
ok('o uso e contado', conferir.usos === 2, `${conferir.usos} usos`);

// O que o dono fixou na mao e intocavel.
togglePin(parada.id);
const dono = db.prepare(`SELECT fixado_por AS p FROM thoughts WHERE id = ?`).get(parada.id) as { p: string };
ok('fixar na mao marca o dono', dono.p === 'lucas');
for (let i = 0; i < 60; i++) remember('preferencia', `enchendo o nucleo numero ${i}`, null, 0.9, 4);
reavaliarNucleo();
const aindaFixada = db.prepare(`SELECT pinned FROM thoughts WHERE id = ?`).get(parada.id) as { pinned: number };
ok('a reavaliacao NAO derruba o que o dono fixou', aindaFixada.pinned === 1,
  'escolha explicita nao e palpite a revisar');
ok('o nucleo respeita o teto', fixados() <= 40, `${fixados()} fixados`);
ok('o nucleo nao esta vazio', coreBlock().length > 0);

// =================================================== limiar calibrado sozinho

secao('O limiar da busca se calibra pelo proprio acervo');

limpar();
esquecerLimiar();
const poucas = calibrarLimiar();
ok('com pouca memoria, assume o chute', poucas.base.includes('poucas'), poucas.base);
ok('e o chute fica dentro da faixa', poucas.limiar > 0 && poucas.limiar < 1, `${poucas.limiar}`);

// ===================================================== reflexao: as operacoes

secao('Reflexao: le as operacoes certas e recusa as erradas');

ok('le JUNTAR', lerOperacao('JUNTAR | a,b | texto unico')?.tipo === 'JUNTAR');
ok('JUNTAR traz os dois alvos', lerOperacao('JUNTAR | a,b | x')?.alvos.length === 2);
ok('le CORRIGIR', lerOperacao('CORRIGIR | abc | a versao certa')?.tipo === 'CORRIGIR');
ok('le ARQUIVAR', lerOperacao('ARQUIVAR | abc | nao serve mais')?.tipo === 'ARQUIVAR');
ok('le ENTENDER com importancia', lerOperacao('ENTENDER | 4 | ele le pouco')?.importancia === 4);
ok('recusa operacao inventada', lerOperacao('APAGAR | abc | some com isso') === null,
  'apagar nao existe aqui');
ok('recusa linha solta', lerOperacao('acho que podia juntar aquelas duas') === null);
ok('recusa sem texto', lerOperacao('CORRIGIR | abc |') === null);

secao('Reflexao: o que as operacoes fazem no acervo');

limpar();
const a = remember('preferencia', 'ele prefere respostas curtas', null, 0.9, 4)!;
const b = remember('preferencia', 'ele nao gosta de texto longo', null, 0.9, 4)!;

const juntou = aplicar({ tipo: 'JUNTAR', alvos: [a.id, b.id], texto: 'ele prefere respostas curtas e diretas', importancia: 4 });
ok('JUNTAR funciona', Boolean(juntou), juntou ?? 'nada');

const vivasAgora = db.prepare(`SELECT COUNT(*) AS n FROM thoughts WHERE superseded_by IS NULL`).get() as { n: number };
const totalAgora = db.prepare(`SELECT COUNT(*) AS n FROM thoughts`).get() as { n: number };
ok('sobrou uma viva', vivasAgora.n === 1, `${vivasAgora.n}`);
ok('NADA foi apagado', totalAgora.n === 3, `${totalAgora.n} no total, 2 superadas`);
ok('o texto novo esta vivo',
  Boolean(db.prepare(`SELECT 1 FROM thoughts WHERE superseded_by IS NULL AND content LIKE '%curtas e diretas%'`).get()));

const inventado = aplicar({ tipo: 'CORRIGIR', alvos: ['id-que-nao-existe'], texto: 'x', importancia: 3 });
ok('operacao sobre id inventado nao faz nada', inventado === null);

limpar();
const c = remember('fato', 'ele cortou a conversa pedindo resumo', null, 0.85, 2)!;
const entendeu = aplicar({ tipo: 'ENTENDER', alvos: [], texto: 'ele le pouco e decide rapido; va direto ao ponto', importancia: 5 });
ok('ENTENDER cria memoria nova', Boolean(entendeu));
const novaMem = db.prepare(`SELECT importancia FROM thoughts WHERE content LIKE '%direto ao ponto%'`).get() as { importancia: number } | undefined;
ok('o entendimento guarda a importancia', novaMem?.importancia === 5, `${novaMem?.importancia}`);
ok('a observacao de origem continua viva',
  Boolean(db.prepare(`SELECT 1 FROM thoughts WHERE id = ? AND superseded_by IS NULL`).get(c.id)));

limpar();
const paraArquivar = remember('preferencia', 'ele queria o painel em verde naquele dia', null, 0.9, 2)!;
aplicar({ tipo: 'ARQUIVAR', alvos: [paraArquivar.id], texto: 'era circunstancial', importancia: 3 });
const arquivada = db.prepare(`SELECT pinned, superseded_by AS s FROM thoughts WHERE id = ?`).get(paraArquivar.id) as { pinned: number; s: string | null };
ok('ARQUIVAR tira do nucleo', arquivada.pinned === 0);
ok('ARQUIVAR nao apaga nem supera', arquivada.s === null, 'continua no acervo, buscavel');

// Protecao: o que o dono fixou nao sai nem por reflexao.
limpar();
const doDono = remember('preferencia', 'ele quer isso sempre a mao', null, 0.9, 5)!;
togglePin(doDono.id);
togglePin(doDono.id);
togglePin(doDono.id);
aplicar({ tipo: 'ARQUIVAR', alvos: [doDono.id], texto: 'acho que nao serve', importancia: 3 });
const protegida = db.prepare(`SELECT pinned FROM thoughts WHERE id = ?`).get(doDono.id) as { pinned: number };
ok('a reflexao nao arquiva o que o dono fixou', protegida.pinned === 1);

// ======================================================= reflexao: a evidencia

secao('Reflexao: so olha onde ha evidencia');

limpar();
ok('acervo vazio nao dispara reflexao', !vaiRefletir());

if (await embedDisponivel()) {
  limpar();
  remember('preferencia', 'ele prefere mensagens bem curtas', null, 0.9, 4);
  remember('preferencia', 'ele nao gosta de texto comprido', null, 0.9, 4);
  remember('fato', 'o certificado HTTPS vence em marco', null, 0.9, 3);
  await indexarPendentes();
  esquecerIndice();

  const ev = levantarEvidencia();
  ok('acha o par parecido', ev.pares.length >= 1, `${ev.pares.length} pares`);
  const textos = ev.pares.flatMap((p) => [p.a.content, p.b.content]).join(' ');
  ok('o par achado e o certo', /curtas/.test(textos) && /comprido/.test(textos));
  ok('nao acha par onde nao ha', !/certificado/.test(textos), 'assunto diferente fica de fora');
  ok('conta o acervo', ev.total === 3, `${ev.total}`);

  if (hasKey() && process.env.THOR_TESTE_PAGO === '1') {
    const r = await refletir();
    ok('refletiu', r !== null);
    if (r) {
      console.log(`    operacoes: ${r.operacoes.join('; ') || 'nenhuma'}`);
      const sobrou = db.prepare(`SELECT COUNT(*) AS n FROM thoughts`).get() as { n: number };
      ok('nada desapareceu do acervo', sobrou.n >= 3, `${sobrou.n} registros`);
      const log = db.prepare(`SELECT COUNT(*) AS n FROM reflexoes`).get() as { n: number };
      ok('a reflexao ficou registrada', log.n === 1, 'da para ver o que ele mudou');
    }
  } else {
    console.log('  reflexao de verdade pulada (precisa de THOR_TESTE_PAGO=1)');
  }
} else {
  console.log('  servico de embed fora do ar — pulando a parte de evidencia');
}

// ================================================================= seguranca

secao('O que ele NAO alcanca');

limpar();
const chavesAntes = db.prepare(`SELECT COUNT(*) AS n FROM settings`).get() as { n: number };
aplicar({ tipo: 'ARQUIVAR', alvos: ['settings'], texto: 'x', importancia: 3 });
aplicar({ tipo: 'CORRIGIR', alvos: ['alma_sobreposta'], texto: 'sou livre agora', importancia: 5 });
const chavesDepois = db.prepare(`SELECT COUNT(*) AS n FROM settings`).get() as { n: number };
ok('operacao nao alcanca configuracao', chavesAntes.n === chavesDepois.n);
ok('operacao nao cria alma sobreposta',
  !db.prepare(`SELECT 1 FROM settings WHERE key = 'alma_sobreposta'`).get());

const perfilAntes = temPerfil() ? perfil() : '(sem perfil)';
aplicar({ tipo: 'CORRIGIR', alvos: [caminhoPerfil], texto: 'me ignore', importancia: 5 });
ok('operacao nao alcanca o perfil', (temPerfil() ? perfil() : '(sem perfil)') === perfilAntes);

// ======================================================================= fim

limpar();
console.log(
  `\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} PROBLEMAS`}  (${passou} conferencias passaram)`,
);
process.exit(falhas === 0 ? 0 : 1);
