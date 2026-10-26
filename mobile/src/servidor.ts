import * as SecureStore from 'expo-secure-store';

// ===========================================================================
// A conversa com o servidor.
//
// A sessao e a mesma do site — um token aleatorio que o servidor guarda so
// como hash. A diferenca e o transporte: no site vai num cookie httpOnly, que
// o JavaScript da pagina nao le; aqui vai no cabecalho Authorization e fica
// guardado no **Keychain do iPhone**, nao em armazenamento comum.
//
// O websocket nao usa esse token. Ele usa um tiquete de 30 segundos, de uso
// unico, pedido na hora de conectar — porque a URL do websocket entra inteira
// no log do servidor, e um token que vale meses nao pode terminar escrito la.
// ===========================================================================

export const BASE = 'https://bolla.network';

const CHAVE = 'thor.sessao';

let memoria: string | null = null;

export async function guardarToken(token: string): Promise<void> {
  memoria = token;
  await SecureStore.setItemAsync(CHAVE, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function lerToken(): Promise<string | null> {
  if (memoria) return memoria;
  memoria = await SecureStore.getItemAsync(CHAVE);
  return memoria;
}

export async function esquecerToken(): Promise<void> {
  memoria = null;
  await SecureStore.deleteItemAsync(CHAVE);
}

export class ErroServidor extends Error {
  status: number;
  precisaConfirmar: boolean;
  constructor(mensagem: string, status: number, precisaConfirmar = false) {
    super(mensagem);
    this.name = 'ErroServidor';
    this.status = status;
    this.precisaConfirmar = precisaConfirmar;
  }
}

type Opcoes = { metodo?: string; corpo?: unknown; semToken?: boolean };

export async function chamar<T = any>(caminho: string, opcoes: Opcoes = {}): Promise<T> {
  const cabecalhos: Record<string, string> = { Accept: 'application/json' };
  if (opcoes.corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';

  if (!opcoes.semToken) {
    const token = await lerToken();
    if (token) cabecalhos.Authorization = `Bearer ${token}`;
  }

  const resposta = await fetch(`${BASE}${caminho}`, {
    method: opcoes.metodo ?? 'GET',
    headers: cabecalhos,
    body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
  });

  let dados: any = null;
  try {
    dados = await resposta.json();
  } catch {
    /* resposta sem corpo */
  }

  if (!resposta.ok) {
    throw new ErroServidor(
      dados?.error ?? `erro ${resposta.status}`,
      resposta.status,
      dados?.precisaConfirmar === true,
    );
  }
  return dados as T;
}

export async function entrar(email: string, senha: string): Promise<string> {
  const r = await chamar<{ token?: string }>('/api/auth/login', {
    metodo: 'POST',
    // `app: true` e o que faz o servidor devolver o token no corpo. Sem isso
    // ele so manda o cookie, que nao serve aqui.
    corpo: { email, password: senha, app: true },
    semToken: true,
  });
  if (!r.token) throw new ErroServidor('o servidor nao devolveu a sessao', 500);
  await guardarToken(r.token);
  return r.token;
}

export async function sessaoValida(): Promise<boolean> {
  if (!(await lerToken())) return false;
  try {
    await chamar('/api/state');
    return true;
  } catch (e) {
    if (e instanceof ErroServidor && e.status === 401) await esquecerToken();
    return false;
  }
}

/** Abre o websocket, trocando a sessao por um tiquete de uso unico. */
export async function abrirCanal(): Promise<WebSocket> {
  const { ticket } = await chamar<{ ticket: string }>('/api/ws-ticket');
  const url = `${BASE.replace('https', 'wss').replace('http', 'ws')}/ws?ticket=${encodeURIComponent(ticket)}`;
  return new WebSocket(url);
}
