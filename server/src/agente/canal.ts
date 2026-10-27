import type { FastifyInstance } from 'fastify';
import { db, newId, now } from '../db.ts';
import { SESSION_COOKIE, readSession, trocarTiquete } from '../auth.ts';
import {
  activeModel,
  hasKey,
  provider,
  streamChat,
  LlmError,
  type ToolCall,
  type Usage,
} from '../llm.ts';
import { extractAndStore, limparMarcas, stats } from '../memory.ts';
import { aoMudar, cancelarPendentes, decidir, pendentes } from '../aprovacao.ts';
import {
  MEMORY_TOOL,
  SHELL_TOOL,
  buildPrompt,
  fallbackTitle,
  improveTitle,
  runTool,
  saveMessage,
} from './conversa.ts';
import { colher } from './colheita.ts';
import { talvezComprimir } from './compressao.ts';
import { refletir, vaiRefletir } from './reflexao.ts';
import {
  perguntaAtual,
  precisaEntrevistar,
  responder,
  totalDePerguntas,
} from './entrevista.ts';
import {
  descartarEscuta,
  escutaNaNuvem,
  falar,
  fecharEscuta,
  limiteSeguro,
  ouvir,
  pedacoFalavel,
  podeEscutarNaNuvem,
  quadroDeAudio,
  sabeFalar,
  sabeOuvir,
  semMarcas,
  taxaDaFala,
  transcreverNaNuvem,
  vozDisponivel,
} from '../voz.ts';

// O chat por WebSocket: recebe a mensagem, roda o laco do agente e vai
// mandando o texto conforme ele sai.
//
// Pela mesma conexao passa a conversa falada. O audio do microfone chega como
// quadro BINARIO e a resposta falada volta como quadro binario; o resto segue
// sendo JSON. Uma conexao so, e nao duas, porque a autorizacao, o "parar" e a
// conversa em curso ja vivem aqui — abrir um segundo canal duplicaria os tres
// e criaria o problema de manter os dois de acordo.

export async function canal(app: FastifyInstance): Promise<void> {
  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (conn: any, req: any) => {
      const socket: any = conn?.socket ?? conn;
      // Site manda cookie; app manda tiquete de uso unico na URL.
      const session =
        readSession(req.cookies?.[SESSION_COOKIE]) ?? trocarTiquete(req.query?.ticket);

      const send = (obj: unknown): void => {
        if (socket.readyState === 1) socket.send(JSON.stringify(obj));
      };

      if (!session) {
        send({ t: 'error', message: 'Sessao expirada. Entre de novo.' });
        socket.close(4401, 'nao autenticado');
        return;
      }

      let busy = false;
      let aborter: AbortController | null = null;

      // Pedidos de autorizacao chegam por aqui, e tambem os que foram decididos
      // em outro aparelho — e por isso que isto escuta o registro em vez de
      // mandar direto no ponto onde o pedido nasce: o Lucas pode abrir o site no
      // celular e decidir ali, e esta aba precisa ver o cartao sair da tela.
      const pararDeOuvir = aoMudar((p) => send({ t: 'aprovacao', pedido: p }));
      socket.on('close', pararDeOuvir);

      // Quem entra no meio de um pedido em aberto precisa ve-lo.
      for (const p of pendentes()) send({ t: 'aprovacao', pedido: p });

      // --- a conversa falada ----------------------------------------------
      //
      // Uma sessao de escuta por conexao. O nome junta a sessao de login com o
      // relogio porque o Lucas pode ter o site aberto no celular e no
      // computador ao mesmo tempo: com o nome igual, o audio das duas abas
      // cairia na mesma fila e as frases se intercalariam.
      const sessaoVoz = `${session.id}-${Date.now().toString(36)}`;
      // Duas vontades separadas: mandar audio para o servidor ouvir, e receber
      // audio para ele falar. Quem escuta pelo navegador quer so a segunda.
      let querOuvir = false;
      let querFalar = false;
      // Em qual conversa a fala esta. Quem digita manda isto em cada mensagem;
      // quem fala, nao — entao a conexao guarda.
      let conversaAtual = '';
      // Sobe a cada turno. Audio sintetizado de um turno que o Lucas
      // interrompeu chega atrasado, e sem isto tocaria em cima do turno novo.
      let turno = 0;

      socket.on('close', () => {
        if (querOuvir) descartarEscuta(sessaoVoz);
      });

      const tratar = async (msg: any): Promise<void> => {
        // **Ouvir e falar sao independentes, e isso nao e detalhe.** Quando o
        // reconhecimento do proprio navegador faz a escuta, o servidor nao
        // recebe audio nenhum — mas continua tendo de FALAR. Com uma chave so
        // para as duas coisas, esse caminho nao existiria: ou tudo, ou nada.
        if (msg.t === 'voz') {
          if (msg.ligado === false) {
            if (querOuvir) descartarEscuta(sessaoVoz);
            querOuvir = false;
            querFalar = false;
            return send({ t: 'voz', ligado: false });
          }
          await vozDisponivel();
          // Quem pede so para falar (porque escuta no navegador) nao precisa
          // que a escuta do servidor esteja de pe.
          const pediuOuvir = msg.ouvir !== false;
          if (pediuOuvir && !sabeOuvir()) {
            return send({
              t: 'error',
              message: escutaNaNuvem() && !podeEscutarNaNuvem()
                ? 'Falta a chave de quem entende a fala. Cole em Configuracao, no menu ao lado.'
                : 'O servico de voz nao esta respondendo. Por texto continua funcionando.',
            });
          }
          querOuvir = pediuOuvir;
          querFalar = msg.falar !== false && sabeFalar();
          return send({
            t: 'voz',
            ligado: true,
            ouvindo: querOuvir,
            fala: querFalar,
            taxa: taxaDaFala(),
          });
        }

        if (msg.t === 'stop') {
          turno += 1;
          aborter?.abort();
          // Parar tem de alcancar o que estava so esperando resposta: cartao de
          // autorizacao ainda de pe seria um botao vivo de um turno abandonado.
          cancelarPendentes();
          return;
        }
        if (msg.t === 'decidir') {
          const id = String(msg.id ?? '');
          decidir(id, msg.aprovado === true);
          return;
        }
        if (msg.t !== 'chat') return;
        if (busy) return send({ t: 'error', message: 'ainda estou respondendo a anterior' });

        const text = String(msg.text ?? '').trim();
        if (!text) return;
        if (text.length > 32_000) {
          return send({ t: 'error', message: 'mensagem longa demais' });
        }

        // A primeira conversa de uma instalacao nova e a entrevista: o agente
        // se monta para quem instalou antes de servir. Fica aqui, antes do
        // laco normal, porque quem conduz e este codigo e nao o modelo — uma
        // pergunta por vez, na ordem, sem divagar.
        if (precisaEntrevistar()) {
          busy = true;
          try {
            const passo = await responder(text);
            send({ t: 'start' });
            send({ t: 'delta', text: passo.texto });
            send({
              t: 'done',
              id: newId(),
              conversationId: '',
              content: passo.texto,
              remembered: [],
              stats: stats(),
              entrevista: passo.tipo === 'pergunta'
                ? { numero: passo.numero, total: passo.total }
                : { concluida: true },
            });
          } catch (e: any) {
            app.log.error({ e }, 'entrevista falhou');
            send({ t: 'error', message: 'Nao consegui guardar sua resposta. Tente de novo.' });
          } finally {
            busy = false;
          }
          return;
        }

        busy = true;
        turno += 1;
        aborter = new AbortController();

        try {
          // Conversa nova, se for o caso.
          let conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : '';
          const exists =
            conversationId &&
            db.prepare(`SELECT 1 FROM conversations WHERE id = ?`).get(conversationId);

          if (!exists) {
            conversationId = newId();
            const title = fallbackTitle(text);
            db.prepare(
              `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
            ).run(conversationId, title, now(), now());
            send({ t: 'conversation', id: conversationId, title });
            improveTitle(conversationId, text).then((better) => {
              if (better) send({ t: 'title', id: conversationId, title: better });
            });
          }

          const userMsgId = saveMessage(conversationId, 'user', text);
          send({ t: 'saved', role: 'user', id: userMsgId, conversationId });
          // Quem fala nao digita o identificador da conversa: a conversa falada
          // precisa saber em qual delas esta, e e daqui que ela descobre.
          conversaAtual = conversationId;

          const prompt = buildPrompt(conversationId);
          send({ t: 'start' });

          // --- a fala, em pedacos --------------------------------------------
          //
          // Esperar a resposta inteira para comecar a falar poe uns tres
          // segundos de silencio no meio da conversa. Entao: conforme o texto
          // sai, corta no primeiro lugar onde a voz pausaria naturalmente e
          // manda sintetizar.
          //
          // A fila e uma corrente de promessas, nao um punhado de chamadas
          // soltas. Duas razoes: mantem a ordem das frases, e limita a uma
          // sintese por vez — que e o que o servico de voz faz de qualquer
          // jeito, porque o Piper nao e seguro para chamadas simultaneas.
          const meuTurno = turno;
          const vaiFalar = querFalar && sabeFalar();
          let porFalar = '';
          let primeiroPedaco = true;
          let sequencia = 0;
          let fila: Promise<void> = Promise.resolve();

          const mandarAudio = (trecho: string): void => {
            fila = fila.then(async () => {
              // Turno diferente = o Lucas interrompeu. O audio deste trecho
              // nao serve mais, e tocar seria falar sozinho por cima dele.
              if (turno !== meuTurno || socket.readyState !== 1) return;
              const pcm = await falar(semMarcas(trecho));
              if (!pcm?.length || turno !== meuTurno || socket.readyState !== 1) return;
              socket.send(quadroDeAudio(sequencia++, taxaDaFala(), pcm));
            });
          };

          const soltarFala = (acabou = false): void => {
            if (!vaiFalar) return;
            for (;;) {
              const seguro = limiteSeguro(porFalar);
              const sobrou = porFalar.slice(0, seguro);
              const corte =
                acabou && seguro === porFalar.length
                  ? porFalar.length
                  : pedacoFalavel(sobrou, primeiroPedaco);
              if (!corte) return;
              const trecho = porFalar.slice(0, corte);
              porFalar = porFalar.slice(corte);
              primeiroPedaco = false;
              if (semMarcas(trecho).trim()) mandarAudio(trecho);
            }
          };

          let full = '';
          let usage: Usage | null = null;
          let rounds = 0;

          // Laco do agente: o Thor pode pedir uma busca na memoria, ler o
          // resultado e continuar escrevendo. Teto baixo de proposito — cada
          // volta e uma requisicao paga, e precisar de mais de tres buscas
          // seguidas costuma ser pergunta mal formulada, nao teto apertado.
          while (rounds < 4) {
            rounds += 1;
            let calls: ToolCall[] | null = null;
            let roundText = '';

            for await (const ev of streamChat(prompt, {
              signal: aborter.signal,
              tools: [MEMORY_TOOL, SHELL_TOOL],
            })) {
              if (ev.type === 'text') {
                roundText += ev.text;
                full += ev.text;
                // As marcas de memoria sao removidas no fim; enquanto escreve, o
                // cliente esconde o que estiver dentro de uma marca em aberto.
                send({ t: 'delta', text: ev.text });
                porFalar += ev.text;
                soltarFala();
              } else if (ev.type === 'tools') {
                calls = ev.calls;
              } else if (ev.type === 'usage') {
                usage = ev.usage;
              }
            }

            if (!calls || calls.length === 0) break;

            prompt.turns.push({ role: 'assistant', content: roundText, toolCalls: calls });

            for (const call of calls) {
              let consulta = '';
              try {
                const a = JSON.parse(call.args || '{}');
                consulta = String(a.consulta ?? a.comando ?? '');
              } catch {
                /* argumento ilegivel vira mensagem de erro dentro do runTool */
              }
              send({ t: 'tool', name: call.name, query: consulta });
              prompt.turns.push({
                role: 'tool',
                toolCallId: call.id,
                content: await runTool(call.name, call.args),
              });
            }
          }

          // O que sobrou sem pontuacao no fim tambem tem de ser falado, senao
          // a ultima frase morre pela metade.
          soltarFala(true);
          if (vaiFalar) {
            // Nao segura o `done`: o texto chega na tela agora e o audio
            // continua descendo. Avisa quando a fala termina, para a tela
            // voltar a mostrar que esta ouvindo.
            void fila.then(() => {
              if (turno === meuTurno && socket.readyState === 1) send({ t: 'falou' });
            });
          }

          if (usage) {
            const total = usage.prompt || 1;
            const pct = Math.round((usage.cached / total) * 100);
            app.log.info(
              `[${provider()}] cache ${pct}% (${usage.cached}/${total} lidos, ` +
                `${usage.written} escritos) saida ${usage.completion} tokens, ${rounds} volta(s)`,
            );
          }

          // A mensagem entra ANTES dos pensamentos que apontam para ela.
          //
          // Cada pensamento guarda de qual mensagem nasceu, e o banco cobra
          // essa referencia. Na ordem inversa, o pensamento nascia apontando
          // para uma mensagem que ainda nao existia e o turno inteiro morria
          // com "FOREIGN KEY constraint failed".
          //
          // O erro estava aqui desde sempre e nunca aparecia: a memoria nunca
          // chegava a guardar nada, entao o caminho nao era percorrido. Fazer
          // a memoria funcionar foi o que o revelou.
          const assistantId = newId();
          const semMarcas = limparMarcas(full);
          db.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, model, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(assistantId, conversationId, 'assistant', semMarcas, activeModel(), now());
          const { clean, saved } = extractAndStore(full, assistantId);
          db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(
            now(),
            conversationId,
          );

          send({
            t: 'done',
            id: assistantId,
            conversationId,
            content: clean,
            remembered: saved,
            stats: stats(),
            usage,
          });

          // Depois de responder, nao antes: o Lucas ja tem o texto na tela e
          // estes dois sao trabalho de arrumacao. Se falharem, a conversa
          // seguiu igual — por isso nada aqui derruba o turno.
          void (async () => {
            try {
              const colhidas = await colher(conversationId);
              if (colhidas.length) send({ t: 'colheita', lembrou: colhidas, stats: stats() });

              const comprimidas = await talvezComprimir(conversationId);
              if (comprimidas) send({ t: 'comprimido', mensagens: comprimidas });

              // Por ultimo, e so de vez em quando: ele olha para a propria
              // memoria e a melhora. Junta o repetido, resolve contradicao, e
              // transforma varias observacoes num entendimento.
              if (vaiRefletir()) {
                const r = await refletir();
                if (r?.operacoes.length) {
                  app.log.info(`[reflexao] ${r.operacoes.join('; ')}`);
                  send({ t: 'refletiu', operacoes: r.operacoes, stats: stats() });
                }
              }
            } catch (e: any) {
              app.log.warn({ e }, 'arrumacao pos-resposta falhou');
            }
          })();
        } catch (err: any) {
          if (err?.name === 'AbortError') {
            send({ t: 'aborted' });
          } else {
            const message =
              err instanceof LlmError
                ? err.message
                : `Falhou aqui dentro: ${String(err?.message ?? err).slice(0, 300)}`;
            app.log.error({ err }, 'falha no chat');
            send({ t: 'error', message });
          }
        } finally {
          busy = false;
          aborter = null;
        }
      };

      // --- o microfone chegando -------------------------------------------
      //
      // Um pedaco de 64 ms, dezesseis vezes por segundo, enquanto o microfone
      // esta ligado. Quem decide se aquilo foi fala, e se a fala acabou, e o
      // servico de voz — aqui so se repassa e se age no que ele responder.
      let estavaFalando = false;
      let ultimaQueixa = 0;

      const aoAudio = async (pcm: Buffer): Promise<void> => {
        if (!querOuvir) return;
        const estado = await ouvir(sessaoVoz, pcm);

        if (!estado) {
          // Perder um pedaco nao e grave e acontece. Queixar-se a cada 64 ms
          // seria pior que o problema, entao no maximo uma vez por minuto.
          if (Date.now() - ultimaQueixa > 60_000) {
            ultimaQueixa = Date.now();
            send({ t: 'error', message: 'A voz parou de responder. Por texto continua.' });
          }
          return;
        }

        // Ele comecou a falar enquanto o Thor falava. Isso e interromper, e
        // interromper tem de ser instantaneo: o navegador cala a boca ao
        // receber `calar`, e o turno novo invalida o audio que ainda vier.
        if (estado.falando && busy) {
          turno += 1;
          aborter?.abort();
          cancelarPendentes();
          send({ t: 'calar' });
        }

        if (estado.falando !== estavaFalando) {
          estavaFalando = estado.falando;
          send({ t: 'ouvindo', falando: estado.falando });
        }

        if (!estado.parou) return;

        estavaFalando = false;
        // No modo nuvem o servico devolve o audio do turno, nao o texto: a
        // chave de quem transcreve vive aqui, junto das outras, e nao num
        // arquivo de ambiente de servico.
        let dito = (estado.texto ?? '').trim();
        if (!dito && estado.wav) {
          send({ t: 'ouvindo', falando: false, entendendo: true });
          dito = (await transcreverNaNuvem(Buffer.from(estado.wav, 'base64'))) ?? '';
          if (!dito) {
            send({
              t: 'error',
              message: 'Nao consegui entender o que voce falou. Tente de novo, ou escreva.',
            });
            return send({ t: 'ouvindo', falando: false });
          }
        }
        if (!dito) return send({ t: 'ouvindo', falando: false });
        send({ t: 'ouvi', texto: dito, segundos: estado.segundos });
        await tratar({ t: 'chat', text: dito, conversationId: conversaAtual });
      };

      // Quadro binario e audio do microfone; quadro de texto e JSON. Esta e a
      // unica distincao que o protocolo precisa, e o `ws` ja a entrega pronta.
      socket.on('message', async (raw: Buffer, binario: boolean) => {
        if (binario) {
          try {
            await aoAudio(raw);
          } catch (e: any) {
            app.log.warn({ e }, 'audio do microfone falhou');
          }
          return;
        }
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return send({ t: 'error', message: 'mensagem invalida' });
        }
        await tratar(msg);
      });

      send({
        t: 'ready',
        model: activeModel(),
        hasLlm: hasKey(),
        stats: stats(),
        // Numa instalacao nova a primeira pergunta ja vai junto, para a tela
        // nao abrir em branco esperando que a pessoa adivinhe o que dizer.
        entrevista: precisaEntrevistar()
          ? { pergunta: perguntaAtual(), total: totalDePerguntas }
          : null,
      });

      // Saber se a voz esta no ar e uma ida na rede, e o `ready` e o que
      // destrava a tela — nao pode esperar por isto. Vai logo depois, e o
      // botao do microfone so aparece quando a resposta chega.
      void vozDisponivel().then(() => {
        if (socket.readyState !== 1) return;
        send({
          t: 'voz',
          // As duas vao separadas porque o cliente decide com elas: se o
          // servidor nao ouve, o navegador pode ouvir no lugar dele e ainda
          // assim precisar que o servidor fale.
          ouve: sabeOuvir(),
          fala: sabeFalar(),
          disponivel: sabeOuvir() || sabeFalar(),
          // Quando o servico esta no ar mas falta a chave, a tela precisa
          // dizer isso em vez de so esconder o botao: senao o recurso parece
          // nao existir, e ele nunca descobre que falta um passo so.
          faltaChave: escutaNaNuvem() && !podeEscutarNaNuvem(),
        });
      });
    });
  });

  // Rotas desconhecidas que nao sao de API caem no index: o front e uma pagina
}
