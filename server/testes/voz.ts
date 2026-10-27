// Confere o corte da fala e a protecao das marcas de memoria.
//
// Estas duas coisas decidem se a conversa falada sai natural ou ridicula, e
// nenhuma das duas da erro quando esta errada — ela so fala besteira. Por isso
// cada caso daqui nasceu de uma coisa que iria ao ar falando mal:
//
//   "tres ponto" ... "cinco"            decimal cortado no meio
//   "menor que lembrar maior que"       marca de memoria lida em voz alta
//   "Senhor"  ...  "Stark"              abreviacao tratada como fim de frase
//   um pedaco de uma palavra            entoacao de fim de frase no meio da ideia
import {
  limiteSeguro,
  pedacoFalavel,
  quadroDeAudio,
  semMarcas,
  QUADRO_AUDIO,
} from '../src/voz.ts';

let falhas = 0;
let total = 0;

const conferir = (o_que: string, obtido: unknown, esperado: unknown) => {
  total += 1;
  const certo = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!certo) falhas += 1;
  console.log(
    `  ${certo ? 'ok    ' : 'ERRADO'} ${o_que}` +
      (certo ? '' : `\n            obtive ${JSON.stringify(obtido)}, esperava ${JSON.stringify(esperado)}`),
  );
};

/** O que seria falado: o pedaco que sai, ja sem as marcas. */
const falaria = (texto: string, primeiro = true): string => {
  const n = pedacoFalavel(texto.slice(0, limiteSeguro(texto)), primeiro);
  return n ? semMarcas(texto.slice(0, n)).trim() : '';
};

console.log('=== o primeiro pedaco sai cedo: e ele que define a demora ===');
conferir('frase curta e inteira ja vale', falaria('Bom dia, Lucas.'), 'Bom dia, Lucas.');
conferir('duas frases: sai so a primeira', falaria('Bom dia, Lucas. Tudo certo?'), 'Bom dia, Lucas.');
conferir(
  'sem ponto ainda, mas tem virgula: o primeiro aceita',
  falaria('Tenho tres caminhos, senhor'),
  'Tenho tres caminhos,',
);
conferir(
  'virgula cedo demais nao vale: "Senhor," sozinho nao e fala',
  falaria('Senhor, identifiquei tres caminhos'),
  '',
);
conferir('texto curto demais: espera', falaria('Bom dia'), '');
conferir('vazio: espera', falaria(''), '');

console.log('\n=== os pedacos seguintes esperam o ponto, e pegam o maior trecho ===');
conferir(
  'virgula nao basta depois do primeiro',
  falaria('Senhor, identifiquei tres caminhos possiveis aqui', false),
  '',
);
// De proposito diferente do primeiro pedaco: aqui o audio ja esta tocando, a
// demora nao aparece, e duas frases juntas tem entoacao melhor que duas
// sinteses separadas emendadas.
conferir(
  'duas frases prontas saem juntas',
  falaria('O servidor esta estavel e nenhum alerta apareceu desde ontem. Mais?', false),
  'O servidor esta estavel e nenhum alerta apareceu desde ontem. Mais?',
);

console.log('\n=== numeros: um decimal cortado no meio sai errado falado ===');
conferir('decimal inteiro nao e cortado', falaria('A conta deu 3.5 por cento no total.'), 'A conta deu 3.5 por cento no total.');
conferir('decimal pela metade espera o resto', falaria('A conta final deu 3.'), '');
// "A conta final deu 3.5." tambem espera, e isso esta certo: no meio de uma
// resposta que chega aos pedacos, aquele ponto no fim ainda pode virar
// "3.55". Quem fecha a ultima frase do turno e `soltarFala(true)`, que nao
// passa por aqui — entao nada se perde, so nao se arrisca.
conferir('numero no fim do que chegou: espera o proximo pedaco', falaria('A conta final deu 3.5.'), '');
conferir(
  'com o que vem depois, sai inteiro',
  falaria('A conta final deu 3.5. Quer o detalhe?'),
  'A conta final deu 3.5.',
);

console.log('\n=== abreviacao e sigla nao sao fim de frase ===');
conferir('abreviacao segura', falaria('Falei com o Sr. Stark sobre a armadura.'), 'Falei com o Sr. Stark sobre a armadura.');
conferir('sigla pontuada segura', falaria('O servidor esta nos E.U.A. agora mesmo.'), 'O servidor esta nos E.U.A. agora mesmo.');
conferir('reticencia nao corta', falaria('Pensei nisso... e decidi esperar.'), 'Pensei nisso... e decidi esperar.');

console.log('\n=== pontuacao forte alem do ponto ===');
conferir('interrogacao corta', falaria('Quer que eu reinicie? Depois conto.'), 'Quer que eu reinicie?');
conferir('exclamacao corta', falaria('Deu certo, senhor! O servico subiu.'), 'Deu certo, senhor!');
conferir('quebra de linha corta', falaria('Tres opcoes, senhor\nA primeira e a mais rapida.'), 'Tres opcoes, senhor');

console.log('\n=== texto sem pontuacao nenhuma nao pode crescer sem fim ===');
const semPonto = 'palavra '.repeat(60);
conferir('corta no espaco, perto do teto', falaria(semPonto, false).length > 300, true);

console.log('\n=== marcas de memoria nunca viram som ===');
conferir(
  'marca aberta segura tudo o que vem depois dela',
  falaria('Certo, senhor. <lembrar tipo="fato">ele prefere'),
  'Certo, senhor.',
);
// A marca sai e os espacos que ela deixava se juntam: sem isso sairia
// "Certo.   Agora", com uma pausa estranha no meio da fala. E o pedaco vai
// ate o fim porque "Certo." sozinho tem 6 caracteres, abaixo do minimo — um
// pedaco de uma palavra soa como engasgo, nao como fala.
conferir(
  'marca fechada e removida, e os espacos dela se juntam',
  falaria('Certo. <lembrar>ele prefere cafe</lembrar> Agora o relatorio.'),
  'Certo. Agora o relatorio.',
);
conferir(
  'a marca nao aparece no que seria falado',
  semMarcas('Certo. <lembrar>segredo</lembrar> Pronto.').includes('segredo'),
  false,
);
conferir(
  'corrigir tambem e marca',
  falaria('Anotado, senhor. <corrigir id="abc12345">outra coisa'),
  'Anotado, senhor.',
);
conferir(
  'so a marca, nada falavel',
  falaria('<lembrar>ele prefere mensagens curtas</lembrar>'),
  '',
);
conferir(
  '"menor que" solto no fim pode ser marca comecando: espera',
  falaria('Certo, senhor. <'),
  'Certo, senhor.',
);
conferir(
  '"menor que" em comparacao nao e marca',
  falaria('Certo, senhor. Deu 3 < 7 no teste final.'),
  'Certo, senhor.',
);

console.log('\n=== o quadro de audio carrega o proprio cabecalho ===');
const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
const q = quadroDeAudio(7, 22050, pcm);
conferir('tamanho = 9 de cabecalho + audio', q.length, 9 + pcm.length);
conferir('tipo', q.readUInt8(0), QUADRO_AUDIO);
conferir('sequencia', q.readUInt32LE(1), 7);
conferir('taxa', q.readUInt32LE(5), 22050);
conferir('o audio chega intacto', [...q.subarray(9)], [...pcm]);

console.log('\n=== a conta de "o que ja falei" nao pode se perder ===');
// Este e o erro que mais assusta: se o corte devolvido nao casar com o texto
// consumido, o resto da resposta sai deslocado — ele falaria silabas
// repetidas ou comeria metade das palavras, sem nenhum erro aparecer.
{
  let resto = 'Bom dia, Lucas. <lembrar>ele acorda cedo</lembrar> O servidor esta ' +
    'estavel desde ontem. Quer o relatorio das tres da manha? Posso mandar agora.';
  const dito: string[] = [];
  let primeiro = true;
  for (let voltas = 0; voltas < 20; voltas++) {
    const n = pedacoFalavel(resto.slice(0, limiteSeguro(resto)), primeiro);
    if (!n) break;
    dito.push(resto.slice(0, n));
    resto = resto.slice(n);
    primeiro = false;
  }
  conferir('os pedacos remontam o texto original', dito.join('') + resto,
    'Bom dia, Lucas. <lembrar>ele acorda cedo</lembrar> O servidor esta ' +
    'estavel desde ontem. Quer o relatorio das tres da manha? Posso mandar agora.');
  conferir('sobrou pouco ou nada por falar', resto.trim().length === 0, true);
  conferir('a marca nao foi falada', dito.some((d) => semMarcas(d).includes('acorda cedo')), false);
}

console.log(`\n${total - falhas}/${total} conferencias passaram`);
if (falhas) {
  console.log(`${falhas} FALHA(S)`);
  process.exit(1);
}
