import { db, newId, now } from './db.ts';

// ===========================================================================
// Empurrar o pedido de aprovacao para o celular.
//
// Por que isto existe: o cartao de autorizacao so aparecia para quem estivesse
// com a tela aberta. Um pedido que vence em 120 segundos sem avisar ninguem e
// um pedido que vai vencer — ou seja, o canal de aprovacao da §35 so vale de
// verdade quando ele alcanca o Lucas onde ele estiver.
//
// Vai pelo servico de push do Expo em vez de falar direto com a Apple. A
// diferenca pratica: a chave da APNs fica guardada no EAS e nao neste
// servidor. Um servidor a menos guardando credencial da Apple e um lugar a
// menos de onde ela pode vazar.
// ===========================================================================

const ENDERECO = 'https://exp.host/--/api/v2/push/send';

export type Aparelho = { id: string; token: string; plataforma: string; nome: string | null };

export function registrarAparelho(
  userId: string,
  token: string,
  plataforma: string,
  nome: string | null,
): void {
  // O token e a identidade do aparelho: se o mesmo token voltar, e o mesmo
  // aparelho, e so atualizamos quem e o dono e quando foi visto.
  db.prepare(
    `INSERT INTO aparelhos (id, user_id, token, plataforma, nome, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id,
                                      last_seen = excluded.last_seen,
                                      nome = excluded.nome`,
  ).run(newId(), userId, token, plataforma, nome, now(), now());
}

export function aparelhos(): Aparelho[] {
  return db
    .prepare(`SELECT id, token, plataforma, nome FROM aparelhos`)
    .all() as Aparelho[];
}

function esquecerAparelho(token: string, motivo: string): void {
  db.prepare(`DELETE FROM aparelhos WHERE token = ?`).run(token);
  console.warn(`[push] aparelho removido (${motivo})`);
}

/**
 * Manda o aviso. Nunca lanca: avisar e importante, mas nao a ponto de derrubar
 * o pedido de aprovacao se o push falhar — o cartao na tela continua valendo.
 */
export async function avisarAprovacao(id: string, comando: string): Promise<void> {
  const destinos = aparelhos();
  if (destinos.length === 0) return;

  const mensagens = destinos.map((a) => ({
    to: a.token,
    title: 'Thor quer sua autorizacao',
    // O comando cru no corpo do aviso, nao a justificativa do modelo. Mesma
    // regra do cartao: quem decide tem de ver o que vai rodar.
    body: comando.slice(0, 160),
    data: { tipo: 'aprovacao', id },
    sound: 'default',
    priority: 'high',
    // Vence em 2 minutos; aviso entregue depois disso so confunde.
    ttl: 120,
    interruptionLevel: 'time-sensitive',
  }));

  try {
    const resposta = await fetch(ENDERECO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(mensagens),
      signal: AbortSignal.timeout(8000),
    });
    const corpo: any = await resposta.json().catch(() => null);
    const itens: any[] = corpo?.data ?? [];

    // Token invalido nunca melhora sozinho: aparelho apagado, app desinstalado.
    // Guardar para sempre significa tentar e falhar em toda aprovacao futura.
    itens.forEach((item, i) => {
      if (item?.status !== 'error') return;
      const erro = item?.details?.error;
      if (erro === 'DeviceNotRegistered') esquecerAparelho(destinos[i].token, erro);
      else console.warn(`[push] falhou: ${item?.message ?? erro ?? 'motivo desconhecido'}`);
    });
  } catch (e: any) {
    console.warn(`[push] nao consegui avisar: ${e?.message ?? e}`);
  }
}
