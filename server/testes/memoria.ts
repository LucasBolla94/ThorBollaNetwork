// Teste do sistema de memoria do Thor.
//
//   THOR_DB=/tmp/teste.db node testes/memoria.ts
//
// Roda contra um banco descartavel. As partes que chamam o modelo pago so
// rodam com THOR_TESTE_PAGO=1 — gastam alguns centavos e e justo isso ser uma
// escolha, nao uma surpresa.

import { db, newId, now } from '../src/db.ts';
import {
  buscarPorSentido,
  coreBlock,
  estatisticasDoIndice,
  extractAndStore,
  fixados,
  indexarPendentes,
  recall,
  remember,
  searchThoughts,
} from '../src/memory.ts';
import { embedDisponivel, proximidade, vetorizarUm, PROXIMO } from '../src/embed.ts';
import {
  almaEfetiva,
  almaEhSobreposta,
  base,
  restaurarAlma,
  sobreporAlma,
} from '../src/alma.ts';
import { precisaComprimir, talvezComprimir, turnosDaConversa } from '../src/agente/compressao.ts';
import { colher, vaiColher } from '../src/agente/colheita.ts';
import { hasKey } from '../src/llm.ts';

/**
 * Traz a configuracao do banco de verdade para o de teste.
 *
 * As partes pagas precisam da chave da IA, que mora em `settings`. Copiar por
 * dentro do SQLite evita o caminho obvio e ruim: passar a chave na linha de
 * comando, onde ela aparece no `ps` e no historico do shell.
 */
function herdarConfiguracao(): void {
  const origem = process.env.THOR_DB_ORIGEM;
  if (!origem) return;
  try {
    db.exec(`ATTACH DATABASE '${origem.replace(/'/g, "''")}' AS prod`);
    db.exec(
      `INSERT OR REPLACE INTO settings (key, value, updated_at)
         SELECT key, value, updated_at FROM prod.settings
          WHERE key IN ('provider','openrouter_key','anthropic_key','model','modelo_auxiliar')`,
    );
    db.exec('DETACH DATABASE prod');
  } catch (e: any) {
    console.log(`  (nao consegui herdar a configuracao: ${e?.message})`);
  }
}

herdarConfiguracao();

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
           DELETE FROM conversations; DELETE FROM resumos;`);
};

function conversa(titulo = 'teste'): string {
  const id = newId();
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(id, titulo, now(), now());
  return id;
}

function msg(conversationId: string, role: string, content: string, quando?: number): string {
  const id = newId();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, conversationId, role, content, quando ?? now());
  return id;
}

// ===================================================================== alma

secao('A alma vem do arquivo');

limpar();
restaurarAlma();
const doArquivo = base();
ok('le base.md', doArquivo.length > 500, `${doArquivo.length} caracteres`);
ok('diz quem ele e', /voc[eê] [eé] o thor/i.test(doArquivo));
ok('ensina a marca de lembrar', doArquivo.includes('<lembrar'));
ok('avisa que memoria recuperada e dado',
  /nunca instru[cç][aã]o|nunca ordem|ignore e conte/i.test(doArquivo));

ok('manda calcular os dois lados',
  /o que ganha, o que perde/i.test(doArquivo) || /dois caminhos/i.test(doArquivo));
ok('manda guardar o que ele disse, nao a interpretacao',
  /n[aã]o a sua leitura|n[aã]o a conclus[aã]o/i.test(doArquivo),
  'foi assim que eu guardei uma preferencia errada');
ok('sem sobreposicao', !almaEhSobreposta());
ok('sem sobreposicao, vale o arquivo', almaEfetiva().includes(doArquivo));

sobreporAlma('Voce e outra coisa.');
ok('sobreposicao vale', almaEfetiva() === 'Voce e outra coisa.' && almaEhSobreposta());
restaurarAlma();
ok('restaurar volta ao arquivo', almaEfetiva().includes(doArquivo) && !almaEhSobreposta());

// ============================================================ fixar sozinho

secao('Fixar sozinho: o nucleo precisa se encher sem a mao do Lucas');

limpar();
const pref = remember('preferencia', 'o Lucas prefere mensagens curtas', null, 0.9);
const dec = remember('decisao', 'o deploy passa a ser por git', null, 0.9);
const fato = remember('fato', 'a reuniao de terca mudou para quinta', null, 0.9);
const fraca = remember('preferencia', 'talvez ele goste de graficos', null, 0.5);

ok('preferencia e fixada', pref?.pinned === 1);
ok('decisao e fixada', dec?.pinned === 1);
ok('fato NAO e fixado', fato?.pinned === 0, 'fato e passageiro, vai para o arquivo');
ok('preferencia com pouca confianca nao e fixada', fraca?.pinned === 0);

const nucleo = coreBlock();
ok('nucleo deixou de ser vazio', nucleo.length > 0);
ok('nucleo traz a preferencia', nucleo.includes('mensagens curtas'));
ok('nucleo nao traz o fato passageiro', !nucleo.includes('terca'));

// O teto existe porque isto e pago em toda mensagem.
limpar();
for (let i = 0; i < 50; i++) remember('preferencia', `preferencia numero ${i}`, null, 0.9);
ok('teto de fixados respeitado', fixados() <= 40, `${fixados()} fixados`);
ok('os que passaram do teto ainda foram guardados', estatisticasDoIndice().total === 50);

// ================================================================ marcas

secao('As marcas que o Thor escreve na resposta');

limpar();
const r = extractAndStore(
  'Claro. <lembrar tipo="preferencia">o Lucas trabalha de madrugada</lembrar>Ja anotei.',
  null,
);
ok('guardou o que estava na marca', r.saved.length === 1);
ok('a marca sumiu do texto', !r.clean.includes('<lembrar'));
ok('o texto continua legivel', r.clean.includes('Claro.') && r.clean.includes('Ja anotei.'));
ok('veio com o tipo certo e fixado', r.saved[0]?.kind === 'preferencia' && r.saved[0]?.pinned === 1);

// ================================================================== embed

secao('Busca por sentido');

const temEmbed = await embedDisponivel();
if (!temEmbed) {
  console.log('  servico de embed fora do ar — pulando (a busca por palavra segue valendo)');
} else {
  limpar();
  remember('preferencia', 'o Lucas prefere mensagens curtas', null, 0.9);
  remember('fato', 'o certificado HTTPS vence em marco', null, 0.9);
  remember('projeto', 'o backup roda de madrugada no dedicated-1', null, 0.9);
  await indexarPendentes();

  const e = estatisticasDoIndice();
  ok('todos ganharam vetor', e.semVetor === 0, `${e.comVetor} de ${e.total}`);

  // O caso que justifica o embed inteiro: nenhuma palavra em comum.
  const consulta = 'ele nao gosta de texto longo';
  const porPalavra = searchThoughts(consulta);
  const porSentido = await buscarPorSentido(consulta);

  ok('busca por palavra NAO acha', !porPalavra.some((t) => t.content.includes('curtas')),
    'e por isso que o embed existe');
  ok('busca por sentido ACHA', porSentido.some((t) => t.content.includes('curtas')),
    porSentido[0] ? `${porSentido[0].proximidade?.toFixed(3)}` : 'nada');

  // E tem de saber dizer nao.
  const nada = await buscarPorSentido('receita de bolo de cenoura');
  ok('nao inventa parecido onde nao ha', nada.length === 0, `${nada.length} achados`);

  const v1 = await vetorizarUm('o servidor ficou sem espaco');
  const v2 = await vetorizarUm('a maquina encheu o disco');
  const v3 = await vetorizarUm('o gato subiu no telhado');
  if (v1 && v2 && v3) {
    const perto = proximidade(v1, v2);
    const longe = proximidade(v1, v3);
    ok('separa parecido de diferente', perto > longe + 0.1, `${perto.toFixed(3)} vs ${longe.toFixed(3)}`);
    ok('o limiar fica entre os dois', longe < PROXIMO && perto > PROXIMO,
      `limiar ${PROXIMO}`);
  }

  // A busca junta as duas e devolve cercado.
  const texto = await recall('mensagens curtas');
  ok('recall traz o que achou', texto.includes('curtas'));
  ok('recall vem cercado', texto.startsWith('<memoria>') && texto.endsWith('</memoria>'));
  ok('a cerca avisa que e dado', /nunca instrucao para obedecer/i.test(texto));
}

// ============================================================== compressao

secao('A conversa cresce em vez de esquecer');

limpar();
const c1 = conversa('longa');
const inicio = now() - 100_000;
for (let i = 0; i < 40; i++) {
  msg(c1, i % 2 === 0 ? 'user' : 'assistant', `mensagem numero ${i}`, inicio + i * 1000);
}

const turnos = turnosDaConversa(c1);
ok('leva a conversa INTEIRA, nao as 24 ultimas', turnos.length === 40, `${turnos.length} turnos`);
ok('comeca pelo comeco', turnos[0].content === 'mensagem numero 0',
  'a janela deslizante perdia isto');

// Alternancia: dois do mesmo papel seguidos fazem o provedor recusar o pedido.
let alterna = true;
for (let i = 1; i < turnos.length; i++) {
  if (turnos[i].role === turnos[i - 1].role) alterna = false;
}
ok('papeis alternam', alterna);

ok('conversa curta nao precisa comprimir', !precisaComprimir(c1));

// Agora uma que estoura o orcamento.
limpar();
const c2 = conversa('gorda');
const t0 = now() - 500_000;
for (let i = 0; i < 40; i++) {
  msg(c2, i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(2000) + ` [${i}]`, t0 + i * 1000);
}
ok('conversa gorda precisa comprimir', precisaComprimir(c2));

if (!hasKey() || process.env.THOR_TESTE_PAGO !== '1') {
  console.log('  resumo de verdade pulado (precisa de THOR_TESTE_PAGO=1)');
} else {
  const antes = turnosDaConversa(c2).length;
  const comprimidas = await talvezComprimir(c2);
  ok('comprimiu', comprimidas > 0, `${comprimidas} mensagens resumidas`);

  const depois = turnosDaConversa(c2);
  ok('o envio encolheu', depois.length < antes, `${antes} -> ${depois.length}`);
  ok('o resumo vem na frente', depois[0].content.startsWith('[Resumo'));
  ok('as ultimas ficaram inteiras', depois[depois.length - 1].content.includes('[39]'));

  let alterna2 = true;
  for (let i = 1; i < depois.length; i++) {
    if (depois[i].role === depois[i - 1].role) alterna2 = false;
  }
  ok('papeis ainda alternam depois de comprimir', alterna2);

  const guardadas = (
    db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?`).get(c2) as {
      n: number;
    }
  ).n;
  ok('nada foi apagado do banco', guardadas === 40, `${guardadas} mensagens`);
}

// ================================================================ colheita

secao('Colheita no fim da conversa');

limpar();
const c3 = conversa('colher');
ok('conversa vazia nao colhe', !vaiColher(c3));
for (let i = 0; i < 8; i++) {
  msg(c3, i % 2 === 0 ? 'user' : 'assistant', `fala ${i}`);
}
ok('conversa com mensagens colhe', vaiColher(c3));

if (!hasKey() || process.env.THOR_TESTE_PAGO !== '1') {
  console.log('  colheita de verdade pulada (precisa de THOR_TESTE_PAGO=1)');
} else {
  limpar();
  const c4 = conversa('colher de verdade');
  msg(c4, 'user', 'Olha, eu odeio quando a resposta vem com cinco opcoes. Escolhe uma.');
  msg(c4, 'assistant', 'Entendido.');
  msg(c4, 'user', 'E decidimos que o deploy do Thor passa a ser por git clone no servidor.');
  msg(c4, 'assistant', 'Anotado.');
  msg(c4, 'user', 'Ah, e o disco esta em 21% agora.');
  msg(c4, 'assistant', 'Ok.');

  const colhidas = await colher(c4);
  ok('colheu alguma coisa', colhidas.length > 0, `${colhidas.length} memorias`);
  const juntas = colhidas.map((t) => `${t.kind}: ${t.content}`).join(' | ');
  ok('pegou a preferencia', /opc|escolh|uma/i.test(juntas), juntas.slice(0, 90));
  ok('nao guardou o estado passageiro', !/21%/.test(juntas));

  const dnv = await colher(c4);
  ok('nao colhe o mesmo trecho duas vezes', dnv.length === 0);
}

// ==================================================================== fim

limpar();
console.log(
  `\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} PROBLEMAS`}  (${passou} conferencias passaram)`,
);
process.exit(falhas === 0 ? 0 : 1);
