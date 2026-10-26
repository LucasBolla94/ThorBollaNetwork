import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { cor, mono, rotulo } from './tema';

// ===========================================================================
// O cartao de autorizacao.
//
// A hierarquia e a mesma do site, e tambem aqui ela nao e estetica: **o
// comando cru em cima, grande; a frase do Thor embaixo, menor, rotulada
// "ele disse".**
//
// Se um dia ele ler uma pagina envenenada e pedir autorizacao com uma
// justificativa convincente, o que decide a aprovacao tem de ser o que vai
// rodar, nao a historia contada em volta. Por isso a justificativa nunca
// recebe destaque e nunca e formatada.
//
// No celular isso importa mais que no site: a tela e menor, a pessoa esta na
// rua, e a tentacao de so bater o olho no texto amigavel e maior.
// ===========================================================================

export type Pedido = {
  id: string;
  comando: string;
  justificativa: string;
  estado: 'pendente' | 'aprovado' | 'negado' | 'expirado';
  expiraEm: number;
};

const SELO: Record<string, string> = {
  aprovado: 'autorizado',
  negado: 'negado',
  expirado: 'venceu sem resposta',
};

const CORSELO: Record<string, string> = {
  aprovado: cor.ok,
  negado: cor.perigo,
  expirado: cor.textoApagado,
};

type Props = { pedido: Pedido; decidir: (id: string, aprovado: boolean) => void };

export function CartaoAprovacao({ pedido, decidir }: Props) {
  const pendente = pedido.estado === 'pendente';
  const [resta, setResta] = useState(() => segundos(pedido.expiraEm));
  const [enviado, setEnviado] = useState(false);

  useEffect(() => {
    if (!pendente) return;
    const t = setInterval(() => setResta(segundos(pedido.expiraEm)), 1000);
    return () => clearInterval(t);
  }, [pendente, pedido.expiraEm]);

  const urgente = resta <= 20;

  return (
    <View style={[e.cartao, !pendente && e.decidido]}>
      {pendente && (
        <View style={e.topo}>
          <Text style={[rotulo, { color: cor.ambar }]}>precisa da sua autorizacao</Text>
          <Text style={[e.tempo, urgente && { color: cor.perigo }]}>{resta}s</Text>
        </View>
      )}

      <View style={[e.caixaCmd, !pendente && { borderColor: cor.linhaFraca }]}>
        <Text style={[e.comando, !pendente && { color: cor.textoFraco }]} selectable>
          {pedido.comando}
        </Text>
      </View>

      <Text style={[rotulo, e.rotuloFala]}>ele disse</Text>
      <Text style={e.fala}>{pedido.justificativa || '(sem motivo)'}</Text>

      {pendente ? (
        <View style={e.botoes}>
          <Pressable
            disabled={enviado}
            onPress={() => { setEnviado(true); decidir(pedido.id, true); }}
            style={({ pressed }) => [e.botao, e.sim, pressed && e.simApertado, enviado && e.fraco]}
          >
            <Text style={[e.textoBotao, { color: cor.ok }]}>autorizar</Text>
          </Pressable>
          <Pressable
            disabled={enviado}
            onPress={() => { setEnviado(true); decidir(pedido.id, false); }}
            style={({ pressed }) => [e.botao, e.nao, pressed && e.naoApertado, enviado && e.fraco]}
          >
            <Text style={[e.textoBotao, { color: cor.perigo }]}>negar</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={[rotulo, { color: CORSELO[pedido.estado] ?? cor.textoApagado, marginTop: 4 }]}>
          {SELO[pedido.estado] ?? pedido.estado}
        </Text>
      )}
    </View>
  );
}

const segundos = (ate: number) => Math.max(0, Math.round((ate - Date.now()) / 1000));

const e = StyleSheet.create({
  cartao: {
    borderWidth: 1,
    borderColor: 'rgba(255, 179, 71, 0.4)',
    backgroundColor: 'rgba(255, 179, 71, 0.06)',
    padding: 14,
    marginVertical: 10,
  },
  // Decidido nao some: o registro do que foi autorizado faz parte da conversa.
  decidido: {
    borderColor: cor.linha,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  topo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 11,
  },
  tempo: { fontFamily: mono, fontSize: 11, color: cor.textoApagado },
  caixaCmd: {
    borderWidth: 1,
    borderColor: 'rgba(255, 179, 71, 0.22)',
    backgroundColor: 'rgba(0,0,0,0.45)',
    padding: 11,
  },
  comando: { fontFamily: mono, fontSize: 13, lineHeight: 20, color: '#ffd79a' },
  rotuloFala: { color: cor.textoApagado, marginTop: 11, marginBottom: 3 },
  fala: { fontSize: 13.5, lineHeight: 20, color: cor.textoFraco },
  botoes: { flexDirection: 'row', gap: 8, marginTop: 13 },
  botao: { flex: 1, borderWidth: 1, paddingVertical: 11, alignItems: 'center' },
  sim: { borderColor: cor.ok },
  simApertado: { backgroundColor: 'rgba(94, 226, 160, 0.16)' },
  nao: { borderColor: cor.perigo },
  naoApertado: { backgroundColor: 'rgba(242, 96, 122, 0.14)' },
  fraco: { opacity: 0.4 },
  textoBotao: { ...rotulo, fontSize: 11 },
});
