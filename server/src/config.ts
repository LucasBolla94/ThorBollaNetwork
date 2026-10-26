import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Carrega o .env num passo simples: KEY=valor por linha, # comenta.
// Variaveis de ambiente de verdade sempre ganham do arquivo.
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    // Arquivo existe mas nao da para ler (dono errado, permissao 600 e outro
    // usuario). Sem isto o processo morre com um stack trace de fs em vez de
    // dizer o que esta errado.
    console.warn(
      `Aviso: ${path} existe mas nao pode ser lido (${(err as NodeJS.ErrnoException).code}). ` +
        `Seguindo so com as variaveis de ambiente.`,
    );
    return;
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Le a variavel com o prefixo novo, aceitando o antigo.
 *
 * O agente mudou de nome e as variaveis acompanham, mas um servidor com `.env`
 * escrito antes da troca nao pode deixar de subir por causa disso. O fallback
 * sai quando nao houver mais `.env` antigo em lugar nenhum — e ate la ele e a
 * diferenca entre uma migracao e uma madrugada perdida.
 */
const env = (nome: string): string | undefined =>
  process.env[`THOR_${nome}`] ?? process.env[`LUK_${nome}`];

const ROOT = env('ROOT') ?? resolve(import.meta.dirname, '../..');
loadEnvFile(env('ENV') ?? resolve(ROOT, '.env'));

/**
 * Onde ficam os dados.
 *
 * Fica **fora** do diretorio do codigo de proposito: o deploy agora e
 * `git reset --hard`, que apaga o que nao esta versionado. Banco dentro do
 * repositorio seria banco apagado no primeiro deploy.
 */
const DADOS = env('DATA') ?? resolve(ROOT, 'data');

function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(
      `Falta a variavel ${key}. Defina em ${resolve(ROOT, '.env')} e reinicie o servico.`,
    );
  }
  return v;
}

export const config = {
  root: ROOT,
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  webDir: env('WEB_DIR') ?? resolve(ROOT, 'web'),
  dataDir: DADOS,
  dbPath: env('DB') ?? resolve(DADOS, 'thor.db'),

  // Segredo usado para assinar/derivar tokens de sessao.
  sessionSecret: required('SESSION_SECRET'),
  // Token de uso unico que libera a tela de primeiro acesso.
  setupToken: process.env.SETUP_TOKEN ?? '',

  // Em producao o Caddy termina o TLS e fala com a gente em HTTP local,
  // mas o cookie tem de sair marcado como Secure.
  secureCookies: (process.env.SECURE_COOKIES ?? 'true') !== 'false',
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),

  openrouterKey: process.env.OPENROUTER_API_KEY ?? '',
  model: process.env.LUK_MODEL ?? 'anthropic/claude-sonnet-5.5',
  siteName: process.env.LUK_SITE_NAME ?? 'Thor',
  publicUrl: process.env.LUK_PUBLIC_URL ?? 'https://bolla.network',
} as const;

export const hasLlm = (): boolean => config.openrouterKey.length > 0;
