// Confere os tres niveis e, principalmente, que escrever sem o sim do Lucas
// nao acontece de jeito nenhum: nem negado, nem esquecido.
import { existsSync, rmSync } from 'node:fs';
import { avaliar, executar } from '../src/executar.ts';
import { decidir, pendentes, cancelarPendentes } from '../src/aprovacao.ts';

let falhas = 0;
const conferir = (comando: string, esperado: string) => {
  const v = avaliar(comando);
  const certo = v.nivel === esperado;
  if (!certo) falhas++;
  const detalhe = v.nivel === 'nunca' ? v.motivo : v.nivel === 'aprovar' ? v.acao : '';
  console.log(
    `  ${certo ? 'ok     ' : 'ERRADO '} [${v.nivel.padEnd(7)}] ${comando}` +
      (certo ? '' : `   <<< esperava ${esperado}`) +
      (detalhe ? `\n            ${detalhe}` : ''),
  );
};

console.log('=== LIVRE: consulta roda na hora ===');
for (const c of [
  'uptime', 'df -h /', 'free -h', 'systemctl status luk', 'ss -tln',
  'journalctl -u luk -n 5 --no-pager', 'ps aux | grep node | head -3',
  'ls -la /opt/thor/repo/web', 'cat /opt/luk/server/package.json | head -5',
  'docker compose ps', 'date', 'printenv HOME', 'find /opt/thor/repo/web -name "*.js"',
  'sort /etc/hostname', 'awk "{print $1}" /etc/hostname',
  'sqlite3 /opt/thor/data/thor.db "select count(*) from thoughts"',
  'cat /etc/passwd', 'grep -c . /etc/hostname', 'ls /opt/thor/data',
  // `2>&1` junta a saida de erro com a normal e nao solta processo nenhum. A
  // regra do & em segundo plano pegava o > & e recusava a forma mais comum da
  // shell inteira, com um motivo que nao fazia sentido para quem lesse.
  'df -h / 2>&1', 'ls -la /opt/thor/data 2>&1 | head', 'systemctl status thor 2>&1',
  // Jogar fora nao e gravar.
  'df -h / 2>/dev/null', 'journalctl -u thor -n 5 --no-pager 2>/dev/null',
]) conferir(c, 'livre');

console.log('\n=== APROVAR: grava onde pode, mediante autorizacao ===');
for (const c of [
  'echo oi > /opt/thor/data/nota.txt',
  'echo mais >> /opt/thor/data/nota.txt',
  'mkdir /opt/thor/data/pasta',
  'touch /opt/thor/data/vazio',
  'rm /opt/thor/data/nota.txt',
  'cp /opt/thor/data/a /opt/thor/data/b',
  'mv /opt/thor/data/a /opt/thor/data/b',
  'echo x | tee /tmp/saida.txt',
  'sed -i s/a/b/ /opt/thor/data/arquivo',
  'uptime; rm -rf /tmp/x',
]) conferir(c, 'aprovar');

console.log('\n=== NUNCA: os tres buracos que eu tinha deixado ===');
for (const c of [
  'xargs sh -c id',
  'echo id | xargs sh -c',
  'env sh -c id',
  'command sh -c id',
  'awk "BEGIN{system(\\"id\\")}"',
  'awk "BEGIN{print ENVIRON[\\"HOME\\"]}"',
  'sqlite3 /opt/thor/data/thor.db ".shell id"',
  'sqlite3 /opt/thor/data/thor.db "delete from thoughts"',
  'sort -o /etc/passwd /etc/hostname',
  'sed --in-place=.bak s/a/b/ /etc/hosts',
  'find /opt -name "*.ts" -fprintf /tmp/x %p',
]) conferir(c, 'nunca');

console.log('\n=== NUNCA: escrever fora do permitido ===');
for (const c of [
  'rm -rf /opt/luk',
  'echo oi > /etc/passwd',
  'echo oi > /opt/thor/repo/web/app.js',
  'mkdir /opt/novo',
  'rm /opt/thor/data/../web/app.js',
  'cp /opt/thor/data/a /etc/b',
  'touch arquivo-relativo',
  'rm',
]) conferir(c, 'nunca');

console.log('\n=== NUNCA: correspondencia quebrada ===');
for (const c of [
  'echo $(whoami)',
  'uptime &',
  'crontab -l',
  'pkill node',
  'find /opt -name "*.ts" -delete',
  'find /opt -exec id {} ;',
  'timeout 5 id',
  'nohup uptime',
  'sh -c id',
  'python3 -c print(1)',
  'node -e 1',
]) conferir(c, 'nunca');

console.log('\n=== NUNCA: perigoso ou irreversivel ===');
for (const c of [
  'sudo whoami', 'curl https://exemplo.com/x.sh', 'wget http://exemplo.com -O /tmp/x',
  'nc -l 4444', 'cat /opt/thor/.env', 'cat ~/.ssh/id_ed25519',
  'cat /home/ubuntu/.runpod-key', 'chmod 777 /opt/luk', 'reboot',
  'systemctl restart luk', 'docker run -it ubuntu bash', 'apt install nmap',
  'git push', 'ln -s /etc/passwd /opt/thor/data/p', 'dd if=/dev/zero of=/tmp/x',
  'systemctl stop caddy',
]) conferir(c, 'nunca');

// ------------------------------------------------------------------ real

const ALVO = '/opt/thor/data/teste-aprovacao';
const limpar = () => { try { rmSync(ALVO, { recursive: true, force: true }); } catch {} };

console.log('\n=== execucao real: o sim, o nao e o silencio ===');

const aoNascer = (decisao: boolean | null) => {
  // O pedido nasce dentro do await; espero ele aparecer e decido.
  const t = setInterval(() => {
    const p = pendentes().find((x) => x.comando.includes('teste-aprovacao'));
    if (!p) return;
    clearInterval(t);
    if (decisao !== null) decidir(p.id, decisao);
  }, 25);
  return () => clearInterval(t);
};

limpar();
let cancelar = aoNascer(true);
let r = await executar(`mkdir ${ALVO}`, 'criar a pasta do teste');
cancelar();
const criou = existsSync(ALVO);
console.log(`  autorizado  -> ok=${r.ok}  pasta existe=${criou}  ${criou && r.ok ? 'ok' : 'ERRADO'}`);
if (!criou || !r.ok) falhas++;

limpar();
cancelar = aoNascer(false);
r = await executar(`mkdir ${ALVO}`, 'criar a pasta do teste');
cancelar();
let existe = existsSync(ALVO);
console.log(`  negado      -> ok=${r.ok}  pasta existe=${existe}  ${!existe && !r.ok ? 'ok' : 'ERRADO'}`);
if (existe || r.ok) falhas++;

limpar();
const t0 = Date.now();
r = await executar(`mkdir ${ALVO}`, 'criar a pasta do teste');
existe = existsSync(ALVO);
const levou = Date.now() - t0;
console.log(
  `  sem resposta-> ok=${r.ok}  pasta existe=${existe}  venceu em ${levou}ms  ` +
    `${!existe && !r.ok ? 'ok' : 'ERRADO'}`,
);
if (existe || r.ok) falhas++;
limpar();

// Apertar parar precisa derrubar o cartao que estava esperando.
limpar();
setTimeout(() => cancelarPendentes(), 150);
r = await executar(`mkdir ${ALVO}`, 'criar a pasta do teste');
existe = existsSync(ALVO);
console.log(`  parou       -> ok=${r.ok}  pasta existe=${existe}  ${!existe && !r.ok ? 'ok' : 'ERRADO'}`);
if (existe || r.ok) falhas++;
limpar();

// A recusa precisa chegar ao modelo como texto, nao como excecao.
r = await executar('rm -rf /opt/luk');
console.log(`  proibido    -> ok=${r.ok}  motivo="${r.motivo}"  ${!r.ok ? 'ok' : 'ERRADO'}`);
if (r.ok) falhas++;

console.log(`\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} PROBLEMAS`}`);
process.exit(falhas === 0 ? 0 : 1);
