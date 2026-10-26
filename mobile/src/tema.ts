import { Platform } from 'react-native';

// As mesmas cores do painel no site. Nao e so gosto: o Thor tem de parecer o
// mesmo em qualquer tela, e ciano significa "funcionando" nos dois lugares.
export const cor = {
  fundo: '#03060b',
  fundo2: '#060b14',
  linha: 'rgba(95, 227, 255, 0.18)',
  linhaFraca: 'rgba(95, 227, 255, 0.09)',

  texto: '#dff2fa',
  textoFraco: '#8fa9b8',
  textoApagado: '#52707f',

  hud: '#5fe3ff',
  hudEscuro: 'rgba(95, 227, 255, 0.35)',
  ambar: '#ffb347',
  perigo: '#f2607a',
  ok: '#5ee2a0',
};

/** Monoespacada de verdade, que no iOS nao e a mesma do Android. */
export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export const rotulo = {
  fontFamily: mono,
  fontSize: 9.5,
  letterSpacing: 1.4,
  textTransform: 'uppercase' as const,
};
