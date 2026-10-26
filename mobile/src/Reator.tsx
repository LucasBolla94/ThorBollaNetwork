import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line, Path } from 'react-native-svg';
import { cor } from './tema';

// ===========================================================================
// O reator.
//
// A regra que veio do painel do site: **nada aqui e decoracao.** Cada anel
// mostra alguma coisa de verdade, e o estado muda o que gira e com que cor.
// Um anel que gira sempre igual, aconteca o que acontecer, e so enfeite — e
// enfeite num painel ensina a pessoa a ignorar o painel.
//
// Aqui no celular a telemetria e mais enxuta que no site: o que da para ler
// num circulo de 120px e o estado e a energia, entao e isso que ele mostra.
// ===========================================================================

export type Estado = 'dormindo' | 'ouvindo' | 'pensando' | 'falando' | 'erro';

const CORES: Record<Estado, string> = {
  dormindo: cor.hudEscuro,
  ouvindo: cor.ambar,
  pensando: cor.hud,
  falando: cor.hud,
  erro: cor.perigo,
};

/** Quanto tempo o anel leva para dar uma volta, por estado. Parado = sem giro. */
const GIRO: Record<Estado, number> = {
  dormindo: 0,
  ouvindo: 9000,
  pensando: 2600,
  falando: 5200,
  erro: 0,
};

const TICKS = 48;

type Props = { estado: Estado; pulso?: number; tamanho?: number };

export function Reator({ estado, pulso = 0, tamanho = 132 }: Props) {
  const giro = useRef(new Animated.Value(0)).current;
  const brilho = useRef(new Animated.Value(0)).current;
  const respiro = useRef(new Animated.Value(0)).current;

  // O giro recomeca quando o estado muda de velocidade.
  useEffect(() => {
    giro.setValue(0);
    if (!GIRO[estado]) return;
    const laco = Animated.loop(
      Animated.timing(giro, {
        toValue: 1,
        duration: GIRO[estado],
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    laco.start();
    return () => laco.stop();
  }, [estado, giro]);

  // Respiracao de fundo: existe para a tela nunca parecer congelada.
  useEffect(() => {
    const laco = Animated.loop(
      Animated.sequence([
        Animated.timing(respiro, { toValue: 1, duration: 2200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(respiro, { toValue: 0, duration: 2200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    laco.start();
    return () => laco.stop();
  }, [respiro]);

  // Cada pedaco de texto que chega acende o nucleo. E por isso que a luz
  // "pisca enquanto ele fala": nao e temporizador, e o texto chegando.
  useEffect(() => {
    if (!pulso) return;
    Animated.sequence([
      Animated.timing(brilho, { toValue: 1, duration: 90, useNativeDriver: true }),
      Animated.timing(brilho, { toValue: 0, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  }, [pulso, brilho]);

  const r = tamanho / 2;
  const tom = CORES[estado];

  const rotacao = giro.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const contraRotacao = giro.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-360deg'] });

  return (
    <View style={{ width: tamanho, height: tamanho, alignItems: 'center', justifyContent: 'center' }}>
      {/* Anel de marcacoes: gira devagar, no sentido do relogio. */}
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate: rotacao }] }]}>
        <Svg width={tamanho} height={tamanho}>
          <G>
            {Array.from({ length: TICKS }, (_, i) => {
              const ang = (i / TICKS) * Math.PI * 2;
              const grande = i % 6 === 0;
              const fora = r - 2;
              const dentro = r - (grande ? 10 : 6);
              return (
                <Line
                  key={i}
                  x1={r + Math.cos(ang) * fora}
                  y1={r + Math.sin(ang) * fora}
                  x2={r + Math.cos(ang) * dentro}
                  y2={r + Math.sin(ang) * dentro}
                  stroke={tom}
                  strokeWidth={grande ? 1.2 : 0.6}
                  opacity={grande ? 0.85 : 0.4}
                />
              );
            })}
          </G>
        </Svg>
      </Animated.View>

      {/* Arco: gira ao contrario, para os dois aneis nao virarem um so. */}
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate: contraRotacao }] }]}>
        <Svg width={tamanho} height={tamanho}>
          <Circle cx={r} cy={r} r={r - 18} stroke={tom} strokeWidth={0.5} opacity={0.3} fill="none" />
          <Path
            d={arco(r, r, r - 18, -40, 70)}
            stroke={tom}
            strokeWidth={1.6}
            fill="none"
            strokeLinecap="round"
          />
        </Svg>
      </Animated.View>

      {/* Nucleo: acende a cada pedaco de texto que chega. */}
      <Animated.View
        style={{
          position: 'absolute',
          width: tamanho * 0.34,
          height: tamanho * 0.34,
          borderRadius: tamanho,
          backgroundColor: tom,
          opacity: Animated.add(
            respiro.interpolate({ inputRange: [0, 1], outputRange: [0.26, 0.4] }),
            Animated.multiply(brilho, 0.6),
          ),
          transform: [
            { scale: Animated.add(1, Animated.multiply(brilho, 0.22)) },
          ],
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: tamanho * 0.17,
          height: tamanho * 0.17,
          borderRadius: tamanho,
          backgroundColor: tom,
        }}
      />
    </View>
  );
}

/** Caminho de um arco em SVG, em graus. */
function arco(cx: number, cy: number, raio: number, de: number, ate: number): string {
  const p = (g: number) => {
    const rad = (g * Math.PI) / 180;
    return [cx + raio * Math.cos(rad), cy + raio * Math.sin(rad)];
  };
  const [x1, y1] = p(de);
  const [x2, y2] = p(ate);
  const maior = ate - de > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${raio} ${raio} 0 ${maior} 1 ${x2} ${y2}`;
}
