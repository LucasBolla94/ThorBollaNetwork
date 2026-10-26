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

// O chat por WebSocket: recebe a mensagem, roda o laco do agente e vai
// mandando o texto conforme ele sai.

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

      socket.on('message', async (raw: Buffer) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return send({ t: 'error', message: 'mensagem invalida' });
        }

        if (msg.t === 'stop') {
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

        busy = true;
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

          const prompt = buildPrompt(conversationId);
          send({ t: 'start' });

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
      });

      send({ t: 'ready', model: activeModel(), hasLlm: hasKey(), stats: stats() });
    });
  });

  // Rotas desconhecidas que nao sao de API caem no index: o front e uma pagina
}
