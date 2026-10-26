import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Reator } from './Reator';
import { entrar, ErroServidor } from './servidor';
import { cor, mono, rotulo } from './tema';

export function Entrada({ aoEntrar }: { aoEntrar: () => void }) {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState('');
  const [indo, setIndo] = useState(false);

  const enviar = async () => {
    if (!email.trim() || !senha || indo) return;
    setIndo(true);
    setErro('');
    try {
      await entrar(email.trim(), senha);
      aoEntrar();
    } catch (e) {
      // A mensagem do servidor ja e escrita para ser lida por gente; repetir
      // ela e melhor que inventar uma generica.
      setErro(e instanceof ErroServidor ? e.message : 'nao consegui falar com o servidor');
      setIndo(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={s.meio}
        keyboardShouldPersistTaps="handled"
      >
        <Reator estado={indo ? 'pensando' : 'dormindo'} tamanho={150} />

        <Text style={s.nome}>THOR</Text>
        <Text style={s.sub}>segundo cerebro</Text>

        <View style={s.campos}>
          <Text style={[rotulo, s.rotuloCampo]}>e-mail</Text>
          <TextInput
            style={s.campo}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            placeholder="voce@exemplo.com"
            placeholderTextColor={cor.textoApagado}
            selectionColor={cor.hud}
          />

          <Text style={[rotulo, s.rotuloCampo]}>senha</Text>
          <TextInput
            style={s.campo}
            value={senha}
            onChangeText={setSenha}
            secureTextEntry
            textContentType="password"
            placeholderTextColor={cor.textoApagado}
            selectionColor={cor.hud}
            onSubmitEditing={enviar}
            returnKeyType="go"
          />

          {!!erro && <Text style={s.erro}>{erro}</Text>}

          <Pressable
            onPress={enviar}
            disabled={indo}
            style={({ pressed }) => [s.botao, pressed && s.botaoApertado, indo && { opacity: 0.5 }]}
          >
            {indo ? (
              <ActivityIndicator color={cor.hud} />
            ) : (
              <Text style={s.textoBotao}>entrar</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cor.fundo },
  meio: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 28 },
  nome: {
    fontFamily: mono,
    fontSize: 26,
    letterSpacing: 9,
    color: cor.texto,
    marginTop: 26,
  },
  sub: { ...rotulo, color: cor.textoApagado, marginTop: 7 },
  campos: { width: '100%', maxWidth: 360, marginTop: 38 },
  rotuloCampo: { color: cor.textoApagado, marginBottom: 6, marginTop: 14 },
  campo: {
    borderWidth: 1,
    borderColor: cor.linha,
    backgroundColor: 'rgba(0,0,0,0.3)',
    color: cor.texto,
    paddingHorizontal: 13,
    paddingVertical: 13,
    fontSize: 15.5,
  },
  erro: {
    color: cor.perigo,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
    borderLeftWidth: 2,
    borderLeftColor: cor.perigo,
    paddingLeft: 10,
  },
  botao: {
    borderWidth: 1,
    borderColor: cor.hud,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 24,
  },
  botaoApertado: { backgroundColor: 'rgba(95, 227, 255, 0.14)' },
  textoBotao: { ...rotulo, fontSize: 12, color: cor.hud },
});
