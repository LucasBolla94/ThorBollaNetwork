import { db, newId, now } from './db.ts';

// ===========================================================================
// Aprovacao de acoes.
//
// Existe para resolver uma restricao que limitava o Thor a so consultar: sem um
// canal de aprovacao, comando que muda o mundo nao podia passar, porque nao
// havia a quem perguntar.
//
// Duas decisoes de desenho que vale explicar:
//
// 1. **Falha fechada.** Se ninguem responde, o pedido vence e e NEGADO. O
//    silencio nunca autoriza — nem por timeout, nem por queda de conexao.
//
// 2. **O cartao separa o fato da narrativa.** O comando cru aparece em
//    destaque; a justificativa que o modelo escreveu fica ao lado, rotulada
//    como fala dele. Se um dia ele ler uma pagina envenenada e inventar uma
//    desculpa convincente, quem decide ainda ve exatamente o que vai rodar.
// ===========================================================================

export type Estado = 'pendente' | 'aprovado' | 'negado' | 'expirado';

export type Pedido = {
  id: string;
  comando: string;
  justificativa: string;
  estado: Estado;
  createdAt: number;
  expiraEm: number;
};

/**
 * Quanto tempo um pedido fica de pe antes de vencer sozinho.
 *
 * Regulavel por ambiente porque o teste de vencimento e o mais importante da
 * suite — e com dois minutos ninguem o roda. Teste que ninguem roda nao
 * protege nada.
 */
const VALIDADE_MS = Number(process.env.LUK_APROVACAO_MS || 120_000);

/** Quem resolve a espera do laco do agente, por id de pedido. */
const aguardando = new Map<string, (estado: Estado) => void>();

/** Avisa a interface que um pedido nasceu ou mudou. */
type Ouvinte = (pedido: Pedido) => void;
const ouvintes = new Set<Ouvinte>();

export function aoMudar(fn: Ouvinte): () => void {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
}

const avisar = (p: Pedido) => {
  for (const fn of ouvintes) {
    try {
      fn(p);
    } catch {
      /* um ouvinte quebrado nao pode derrubar os outros */
    }
  }
};

function ler(id: string): Pedido | null {
  const r = db
    .prepare(
      `SELECT id, comando, justificativa, estado, created_at AS createdAt,
              expira_em AS expiraEm
         FROM aprovacoes WHERE id = ?`,
    )
    .get(id) as Pedido | undefined;
  return r ?? null;
}

/**
 * Cria o pedido e espera a decisao.
 *
 * Devolve o estado final. Nunca devolve 'pendente': ou alguem decidiu, ou
 * venceu — e vencido conta como negado.
 */
export function pedir(comando: string, justificativa: string): Promise<Estado> {
  const id = newId();
  const ts = now();
  const expiraEm = ts + VALIDADE_MS;

  db.prepare(
    `INSERT INTO aprovacoes (id, comando, justificativa, estado, created_at, expira_em)
     VALUES (?, ?, ?, 'pendente', ?, ?)`,
  ).run(id, comando, justificativa.slice(0, 500), ts, expiraEm);

  const pedido = ler(id)!;
  avisar(pedido);

  return new Promise<Estado>((resolve) => {
    const terminar = (estado: Estado) => {
      if (!aguardando.has(id)) return;
      aguardando.delete(id);
      clearTimeout(relogio);
      resolve(estado);
    };

    const relogio = setTimeout(() => {
      db.prepare(
        `UPDATE aprovacoes SET estado = 'expirado', decided_at = ?
          WHERE id = ? AND estado = 'pendente'`,
      ).run(now(), id);
      const p = ler(id);
      if (p) avisar(p);
      terminar('expirado');
    }, VALIDADE_MS);

    aguardando.set(id, terminar);
  });
}

function decidirEstado(id: string, estado: Estado): boolean {
  const atual = ler(id);
  if (!atual || atual.estado !== 'pendente') return false;

  db.prepare(
    `UPDATE aprovacoes SET estado = ?, decided_at = ? WHERE id = ? AND estado = 'pendente'`,
  ).run(estado, now(), id);

  const p = ler(id);
  if (p) avisar(p);

  aguardando.get(id)?.(estado);
  return true;
}

/** Registra a decisao. Devolve false se o pedido nao existe ou ja foi decidido. */
export const decidir = (id: string, aprovado: boolean): boolean =>
  decidirEstado(id, aprovado ? 'aprovado' : 'negado');

/**
 * Vence todo pedido em aberto. Usado quando o Lucas aperta parar.
 *
 * Sem isto, mandar parar deixava o cartao de pe: a volta do agente era
 * abandonada, mas o botao continuava ligado, e um "autorizar" clicado depois
 * rodaria o comando de um turno que ja tinha sido cancelado. Parar precisa
 * parar tudo, inclusive o que estava so esperando resposta.
 */
export function cancelarPendentes(): number {
  const abertos = pendentes();
  for (const p of abertos) decidirEstado(p.id, 'expirado');
  return abertos.length;
}

export function pendentes(): Pedido[] {
  return db
    .prepare(
      `SELECT id, comando, justificativa, estado, created_at AS createdAt,
              expira_em AS expiraEm
         FROM aprovacoes WHERE estado = 'pendente' AND expira_em > ?
         ORDER BY created_at`,
    )
    .all(now()) as Pedido[];
}

export function historicoAprovacoes(limite = 50): Pedido[] {
  return db
    .prepare(
      `SELECT id, comando, justificativa, estado, created_at AS createdAt,
              expira_em AS expiraEm
         FROM aprovacoes ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limite) as Pedido[];
}
