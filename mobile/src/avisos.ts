import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { chamar } from './servidor';

// ===========================================================================
// Avisos de aprovacao.
//
// **O que "rodar em segundo plano" quer dizer no iOS.**
//
// Nao existe app iOS que fique rodando sozinho esperando algo acontecer. A
// Apple suspende o app pouco depois de voce sair dele, e nenhuma configuracao
// muda isso. O que existe:
//
//   - **push**: o SERVIDOR empurra, o sistema operacional entrega, o app
//     acorda. E imediato, e e o unico mecanismo confiavel para "decidir em 2
//     minutos".
//   - **tarefa em segundo plano**: o iOS decide quando rodar, com base em
//     bateria, rede e seu habito de uso. Pode ser em 15 minutos, pode ser em
//     seis horas. Serve para sincronizar, nunca para avisar.
//
// Por isso o aviso de aprovacao e push. A tarefa em segundo plano existe aqui
// so como rede de seguranca: se um push se perder, na proxima vez que o iOS
// der uma janela o app confere se ficou pedido em aberto.
// ===========================================================================

/** Com o app aberto, o aviso aparece mesmo assim: decisao nao pode passar batido. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export type ResultadoRegistro =
  | { ok: true; token: string }
  | { ok: false; motivo: string };

export async function registrarParaAvisos(): Promise<ResultadoRegistro> {
  if (!Device.isDevice) {
    return { ok: false, motivo: 'simulador nao recebe aviso; precisa de aparelho de verdade' };
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('aprovacoes', {
      name: 'Aprovacoes',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#ffb347',
    });
  }

  const atual = await Notifications.getPermissionsAsync();
  let permitido = atual.granted;
  if (!permitido && atual.canAskAgain) {
    permitido = (await Notifications.requestPermissionsAsync()).granted;
  }
  if (!permitido) return { ok: false, motivo: 'voce nao autorizou avisos' };

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId || String(projectId).startsWith('PREENCHER')) {
    // Sem projeto no EAS nao ha como emitir token de push. Dizer isso claro
    // vale mais do que estourar uma excecao sem explicacao.
    return { ok: false, motivo: 'falta rodar "eas init" para o app ter identidade de push' };
  }

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    // O servidor guarda por aparelho. Trocar de telefone nao deve calar o aviso
    // no antigo sem que alguem perceba, entao a limpeza e por falha de entrega,
    // feita no servidor, e nao aqui.
    await chamar('/api/aparelhos', {
      metodo: 'POST',
      corpo: { token, plataforma: Platform.OS, nome: Device.deviceName ?? null },
    });
    return { ok: true, token };
  } catch (e: any) {
    return { ok: false, motivo: e?.message ?? 'nao consegui obter o token de push' };
  }
}

/** Chamado quando o usuario toca no aviso. */
export function aoTocarNoAviso(fn: (dados: any) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
    fn(resp.notification.request.content.data ?? {});
  });
  return () => sub.remove();
}

/** Limpa o contador no icone quando o app volta. */
export async function limparContador(): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(0);
  } catch {
    /* nem todo aparelho tem contador */
  }
}
