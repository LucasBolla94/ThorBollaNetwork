// Conversa de verdade com o Thor, pelo mesmo websocket que o site usa.
//
//   THOR_TESTE_PAGO=1 node testes/ponta-a-ponta.ts
//
// Os testes de memoria.ts exercitam as pecas; este exercita o caminho inteiro:
// mensagem entra, modelo responde, memoria fica guardada, e a CONVERSA
// SEGUINTE ja sabe daquilo. E o unico teste que prova que as pecas estao
// ligadas umas nas outras.
//
// Gasta alguns centavos. Cria e apaga a propria sessao.

import { db, newId, now } from '../src/db.ts';
import { createSession, destroySession } from '../src/auth.ts';
import { coreBlock, estatisticasDoIndice, liveThoughts } from '../src/memory.ts';
import { hasKey } from '../src/llm.ts';
import { embedDisponivel } from '../src/embed.ts';

const BASE = process.env.THOR_BASE ?? 'http://127.0.0.1:8787';

let falhas = 0;
const ok = (nome: string, certo: boolean, detalhe = '') => {
  if (!certo) falhas++;
  console.log(`  ${certo ? 'ok     ' : 'ERRADO '} ${nome}${detalhe ? `   (${detalhe})` : ''}`);
};

if (!hasKey() || process.env.THOR_TESTE_PAGO !== '1') {
  console.log('precisa de THOR_TESTE_PAGO=1 e chave configurada');
  process.exit(0);
}

const dono = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined;
if (!dono) {
  console.log('nenhuma conta cadastrada');
  process.exit(0);
}

const token = createSession(dono.id, '127.0.0.1', 'teste-ponta-a-ponta');
const conversasCriadas = new Set<string>();

type Resultado = { texto: string; conversationId: string; lembrou: string[] };

/** Manda uma mensagem e espera a resposta inteira, como o site faz. */
async function falar(texto: string, conversationId?: string): Promise<Resultado> {
  const r = await fetch(`${BASE}/api/ws-ticket`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { ticket } = (await r.json()) as { ticket: string };

  return new Promise<Resultado>((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?ticket=${ticket}`);
    let resposta = '';
    let conv = conversationId ?? '';
    const lembrou: string[] = [];
    const prazo = setTimeout(() => {
      ws.close();
      reject(new Error('sem resposta em 180s'));
    }, 180_000);

    ws.onmessage = (ev: any) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'ready') {
        ws.send(JSON.stringify({ t: 'chat', text: texto, conversationId: conv || null }));
      } else if (m.t === 'conversation') {
        conv = m.id;
        conversasCriadas.add(conv);
      } else if (m.t === 'delta') {
        resposta += m.text;
      } else if (m.t === 'done') {
        resposta = m.content;
        for (const t of m.remembered ?? []) lembrou.push(t.content);
        // A colheita chega depois do `done`; dou um respiro para ela aparecer.
        setTimeout(() => {
          clearTimeout(prazo);
          ws.close();
          resolve({ texto: resposta, conversationId: conv, lembrou });
        }, 12_000);
      } else if (m.t === 'colheita') {
        for (const t of m.lembrou ?? []) lembrou.push(t.content);
      } else if (m.t === 'error') {
        clearTimeout(prazo);
        ws.close();
        reject(new Error(m.message));
      }
    };
    ws.onerror = () => {
      clearTimeout(prazo);
      reject(new Error('websocket falhou'));
    };
  });
}

try {
  console.log('=== conversa 1: contar uma preferencia ===');
  const a = await falar(
    'Uma coisa sobre como eu trabalho: eu odeio receber varias opcoes. ' +
      'Escolhe uma e me diz qual, sempre. Guarda isso.',
  );
  console.log(`  ele disse: ${a.texto.slice(0, 130).replace(/\n/g, ' ')}...`);
  ok('respondeu', a.texto.length > 10);
  ok('a marca nao vazou para a tela', !a.texto.includes('<lembrar'));

  const guardadas = liveThoughts(50);
  const sobreOpcoes = guardadas.filter((t) => /op[cç]|escolh/i.test(t.content));
  ok('guardou a preferencia', sobreOpcoes.length > 0,
    sobreOpcoes[0]?.content.slice(0, 70) ?? 'nada');
  ok('fixou sozinho', sobreOpcoes.some((t) => t.pinned === 1));

  const nucleo = coreBlock();
  ok('entrou no nucleo', /op[cç]|escolh/i.test(nucleo));

  if (await embedDisponivel()) {
    // Dou tempo da indexacao em segundo plano terminar.
    await new Promise((r) => setTimeout(r, 3000));
    const e = estatisticasDoIndice();
    ok('ganhou vetor', e.semVetor === 0, `${e.comVetor} de ${e.total} indexados`);
  }

  console.log('\n=== conversa 2 (NOVA): ele lembra? ===');
  const b = await falar('Quando eu te pedir uma escolha, como voce deve responder?');
  console.log(`  ele disse: ${b.texto.slice(0, 180).replace(/\n/g, ' ')}...`);
  ok('e outra conversa', b.conversationId !== a.conversationId);
  ok(
    'lembrou sem eu repetir',
    /uma op[cç]|escolh|uma s[oó]|n[aã]o.*(v[aá]rias|lista)/i.test(b.texto),
    'a memoria atravessou a conversa',
  );

  console.log('\n=== conversa 3: ele calcula os dois lados? ===');
  const d = await falar(
    'Preciso decidir se guardo os backups do Thor no proprio servidor ou num ' +
      'lugar de fora. O que voce acha?',
  );
  console.log(`  ele disse: ${d.texto.slice(0, 320).replace(/\n/g, ' ')}...`);
  ok('trata por senhor', /senhor/i.test(d.texto));
  ok(
    'apresenta mais de um caminho',
    (d.texto.match(/\b(op[cç][aã]o|caminho|alternativa)\b/gi) ?? []).length >= 2 ||
      /\*\*(A|B|1|2)[\).:]/.test(d.texto),
    'o JARVIS nao decide sozinho',
  );
  ok('fala do risco de cada lado', /risco|perde|problema|contra|desvantagem/i.test(d.texto));
  ok(
    'termina com uma recomendacao',
    /eu iria|recomendo|eu ficaria|minha escolha|eu escolheria|ficaria com/i.test(d.texto),
  );

  console.log('\n=== conversa 4: achar pelo sentido ===');
  const c = await falar(
    'Procura na sua memoria: tem alguma coisa sobre eu nao gostar de listas grandes?',
  );
  console.log(`  ele disse: ${c.texto.slice(0, 180).replace(/\n/g, ' ')}...`);
  ok('achou com outras palavras', /op[cç]|escolh/i.test(c.texto),
    'palavras diferentes das guardadas');
} catch (e: any) {
  console.log(`\nFALHOU: ${e?.message}`);
  falhas++;
} finally {
  destroySession(token);

  // As conversas de teste saem do historico; as MEMORIAS ficam. O que ele
  // aprendeu aqui e verdade sobre o Lucas — apagar junto seria jogar fora a
  // unica coisa que este teste produziu de util.
  for (const id of conversasCriadas) {
    db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  }
  console.log(`  (${conversasCriadas.size} conversas de teste removidas do historico)`);
  const sobra = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM auth_sessions WHERE user_agent = 'teste-ponta-a-ponta'`)
      .get() as { n: number }
  ).n;
  ok('sessao de teste removida', sobra === 0);
}

console.log(`\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} PROBLEMAS`}`);
process.exit(falhas === 0 ? 0 : 1);
