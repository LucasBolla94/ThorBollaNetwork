import { config } from './config.ts';
import { userCount } from './auth.ts';
import { activeModel, hasKey } from './llm.ts';
import { embedDisponivel } from './embed.ts';
import { estatisticasDoIndice, indexarPendentes } from './memory.ts';
import { criarServidor, rotaDeSobra } from './http/servidor.ts';
import { rotas as rotasConta } from './rotas/conta.ts';
import { rotas as rotasConversas } from './rotas/conversas.ts';
import { rotas as rotasMemoria } from './rotas/memoria.ts';
import { rotas as rotasOperacao } from './rotas/operacao.ts';
import { rotas as rotasPersonalidade } from './rotas/personalidade.ts';
import { canal } from './agente/canal.ts';

// ===========================================================================
// A montagem.
//
// Este arquivo ja teve mil linhas e fazia tudo: criava o servidor, declarava
// trinta rotas, montava o prompt e rodava o laco do agente. Funcionava, e era
// exatamente o tipo de arquivo onde uma mudanca pequena exige ler tudo para
// ter certeza de que nao quebrou nada em outro canto.
//
// Agora cada grupo de rota e um plugin do Fastify, e aqui so se diz o que
// entra e em que ordem. A ordem importa num ponto: a rota de sobra vai por
// ultimo, porque ela e quem responde o que ninguem mais respondeu.
// ===========================================================================

const app = await criarServidor();

await app.register(rotasConta);
await app.register(rotasConversas);
await app.register(rotasMemoria);
await app.register(rotasOperacao);
await app.register(rotasPersonalidade);
await app.register(canal);

rotaDeSobra(app);

const endereco = await app.listen({ port: config.port, host: config.host });
app.log.info(
  `Thor no ar em ${endereco} — LLM ${hasKey() ? `ok (${activeModel()})` : 'SEM CHAVE'}, ` +
    `usuarios: ${userCount()}`,
);

// A busca por sentido so enxerga o que tem vetor. Pensamento guardado enquanto
// o servico de embed estava fora do ar fica sem vetor e, sem isto, ficaria
// invisivel em silencio para sempre. Roda no arranque e nao segura o servidor.
void (async () => {
  if (!(await embedDisponivel())) {
    app.log.warn('embed fora do ar — a busca por sentido fica desligada ate ele voltar');
    return;
  }
  let total = 0;
  for (;;) {
    const n = await indexarPendentes();
    if (n === 0) break;
    total += n;
  }
  const e = estatisticasDoIndice();
  app.log.info(
    `memoria: ${e.total} pensamentos, ${e.comVetor} com vetor, ${e.fixados} fixados` +
      (total ? ` (${total} indexados agora)` : ''),
  );
})();
