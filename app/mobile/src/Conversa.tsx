import { useCallback, useEffect, useRef, useState } from 'react';
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
import { CartaoAprovacao, type Pedido } from './CartaoAprovacao';
import { Reator, type Estado } from './Reator';
import { abrirCanal, esquecerToken } from './servidor';
import { cor, mono, rotulo } from './tema';

// ===========================================================================
// A conversa.
//
// O websocket e a mesma porta que o site usa, e os eventos sao os mesmos. Isso
// e de proposito: duas telas falando dialetos diferentes com o mesmo servidor
// viram duas verdades sobre o que o Thor esta fazendo.
//
// A reconexao tem espera crescente. Celular troca de rede o tempo todo — do
// wifi para o 4G, do elevador para a rua — e um app que tenta reconectar sem
// parar gasta bateria sem resolver nada.
// ===========================================================================

type Item =
  | { tipo: 'msg'; id: string; papel: 'eu' | 'ele'; texto: string }
  | { tipo: 'ferramenta'; id: string; texto: string }
  | { tipo: 'aprovacao'; id: string; pedido: Pedido }
  | { tipo: 'aviso'; id: string; texto: string };

let contador = 0;
const novoId = () => `i${++contador}`;

/**
 * Esconde as marcas de memoria enquanto o texto chega.
 *
 * O Thor escreve `<lembrar tipo="fato">...</lembrar>` no meio da resposta. O
 * servidor tira isso no fim, mas durante o streaming a marca aparece letra por
 * letra na tela — entao ela e removida aqui tambem, inclusive quando ainda
 * esta pela metade.
 */
const limpar = (s: string): string =>
  s
    .replace(/<lembrar[^>]*>[\s\S]*?<\/lembrar>/g, '')
    .replace(/<corrigir[^>]*>[\s\S]*?<\/corrigir>/g, '')
    .replace(/<(lembrar|corrigir)[^>]*>[\s\S]*$/g, '')
    .replace(/<\/?(lembrar|corrigir)[^>]*$/g, '');

export function Conversa({ aoSair }: { aoSair: () => void }) {
  const [itens, setItens] = useState<Item[]>([]);
  const [estado, setEstado] = useState<Estado>('dormindo');
  const [pulso, setPulso] = useState(0);
  const [texto, setTexto] = useState('');
  const [ligado, setLigado] = useState(false);
  const [respondendo, setRespondendo] = useState(false);

  const canal = useRef<WebSocket | null>(null);
  const conversaId = useRef<string | null>(null);
  const correndo = useRef<string | null>(null); // id do item que esta recebendo texto
  const buffer = useRef('');
  const rolagem = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const tentativas = useRef(0);
  const vivo = useRef(true);

  const acrescentar = useCallback((item: Item) => {
    setItens((atuais) => [...atuais, item]);
  }, []);

  const conectar = useCallback(async () => {
    if (!vivo.current) return;
    try {
      const ws = await abrirCanal();
      canal.current = ws;

      ws.onopen = () => {
        tentativas.current = 0;
        setLigado(true);
      };

      ws.onclose = () => {
        setLigado(false);
        setRespondendo(false);
        setEstado('dormindo');
        if (!vivo.current) return;
        // Espera crescente, teto de 20s.
        const espera = Math.min(1000 * 2 ** tentativas.current, 20_000);
        tentativas.current += 1;
        setTimeout(conectar, espera);
      };

      ws.onmessage = (ev) => {
        let m: any;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        trata(m);
      };
    } catch (e: any) {
      setLigado(false);
      if (!vivo.current) return;
      // 401 aqui quer dizer sessao morta: pedir a senha de novo e o certo.
      if (e?.status === 401) {
        await esquecerToken();
        aoSair();
        return;
      }
      const espera = Math.min(1000 * 2 ** tentativas.current, 20_000);
      tentativas.current += 1;
      setTimeout(conectar, espera);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aoSair]);

  const trata = useCallback(
    (m: any) => {
      switch (m.t) {
        case 'ready':
          if (!m.hasLlm) {
            acrescentar({
              tipo: 'aviso',
              id: novoId(),
              texto: 'Falta a chave da IA no servidor. Abra o site, menu, Configuracao.',
            });
          }
          break;

        case 'conversation':
          conversaId.current = m.id;
          break;

        case 'start': {
          const id = novoId();
          correndo.current = id;
          buffer.current = '';
          setEstado('falando');
          acrescentar({ tipo: 'msg', id, papel: 'ele', texto: '' });
          break;
        }

        case 'tool':
          setEstado('pensando');
          acrescentar({
            tipo: 'ferramenta',
            id: novoId(),
            texto: m.query ? `procurando: ${m.query}` : 'consultando o servidor',
          });
          break;

        case 'delta': {
          buffer.current += m.text;
          const id = correndo.current;
          const limpo = limpar(buffer.current);
          setPulso((p) => p + 1);
          setItens((atuais) =>
            atuais.map((i) => (i.id === id && i.tipo === 'msg' ? { ...i, texto: limpo } : i)),
          );
          break;
        }

        case 'done': {
          const id = correndo.current;
          setItens((atuais) =>
            atuais.map((i) => (i.id === id && i.tipo === 'msg' ? { ...i, texto: m.content } : i)),
          );
          correndo.current = null;
          setRespondendo(false);
          setEstado('dormindo');
          break;
        }

        case 'aprovacao': {
          const p: Pedido = m.pedido;
          setEstado(p.estado === 'pendente' ? 'ouvindo' : 'falando');
          setItens((atuais) => {
            const i = atuais.findIndex((x) => x.tipo === 'aprovacao' && x.pedido.id === p.id);
            if (i === -1) return [...atuais, { tipo: 'aprovacao', id: novoId(), pedido: p }];
            const copia = [...atuais];
            copia[i] = { ...(copia[i] as any), pedido: p };
            return copia;
          });
          break;
        }

        case 'aborted':
          correndo.current = null;
          setRespondendo(false);
          setEstado('dormindo');
          break;

        case 'error':
          correndo.current = null;
          setRespondendo(false);
          setEstado('erro');
          setTimeout(() => setEstado('dormindo'), 2600);
          acrescentar({ tipo: 'aviso', id: novoId(), texto: m.message });
          break;
      }
    },
    [acrescentar],
  );

  useEffect(() => {
    vivo.current = true;
    conectar();
    return () => {
      vivo.current = false;
      canal.current?.close();
    };
  }, [conectar]);

  const enviar = () => {
    const t = texto.trim();
    if (!t || respondendo || canal.current?.readyState !== 1) return;
    acrescentar({ tipo: 'msg', id: novoId(), papel: 'eu', texto: t });
    canal.current.send(
      JSON.stringify({ t: 'chat', text: t, conversationId: conversaId.current }),
    );
    setTexto('');
    setRespondendo(true);
    setEstado('pensando');
  };

  const parar = () => {
    canal.current?.send(JSON.stringify({ t: 'stop' }));
  };

  const decidir = (id: string, aprovado: boolean) => {
    canal.current?.send(JSON.stringify({ t: 'decidir', id, aprovado }));
  };

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
    >
      <View style={s.cabecalho}>
        <Reator estado={estado} pulso={pulso} tamanho={40} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={s.titulo}>THOR</Text>
          <Text style={[rotulo, { color: ligado ? cor.textoApagado : cor.ambar }]}>
            {ligado ? 'ligado' : 'reconectando'}
          </Text>
        </View>
        <Pressable onPress={aoSair} hitSlop={12}>
          <Text style={[rotulo, { color: cor.textoApagado }]}>sair</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={rolagem}
        style={{ flex: 1 }}
        contentContainerStyle={s.fluxo}
        onContentSizeChange={() => rolagem.current?.scrollToEnd({ animated: true })}
        keyboardShouldPersistTaps="handled"
      >
        {itens.length === 0 && (
          <View style={s.vazio}>
            <Reator estado="dormindo" tamanho={118} />
            <Text style={[rotulo, { color: cor.textoApagado, marginTop: 22 }]}>
              pode falar
            </Text>
          </View>
        )}

        {itens.map((item) => {
          if (item.tipo === 'aprovacao') {
            return <CartaoAprovacao key={item.id} pedido={item.pedido} decidir={decidir} />;
          }
          if (item.tipo === 'ferramenta') {
            return (
              <Text key={item.id} style={s.ferramenta}>
                {item.texto}
              </Text>
            );
          }
          if (item.tipo === 'aviso') {
            return (
              <Text key={item.id} style={s.aviso}>
                {item.texto}
              </Text>
            );
          }
          const meu = item.papel === 'eu';
          return (
            <View key={item.id} style={[s.balao, meu ? s.meu : s.dele]}>
              <Text style={[rotulo, { color: meu ? cor.textoApagado : cor.hud, marginBottom: 5 }]}>
                {meu ? 'eu' : 'thor'}
              </Text>
              <Text style={s.corpo} selectable>
                {item.texto || ' '}
              </Text>
            </View>
          );
        })}
      </ScrollView>

      <View style={s.barra}>
        <TextInput
          style={s.entrada}
          value={texto}
          onChangeText={setTexto}
          placeholder="fala com ele..."
          placeholderTextColor={cor.textoApagado}
          selectionColor={cor.hud}
          multiline
          onSubmitEditing={enviar}
          blurOnSubmit={false}
        />
        {respondendo ? (
          <Pressable onPress={parar} style={[s.acao, { borderColor: cor.perigo }]}>
            <ActivityIndicator size="small" color={cor.perigo} />
          </Pressable>
        ) : (
          <Pressable
            onPress={enviar}
            disabled={!texto.trim() || !ligado}
            style={({ pressed }) => [
              s.acao,
              pressed && { backgroundColor: 'rgba(95,227,255,0.16)' },
              (!texto.trim() || !ligado) && { opacity: 0.35 },
            ]}
          >
            <Text style={[rotulo, { fontSize: 11, color: cor.hud }]}>ir</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cor.fundo },
  cabecalho: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: cor.linhaFraca,
  },
  titulo: { fontFamily: mono, fontSize: 15, letterSpacing: 4.5, color: cor.texto },
  fluxo: { padding: 16, paddingBottom: 24, flexGrow: 1 },
  vazio: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  balao: { marginVertical: 9 },
  meu: { alignSelf: 'flex-end', maxWidth: '88%', alignItems: 'flex-end' },
  dele: { alignSelf: 'flex-start', maxWidth: '96%' },
  corpo: { color: cor.texto, fontSize: 15.5, lineHeight: 23 },
  ferramenta: {
    ...rotulo,
    color: cor.textoApagado,
    marginVertical: 7,
    paddingLeft: 10,
    borderLeftWidth: 1,
    borderLeftColor: cor.hudEscuro,
  },
  aviso: {
    color: cor.ambar,
    fontFamily: mono,
    fontSize: 12.5,
    lineHeight: 19,
    borderWidth: 1,
    borderColor: 'rgba(255,179,71,0.35)',
    backgroundColor: 'rgba(255,179,71,0.07)',
    padding: 11,
    marginVertical: 9,
  },
  barra: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 9,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: cor.linhaFraca,
    backgroundColor: cor.fundo2,
  },
  entrada: {
    flex: 1,
    borderWidth: 1,
    borderColor: cor.linha,
    backgroundColor: 'rgba(0,0,0,0.35)',
    color: cor.texto,
    paddingHorizontal: 13,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 15.5,
    maxHeight: 130,
  },
  acao: {
    borderWidth: 1,
    borderColor: cor.hud,
    paddingHorizontal: 18,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
