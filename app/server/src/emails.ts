/**
 * Os e-mails da BollaNetwork.
 *
 * Um molde so para todos, por dois motivos: a marca fica igual em qualquer
 * mensagem, e corrigir um problema de renderizacao conserta todas de uma vez.
 *
 * Regras de e-mail que o HTML daqui respeita, porque cliente de e-mail nao e
 * navegador:
 *   - layout em tabela; flexbox e grid nao existem no Outlook
 *   - todo estilo em linha; <style> no topo e descartado por varios clientes
 *   - cor de fundo repetida na tabela E na celula, senao o Outlook ignora
 *   - gradiente sempre com cor solida embaixo como reserva
 *   - largura em pixel, nunca em porcentagem solta
 */

type Corpo = { subject: string; text: string; html: string };

const MARCA = 'BollaNetwork';
const ANO = new Date().getFullYear();

const BG = '#06060c';
const CARTAO = '#101020';
const BORDA = '#242440';
const TEXTO = '#eceafa';
const SUAVE = '#a4a1c0';
const FRACO = '#6e6b8c';
const ROXO = '#8b7cf6';
const CIANO = '#4dd4e8';

type Molde = {
  /** Aparece na previa da caixa de entrada, antes de abrir. */
  previa: string;
  titulo: string;
  corpo: string;
  botao: string;
  link: string;
  rodape: string;
};

function moldura({ previa, titulo, corpo, botao, link, rodape }: Molde): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${titulo}</title>
</head>
<body style="margin:0;padding:0;background-color:${BG};">

<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${previa}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BG};">
<tr><td align="center" style="background-color:${BG};padding:40px 16px;">

  <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:100%;">

    <!-- marca -->
    <tr><td align="center" style="padding-bottom:22px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:10px;">
          <div style="width:26px;height:26px;border-radius:50%;background-color:${ROXO};background-image:linear-gradient(145deg,${ROXO},${CIANO});"></div>
        </td>
        <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.16em;color:${SUAVE};text-transform:uppercase;">
          ${MARCA}
        </td>
      </tr></table>
    </td></tr>

    <!-- cartao -->
    <tr><td style="background-color:${CARTAO};border:1px solid ${BORDA};border-radius:18px;padding:40px 36px;">

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="padding-bottom:26px;">
          <div style="width:68px;height:68px;border-radius:50%;background-color:${ROXO};background-image:radial-gradient(circle at 36% 32%,#ffffff 0%,${ROXO} 42%,${CIANO} 100%);"></div>
        </td></tr>

        <tr><td align="center" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:24px;font-weight:600;letter-spacing:-0.02em;color:${TEXTO};padding-bottom:16px;line-height:1.25;">
          ${titulo}
        </td></tr>

        <tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:${SUAVE};padding-bottom:30px;">
          ${corpo}
        </td></tr>

        <tr><td align="center" style="padding-bottom:30px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td align="center" style="background-color:${ROXO};background-image:linear-gradient(135deg,${ROXO},#6d5df0);border-radius:11px;">
              <a href="${link}" style="display:inline-block;padding:15px 34px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${botao}</a>
            </td>
          </tr></table>
        </td></tr>

        <tr><td style="border-top:1px solid #1c1c30;padding-top:22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12.5px;line-height:1.65;color:${FRACO};">
          ${rodape}
          <br><br>
          Se o botao nao abrir, copie este endereco:<br>
          <span style="color:${CIANO};word-break:break-all;">${link}</span>
        </td></tr>
      </table>

    </td></tr>

    <!-- rodape -->
    <tr><td align="center" style="padding-top:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.7;color:${FRACO};">
      ${MARCA} &middot; ${ANO}<br>
      Esta mensagem foi enviada automaticamente. Nao e preciso responder.
    </td></tr>

  </table>

</td></tr>
</table>
</body>
</html>`;
}

const assinatura = (texto: string, link: string, aviso: string) =>
  `${texto}

${link}

${aviso}

— ${MARCA}`;

// ---------------------------------------------------------------------------

export function convite(link: string, nivel: string): Corpo {
  const papel = nivel === 'dono' ? 'como dono' : `com nivel ${nivel}`;
  return {
    subject: `Seu acesso ao Thor — ${MARCA}`,
    text: assinatura(
      `Voce foi convidado para o Thor ${papel}.\n\nAbra o link abaixo para escolher sua senha e entrar:`,
      link,
      'O link vale uma vez so. Se nao esperava este convite, pode ignorar.',
    ),
    html: moldura({
      previa: 'Escolha sua senha e entre no Thor.',
      titulo: 'Seu acesso ao Thor',
      corpo: `Voce foi convidado ${papel}. Clique abaixo para escolher sua senha e entrar.<br><br>O Thor e o seu segundo cerebro: ele lembra do que voces conversam e vai montando a propria teia de pensamento a partir disso.`,
      botao: 'Escolher minha senha',
      link,
      rodape:
        'O link vale <strong style="color:#a4a1c0;">uma vez so</strong>. Se nao esperava este convite, pode ignorar com seguranca.',
    }),
  };
}

export function confirmacao(link: string): Corpo {
  return {
    subject: `Confirme seu e-mail — ${MARCA}`,
    text: assinatura(
      'Falta um passo para sua conta ficar pronta.\n\nAbra o link abaixo para confirmar que este endereco e seu:',
      link,
      'Sem confirmar, a conta nao e ativada.',
    ),
    html: moldura({
      previa: 'Um clique e sua conta fica pronta.',
      titulo: 'Confirme seu e-mail',
      corpo:
        'Falta um passo para sua conta ficar pronta. Clique abaixo para confirmar que este endereco e seu.',
      botao: 'Confirmar meu e-mail',
      link,
      rodape:
        'Se nao foi voce que criou a conta, pode ignorar: sem confirmar, ela nao e ativada.',
    }),
  };
}

export function recuperacao(link: string): Corpo {
  return {
    subject: `Redefinir sua senha — ${MARCA}`,
    text: assinatura(
      'Voce pediu para trocar a senha do Thor.\n\nAbra o link abaixo para escolher uma nova:',
      link,
      'O link vale uma vez so. Se nao foi voce, sua senha atual continua valendo.',
    ),
    html: moldura({
      previa: 'Escolha uma nova senha para o Thor.',
      titulo: 'Redefinir sua senha',
      corpo:
        'Voce pediu para trocar a senha. Clique abaixo para escolher uma nova. Depois de salvar, as outras sessoes sao desconectadas.',
      botao: 'Escolher nova senha',
      link,
      rodape:
        'O link vale uma vez so. Se nao foi voce que pediu, pode ignorar: sua senha atual continua valendo.',
    }),
  };
}
