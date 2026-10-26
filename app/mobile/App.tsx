import { useEffect, useState } from 'react';
import { SafeAreaView, StatusBar, StyleSheet, View } from 'react-native';
import { Conversa } from './src/Conversa';
import { Entrada } from './src/Entrada';
import { Reator } from './src/Reator';
import { esquecerToken, sessaoValida } from './src/servidor';
import { cor } from './src/tema';

// O app tem tres estados e nenhum roteador: conferindo, fora, dentro. Trazer
// uma biblioteca de navegacao para duas telas seria peso sem troco.
type Porta = 'conferindo' | 'fora' | 'dentro';

export default function App() {
  const [porta, setPorta] = useState<Porta>('conferindo');

  // A sessao vale meses e fica no Keychain, entao quase sempre ele ja entra
  // direto. Mas "tem token guardado" nao e o mesmo que "token ainda vale" —
  // por isso confere com o servidor antes de mostrar a conversa.
  useEffect(() => {
    let vivo = true;
    sessaoValida().then((vale) => {
      if (vivo) setPorta(vale ? 'dentro' : 'fora');
    });
    return () => {
      vivo = false;
    };
  }, []);

  const sair = async () => {
    await esquecerToken();
    setPorta('fora');
  };

  return (
    <SafeAreaView style={s.tela}>
      <StatusBar barStyle="light-content" />
      {porta === 'conferindo' && (
        <View style={s.meio}>
          <Reator estado="pensando" tamanho={118} />
        </View>
      )}
      {porta === 'fora' && <Entrada aoEntrar={() => setPorta('dentro')} />}
      {porta === 'dentro' && <Conversa aoSair={sair} />}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cor.fundo },
  meio: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
