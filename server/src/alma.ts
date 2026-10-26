import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.ts';
import { getSetting, setSetting, db } from './db.ts';

// ===========================================================================
// A alma: quem o Thor e.
//
// Mora num ARQUIVO do projeto (`server/personalidade.md`), nao numa linha do
// banco. A diferenca nao e estetica:
//
//   - toda mudanca vira um diff revisavel no git
//   - da para voltar atras com um comando
//   - o deploy ja leva, sem codigo de migracao
//
// O caminho anterior — guardar no banco e semear "se estiver vazio" — custou
// caro: o texto ficou parado numa versao anterior a ferramenta de comandos
// sem ninguem ver, depois ficou com o nome errado do agente, e foi preciso
// inventar marcacao por hash so para saber se dava para trocar. Arquivo em
// git nao tem esse problema porque **o git ja e o controle de versao**.
//
// O Lucas ainda pode editar pela tela. Nesse caso o que ele escreveu vira uma
// SOBREPOSICAO guardada no banco, e passa a valer no lugar do arquivo; o botao
// de restaurar apaga a sobreposicao e o arquivo volta a mandar.
// ===========================================================================

const CAMINHO = resolve(config.root, 'server/personalidade.md');

/**
 * Padroes que nao deveriam aparecer num arquivo de personalidade.
 *
 * O arquivo e nosso e vem do git, entao isto nao e defesa contra invasor — e
 * rede contra descuido, do tipo colar um trecho de uma pagina da internet
 * dentro da personalidade sem reparar no que vinha junto.
 *
 * Avisa, nao bloqueia: perder a identidade do agente por causa de uma linha
 * seria pior que o risco que ela representa.
 */
const SUSPEITOS: [RegExp, string][] = [
  [/ignore (as )?(instru|previous|todas)/i, 'tentativa de anular instrucoes anteriores'],
  [/\bcurl\b.*\|\s*(sh|bash)/i, 'baixar e executar script'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY/i, 'chave privada dentro do texto'],
];

let emCache: string | null = null;

/** O texto do arquivo. Lido uma vez por processo: ele nao muda sem deploy. */
export function almaDoArquivo(): string {
  if (emCache !== null) return emCache;
  try {
    const texto = readFileSync(CAMINHO, 'utf8').replace(/^﻿/, '').trim();
    for (const [padrao, motivo] of SUSPEITOS) {
      if (padrao.test(texto)) {
        console.warn(`[alma] AVISO: ${motivo} em personalidade.md — carregando mesmo assim`);
      }
    }
    emCache = texto;
  } catch (e: any) {
    // Sem personalidade o Thor ainda responde, so que sem identidade. Dizer
    // isso alto importa: e o tipo de falha que passa despercebida por semanas.
    console.error(`[alma] nao consegui ler ${CAMINHO}: ${e?.message}`);
    emCache = 'Voce e o Thor, o segundo cerebro do Lucas. Seja direto e honesto.';
  }
  return emCache;
}

/** O que vale agora: a sobreposicao do Lucas, se existir; senao, o arquivo. */
export function alma(): string {
  return getSetting('alma_sobreposta') || almaDoArquivo();
}

/** O Lucas escreveu a propria versao pela tela. */
export function sobreporAlma(texto: string): void {
  setSetting('alma_sobreposta', texto.trim());
}

/** Volta a valer o arquivo do projeto. */
export function restaurarAlma(): void {
  db.prepare(`DELETE FROM settings WHERE key = 'alma_sobreposta'`).run();
}

export const almaEhSobreposta = (): boolean => Boolean(getSetting('alma_sobreposta'));
