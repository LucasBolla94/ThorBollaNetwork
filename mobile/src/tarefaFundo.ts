import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { chamar } from './servidor';

// ===========================================================================
// Rede de seguranca, nao o mecanismo principal.
//
// O aviso de aprovacao chega por push, que e imediato. Esta tarefa existe para
// o caso de um push se perder: quando o iOS resolver dar uma janela — e e ele
// quem decide, podendo ser em quinze minutos ou em seis horas — o app confere
// se ficou pedido em aberto e avisa localmente.
//
// Deixar isso claro importa porque e tentador achar que "tarefa em segundo
// plano" resolve o aviso. Nao resolve: um pedido vence em 120 segundos, e
// nenhuma janela do iOS e pontual o bastante para isso.
// ===========================================================================

const NOME = 'thor-confere-aprovacoes';

TaskManager.defineTask(NOME, async () => {
  try {
    const r = await chamar<{ pendentes: { id: string; comando: string }[] }>('/api/aprovacoes');
    const abertos = r?.pendentes ?? [];
    if (abertos.length === 0) return BackgroundTask.BackgroundTaskResult.Success;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: abertos.length === 1 ? 'Thor esta esperando' : `${abertos.length} pedidos esperando`,
        body: abertos[0].comando.slice(0, 120),
        data: { tipo: 'aprovacao', id: abertos[0].id },
        sound: true,
      },
      trigger: null,
    });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function ligarTarefaDeFundo(): Promise<void> {
  try {
    const jaRegistrada = await TaskManager.isTaskRegisteredAsync(NOME);
    if (jaRegistrada) return;
    await BackgroundTask.registerTaskAsync(NOME, { minimumInterval: 15 });
  } catch {
    /* sem tarefa de fundo o push continua funcionando; nao e motivo de erro */
  }
}
