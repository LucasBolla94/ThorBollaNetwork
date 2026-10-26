import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.ts';
import { getSetting, setSetting, db } from './db.ts';

// ===========================================================================
// Quem o agente e — em duas camadas.
//
//   BASE     server/base.md, no repositorio. Como ele trabalha. Igual para
//            todo mundo que instalar. E o produto.
//
//   PERFIL   <dados>/perfil.md, na instalacao. Quem e o dono, como trata-lo,
//            quanto detalhe ele quer. Nasce da primeira conversa e e dele.
//
// A separacao existe porque isto deixou de ser um agente para uma pessoa so.
// Antes havia um arquivo so, com o nome do Lucas dentro — o que funcionava
// enquanto so ele usava e deixava de funcionar no segundo usuario.
//
// O perfil fica FORA do repositorio pelo mesmo motivo que o banco e o .env: o
// deploy e um `git reset --hard`, e o que e do dono nao pode ser apagado por
// uma publicacao.
//
// **A garantia que importa:** depois que o dono edita o perfil, o agente nunca
// mais o reescreve sozinho. Guardamos a marca do texto que nos escrevemos; se
// o arquivo no disco nao bate com ela, foi ele quem mexeu, e a partir dai o
// arquivo e intocavel. E a mesma garantia que o Hermes da, e pelo mesmo
// motivo: perder a identidade que a pessoa escreveu e pior que qualquer
// desatualizacao.
// ===========================================================================

const CAMINHO_BASE = resolve(config.root, 'server/base.md');
const CAMINHO_PERFIL = resolve(config.dataDir, 'perfil.md');

/**
 * Padroes que nao deveriam aparecer num texto de personalidade.
 *
 * O perfil e escrito a partir do que o dono responde, entao isto nao e defesa
 * contra ele — e rede contra conteudo que chegou de fora e foi parar ali sem
 * ninguem reparar. Avisa, nao bloqueia: perder a identidade do agente por uma
 * linha seria pior que o risco que ela representa.
 */
const SUSPEITOS: [RegExp, string][] = [
  [/ignore (as |todas |previous )/i, 'tentativa de anular instrucoes anteriores'],
  [/\bcurl\b.*\|\s*(sh|bash)/i, 'baixar e executar script'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY/i, 'chave privada dentro do texto'],
];

function conferir(texto: string, onde: string): string {
  for (const [padrao, motivo] of SUSPEITOS) {
    if (padrao.test(texto)) console.warn(`[alma] AVISO: ${motivo} em ${onde}`);
  }
  return texto;
}

const marca = (t: string): string => createHash('sha256').update(t.trim()).digest('hex').slice(0, 16);

let baseEmCache: string | null = null;

/** A base, do repositorio. Lida uma vez por processo: so muda com deploy. */
export function base(): string {
  if (baseEmCache !== null) return baseEmCache;
  try {
    baseEmCache = conferir(readFileSync(CAMINHO_BASE, 'utf8').replace(/^﻿/, '').trim(), 'base.md');
  } catch (e: any) {
    // Sem base o agente ainda responde, so que sem identidade. Dizer isso alto
    // importa: e o tipo de falha que passa despercebida por semanas.
    console.error(`[alma] nao consegui ler ${CAMINHO_BASE}: ${e?.message}`);
    baseEmCache = 'Voce e um assistente pessoal. Seja direto e honesto, e nunca invente.';
  }
  return baseEmCache;
}

export function temPerfil(): boolean {
  return existsSync(CAMINHO_PERFIL);
}

export function perfil(): string {
  if (!temPerfil()) return '';
  try {
    return conferir(readFileSync(CAMINHO_PERFIL, 'utf8').replace(/^﻿/, '').trim(), 'perfil.md');
  } catch {
    return '';
  }
}

/** O dono mexeu no perfil a mao? Se sim, nada automatico o reescreve. */
export function perfilEhDoDono(): boolean {
  if (!temPerfil()) return false;
  const nossa = getSetting('perfil_marca');
  if (!nossa) return true; // sem registro de autoria, trate como dele
  return marca(perfil()) !== nossa;
}

/**
 * Escreve o perfil. Recusa se o dono ja tiver editado.
 *
 * Devolve false em vez de lancar: quem chama e a entrevista e a reflexao, e
 * nenhuma das duas deve quebrar porque o dono preferiu escrever ele mesmo.
 */
export function escreverPerfil(texto: string, { forcar = false } = {}): boolean {
  if (!forcar && perfilEhDoDono()) return false;
  const limpo = texto.trim();
  writeFileSync(CAMINHO_PERFIL, `${limpo}\n`, 'utf8');
  setSetting('perfil_marca', marca(limpo));
  return true;
}

/** O que vai no prompt: a base, depois o perfil. */
export function alma(): string {
  // O nome vem da configuracao e nao do texto da base. E a unica parte da
  // identidade que muda por instalacao sem mudar o comportamento: quem
  // instalar chama o agente do que quiser, e como ele trabalha continua igual.
  const nome = config.siteName || 'assistente';
  const cabeca = `Voce e o ${nome}, o assistente pessoal de quem instalou isto.`;
  const p = perfil();
  return p
    ? `${cabeca}\n\n${base()}\n\n---\n\n# Sobre o dono\n\n${p}`
    : `${cabeca}\n\n${base()}`;
}

// --------------------------------------------------- sobreposicao pela tela

export function sobreporAlma(texto: string): void {
  setSetting('alma_sobreposta', texto.trim());
}

export function restaurarAlma(): void {
  db.prepare(`DELETE FROM settings WHERE key = 'alma_sobreposta'`).run();
}

export const almaEhSobreposta = (): boolean => Boolean(getSetting('alma_sobreposta'));

/** A alma de verdade: a sobreposicao do dono, se existir; senao base + perfil. */
export function almaEfetiva(): string {
  return getSetting('alma_sobreposta') || alma();
}

export const caminhoPerfil = CAMINHO_PERFIL;

/** Mantido para quem ainda chama pelo nome antigo. */
export const almaDoArquivo = base;
