/**
 * Convida alguem para o Thor e manda o e-mail.
 *
 *   sudo -u thor THOR_ROOT=/opt/thor/repo /usr/local/bin/node src/convidar.ts <email> [nivel]
 *
 * Roda fora do servidor web porque e assim que a primeira conta nasce: enquanto
 * nao existe dono, nao ha quem possa se autenticar para convidar. Quem tem SSH
 * na maquina e a unica autoridade que existe nesse momento.
 *
 * Diferenca para um cadastro comum: aqui o convidado nasce **sem senha**. Ele
 * escolhe a dele no link, e ela nao passa por mais ninguem — nem por quem
 * convidou, nem pelo log, nem por esta linha de comando.
 */
import { config } from './config.ts';
import { espelharUsuario, donoAtual } from './auth.ts';
import { convidar } from './supabase.ts';
import { mailReady, sendMail, verifyMail } from './mail.ts';
import { convite } from './emails.ts';

const email = process.argv[2]?.trim().toLowerCase();
const nivel = (process.argv[3] ?? 'dono').trim().toLowerCase();

if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('uso: node src/convidar.ts <email> [nivel]');
  console.error('niveis: dono (padrao)');
  process.exit(1);
}

const dono = donoAtual();
if (dono && nivel === 'dono' && dono.email !== email) {
  console.error(`Ja existe um dono neste Thor: ${dono.email}`);
  console.error('Para convidar outra pessoa, use um nivel diferente de "dono".');
  process.exit(1);
}

if (!mailReady()) {
  console.error('E-mail nao configurado: faltam SMTP_HOST, SMTP_USER ou SMTP_PASS no .env.');
  process.exit(1);
}

console.log(`Convidando ${email} como ${nivel}...`);
console.log('Conferindo o acesso ao servidor de e-mail...');
try {
  await verifyMail();
  console.log(`  login ok em ${process.env.SMTP_HOST}`);
} catch (err) {
  console.error('  falhou:', (err as Error).message);
  process.exit(1);
}

let link: string;
try {
  const r = await convidar(email, nivel);
  espelharUsuario(r.user.id, r.user.email, nivel);
  link = r.link;
  console.log('  convite criado no Supabase');
} catch (err) {
  console.error('  nao consegui criar o convite:', (err as Error).message);
  process.exit(1);
}

try {
  await sendMail({ to: email, ...convite(link, nivel) });
  console.log(`\nConvite enviado para ${email}.`);
  console.log(`Ele escolhe a senha em ${config.publicUrl}.`);
} catch (err) {
  console.error('\nNao consegui enviar:', (err as Error).message);
  console.error('O convite existe mesmo assim. Link:');
  console.error(link);
  process.exit(1);
}

process.exit(0);
