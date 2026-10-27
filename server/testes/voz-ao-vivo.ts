// Mede a conversa falada com o servico de voz de verdade, no servidor.
//
//     node testes/voz-ao-vivo.ts
//
// O teste de unidade (testes/voz.ts) prova que o corte da fala esta certo.
// Este prova outra coisa, que nenhuma conferencia de funcao alcanca: **se da
// para conversar**. Duas perguntas, e as duas so tem resposta medindo:
//
//   quanto tempo ate ele comecar a falar?
//       E a demora que a pessoa sente. Tudo o que vem depois toca enquanto
//       ele ja esta falando e nao aparece.
//
//   a fala chega mais rapido do que e consumida?
//       Se a sintese ficar atras da reproducao, a fila seca e abre um buraco
//       no meio da frase. Isso nao da erro em lugar nenhum: so soa quebrado.
//
// A resposta simulada chega em pedacos com o ritmo de uma LLM de verdade,
// porque entregar o texto inteiro de uma vez mediria um caminho que nunca
// acontece — e justamente o que esconderia o buraco na fila.
import { falar, limiteSeguro, pedacoFalavel, semMarcas, taxaDaFala, vozDisponivel } from '../src/voz.ts';

const RESPOSTA =
  'Bom dia, senhor. O servidor esta estavel e nenhum alerta apareceu desde ontem. ' +
  'Olhei os tres servicos e todos responderam. <lembrar tipo="fato">ele confere o ' +
  'servidor de manha</lembrar> Identifiquei duas coisas que valem a sua atencao. ' +
  'A primeira: o disco passou de setenta por cento, e no ritmo atual enche em umas ' +
  'tres semanas. A segunda e menor, mas vale dizer: a copia de seguranca da noite ' +
  'levou o dobro do tempo de costume. Quer que eu comece pelo disco?';

// Uma LLM entrega uns 30 a 60 tokens por segundo. Em portugues, um token e
// perto de quatro caracteres — entao ~20 ms por pedaco de 4 letras e o ritmo
// de uma resposta real.
const MS_POR_PEDACO = 20;
const LETRAS_POR_PEDACO = 4;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

let falhas = 0;
const conferir = (o_que: string, ok: boolean, detalhe = '') => {
  if (!ok) falhas += 1;
  console.log(`  ${ok ? 'ok    ' : 'ERRADO'} ${o_que}${detalhe ? `   ${detalhe}` : ''}`);
};

if (!(await vozDisponivel())) {
  console.log('  o servico de voz nao respondeu — suba o thor-voz antes');
  process.exit(1);
}

const taxa = taxaDaFala();
console.log(`  servico no ar, voz a ${taxa} Hz`);
console.log(`  simulando uma resposta de ${RESPOSTA.length} letras, ` +
  `a ${Math.round((LETRAS_POR_PEDACO / MS_POR_PEDACO) * 1000)} letras por segundo\n`);

const comeco = Date.now();
let porFalar = '';
let primeiro = true;
let fila: Promise<void> = Promise.resolve();

type Pedaco = { texto: string; prontoEm: number; segundos: number; sinteseMs: number };
const pedacos: Pedaco[] = [];

const mandar = (trecho: string) => {
  fila = fila.then(async () => {
    const t0 = Date.now();
    const pcm = await falar(semMarcas(trecho));
    if (!pcm?.length) return;
    pedacos.push({
      texto: semMarcas(trecho).trim(),
      prontoEm: Date.now() - comeco,
      segundos: pcm.length / (taxa * 2),
      sinteseMs: Date.now() - t0,
    });
  });
};

const soltar = (acabou = false) => {
  for (;;) {
    const seguro = limiteSeguro(porFalar);
    const corte = acabou && seguro === porFalar.length
      ? porFalar.length
      : pedacoFalavel(porFalar.slice(0, seguro), primeiro);
    if (!corte) return;
    const trecho = porFalar.slice(0, corte);
    porFalar = porFalar.slice(corte);
    primeiro = false;
    if (semMarcas(trecho).trim()) mandar(trecho);
  }
};

for (let i = 0; i < RESPOSTA.length; i += LETRAS_POR_PEDACO) {
  porFalar += RESPOSTA.slice(i, i + LETRAS_POR_PEDACO);
  soltar();
  await dormir(MS_POR_PEDACO);
}
soltar(true);
await fila;

const fimDoTexto = Date.now() - comeco;

console.log('  pedacos falados, na ordem:');
for (const p of pedacos) {
  const curto = p.texto.length > 58 ? `${p.texto.slice(0, 55)}...` : p.texto;
  console.log(`    +${String(p.prontoEm).padStart(5)}ms  ${p.segundos.toFixed(1)}s de fala  ` +
    `(sintetizou em ${p.sinteseMs}ms)  ${curto}`);
}

const audioTotal = pedacos.reduce((s, p) => s + p.segundos, 0);
const sinteseTotal = pedacos.reduce((s, p) => s + p.sinteseMs, 0) / 1000;

console.log('\n  --- o que isso quer dizer ---');
conferir('ele falou alguma coisa', pedacos.length > 0);
if (!pedacos.length) process.exit(1);

const primeiraFala = pedacos[0].prontoEm;
conferir(
  'comeca a falar em menos de 1,5s depois da primeira letra',
  primeiraFala < 1500,
  `${primeiraFala}ms ate o primeiro som`,
);
conferir(
  'o primeiro pedaco e uma fala inteira, nao um fragmento',
  pedacos[0].segundos >= 0.7,
  `${pedacos[0].segundos.toFixed(1)}s: "${pedacos[0].texto}"`,
);

// **A conferencia que importa de verdade.** Cada pedaco tem de estar pronto
// antes de a fila chegar nele. Se ficar pronto depois, o audio ja acabou e
// abre um silencio no meio da frase.
// O relogio comeca no instante em que o primeiro pedaco fica pronto E ja
// soma a duracao dele: enquanto ele toca, o seguinte tem todo esse tempo para
// ficar pronto. Sem somar, o segundo pedaco sempre parecia atrasado, e a
// primeira versao desta conferencia acusou um buraco de 548 ms que nao existe.
let relogioDaFila = pedacos[0].prontoEm + pedacos[0].segundos * 1000;
let buracos = 0;
let piorBuraco = 0;
for (const p of pedacos.slice(1)) {
  if (p.prontoEm > relogioDaFila) {
    buracos += 1;
    piorBuraco = Math.max(piorBuraco, p.prontoEm - relogioDaFila);
    relogioDaFila = p.prontoEm;
  }
  relogioDaFila += p.segundos * 1000;
}
conferir('a fala nunca ficou esperando audio', buracos === 0,
  buracos ? `${buracos} buraco(s), o pior de ${piorBuraco}ms` : 'nenhum buraco');

conferir(
  'sintetizar e muito mais rapido que falar',
  audioTotal / sinteseTotal >= 4,
  `${(audioTotal / sinteseTotal).toFixed(1)}x tempo real ` +
    `(${audioTotal.toFixed(1)}s de fala em ${sinteseTotal.toFixed(1)}s)`,
);

const marcaFalada = pedacos.some((p) => /lembrar|corrigir|</.test(p.texto));
conferir('nenhuma marca de memoria virou som', !marcaFalada);

console.log(`\n  o texto inteiro levou ${(fimDoTexto / 1000).toFixed(1)}s para sair da LLM, ` +
  `e ${audioTotal.toFixed(1)}s de fala foram gerados.`);
console.log(`  ele comeca a falar ${primeiraFala}ms depois da primeira letra — ` +
  `${((fimDoTexto - primeiraFala) / 1000).toFixed(1)}s antes de a resposta terminar.`);

if (falhas) {
  console.log(`\n${falhas} FALHA(S)`);
  process.exit(1);
}
console.log('\n  passou: da para conversar.');
