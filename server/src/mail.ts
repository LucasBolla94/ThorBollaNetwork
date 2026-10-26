import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

// ---------------------------------------------------------------------------
// Envio de e-mail.
//
// As credenciais vem do .env e nunca do banco: senha de caixa postal nao e
// configuracao de aplicacao, e quem tem acesso ao banco nao deveria ganhar a
// conta de e-mail junto.
// ---------------------------------------------------------------------------

const cfg = () => ({
  host: process.env.SMTP_HOST ?? '',
  port: Number(process.env.SMTP_PORT ?? 587),
  user: process.env.SMTP_USER ?? '',
  pass: process.env.SMTP_PASS ?? '',
  from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
  name: process.env.SMTP_SENDER_NAME ?? 'Thor',
});

export const mailReady = (): boolean => {
  const c = cfg();
  return Boolean(c.host && c.user && c.pass);
};

let transporter: Transporter | null = null;

function get(): Transporter {
  if (transporter) return transporter;
  const c = cfg();
  transporter = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    // 465 e TLS desde o primeiro byte; 587 comeca em claro e sobe com
    // STARTTLS. Errar isso trava a conexao sem mensagem util.
    secure: c.port === 465,
    requireTLS: c.port !== 465,
    auth: { user: c.user, pass: c.pass },
  });
  return transporter;
}

export type Mail = { to: string; subject: string; text: string; html?: string };

export async function sendMail(mail: Mail): Promise<void> {
  if (!mailReady()) {
    throw new Error(
      'E-mail nao configurado. Faltam SMTP_HOST, SMTP_USER e SMTP_PASS no /opt/thor/.env.',
    );
  }
  const c = cfg();
  await get().sendMail({
    from: `"${c.name}" <${c.from}>`,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}

/** Confere usuario e senha no servidor sem mandar mensagem nenhuma. */
export async function verifyMail(): Promise<void> {
  if (!mailReady()) throw new Error('E-mail nao configurado.');
  await get().verify();
}
