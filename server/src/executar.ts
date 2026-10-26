import { execFile } from 'node:child_process';
import { config } from './config.ts';
import { db, newId, now } from './db.ts';
import { pedir } from './aprovacao.ts';

// ===========================================================================
// As maos do Thor no servidor.
//
// Tres niveis, nao dois:
//
//   LIVRE    consulta. Roda na hora.
//   APROVAR  muda algo. Para, pergunta ao Lucas, roda so com o sim dele.
//   NUNCA    nao roda nem com autorizacao.
//
// O terceiro nivel e o que mais exige explicacao, porque parece excesso de
// zelo. Nao e. Ele existe por causa de um principio:
//
//   **Aprovar so protege quando o que aparece e o que roda.**
//
// Um cartao de aprovacao mostra um texto. Se o comando puder virar outra coisa
// na hora da execucao, o sim do Lucas foi dado para uma frase e cobrado em
// outra. Entao tudo que quebra essa correspondencia cai em NUNCA, mesmo sendo
// util:
//
//   - `$(...)` e crase: o que roda e decidido depois da leitura
//   - `&`: solta processo que sobrevive ao tempo limite e a decisao
//   - `crontab`, `at`: um sim de hoje passaria a valer todo dia
//   - `pkill padrao`: o que morre depende do que estiver vivo
//   - `find -exec`: o comando real nao esta na linha
//   - `curl`, `wget`, `nc`: o cartao mostraria uma URL, e ninguem distingue
//     endereco legitimo de endereco de vazamento batendo o olho
//
// Essa ultima merece nota. A tentacao e permitir `curl` sob aprovacao, porque
// consultar uma API e util. Mas se o Thor um dia ler uma pagina envenenada, o
// pedido chega com justificativa convincente e um endereco plausivel. Pedir
// para o Lucas auditar URL a URL e transferir a nossa falha de desenho para
// ele. Fica fora.
//
// Isto roda como o usuario `luk`, que a unit do systemd prende: so
// /opt/thor/data e gravavel, sem sudo, sem novas permissoes. A lista aqui e a
// segunda camada, nao a unica.
// ===========================================================================

/**
 * Programas de consulta. Rodam sem perguntar.
 *
 * Tres nomes sairam desta lista depois de eu achar o buraco que eles abriam:
 * `xargs`, `env` e `command`. Todos os tres **executam outro programa**, e a
 * conferencia olhava so a primeira palavra do trecho. Entao `xargs sh -c id`
 * passava: o programa conferido era `xargs`, que estava liberado, e o `sh` que
 * de fato rodava nunca era olhado. `env sh -c id` e `command sh -c id` tinham
 * a mesma forma.
 *
 * Daria para desembrulhar o invocador e conferir o programa de verdade, mas
 * desembrulhar exige acertar as opcoes de cada um (`-n1 -I{}` do xargs,
 * `VAR=1` do env), e errar isso de novo custa caro. Lista de permissoes que
 * fica em duvida diz nao. `printenv` cobre o uso honesto do `env`.
 */
const PERMITIDOS = new Set([
  // estado da maquina
  'uptime', 'free', 'df', 'du', 'nproc', 'lscpu', 'hostname', 'date', 'uname',
  // processos
  'ps', 'top', 'pgrep',
  // servicos e containers (so leitura — ver VERBOS_PROIBIDOS)
  'systemctl', 'journalctl', 'docker',
  // arquivos (leitura)
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'find', 'tree', 'readlink',
  'basename', 'dirname', 'nl', 'tac', 'md5sum', 'sha256sum',
  // texto
  'grep', 'egrep', 'sed', 'awk', 'cut', 'sort', 'uniq', 'tr', 'jq', 'column', 'seq',
  // rede (leitura)
  'ss', 'ip', 'ping', 'dig', 'host', 'nslookup',
  // outros
  'echo', 'printf', 'which', 'printenv', 'sqlite3', 'ffprobe',
]);

/** Programas que existem para escrever. Nunca sao livres; no maximo aprovaveis. */
const ESCRITORES = new Set(['mkdir', 'touch', 'cp', 'mv', 'rm', 'rmdir', 'tee']);

/**
 * Opcoes que transformam um programa de leitura em um de acao.
 *
 * A conferencia casa token exato **ou** prefixo `--opcao=`. Sem o prefixo,
 * `--in-place` na lista nao pegava `--in-place=.bak`, que faz exatamente a
 * mesma coisa.
 */
const VERBOS_ESCRITA: Record<string, string[]> = {
  systemctl: ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'kill', 'set-property', 'edit', 'isolate', 'kexec', 'daemon-reload'],
  docker: ['run', 'exec', 'rm', 'rmi', 'kill', 'stop', 'start', 'restart', 'build', 'push', 'pull', 'cp', 'commit', 'login'],
  ip: ['add', 'del', 'set', 'flush', 'change'],
  sed: ['-i', '--in-place'],
  sort: ['-o', '--output'],
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'],
};

/**
 * Capacidade escondida dentro de programa de texto.
 *
 * Todo utilitario de texto antigo e uma maquina virtual pequena, e tres deles
 * sabem executar comando. Nenhum anuncia isso no nome, e todos estavam na
 * lista de permitidos como se fossem inofensivos.
 */
const FUGAS_INTERNAS: [RegExp, string, string][] = [
  [/^awk\b.*\bsystem\s*\(/s, 'awk', 'o awk pode executar comando com system()'],
  [/^awk\b.*\|\s*["']/s, 'awk', 'o awk pode abrir cano para outro comando'],
  [/^awk\b.*\bENVIRON\b/s, 'awk', 'leria o ambiente, onde ficam chaves'],
  [/^sed\b.*s[^\s]*\/[^\s]*\/[a-z]*e/s, 'sed', 'o modificador "e" do sed executa o resultado'],
  [/^sed\b.*(^|\s)e\s/s, 'sed', 'o comando "e" do sed executa'],
  [/^sqlite3\b.*\.(shell|system|import|output|once|load)\b/s, 'sqlite3', 'esse comando de ponto do sqlite3 sai do banco'],
  [/^sqlite3\b.*\b(insert|update|delete|drop|alter|attach|create|replace|vacuum)\b/is, 'sqlite3', 'isso escreveria no banco'],
];

/**
 * Construcoes em que o texto aprovado deixaria de ser o comando executado.
 *
 * So fica aqui o que e perigoso em qualquer posicao da linha. Nome de programa
 * perigoso **nao** entra nesta lista — ver PROIBIDOS logo abaixo e o porque.
 */
const CORRESPONDENCIA_QUEBRADA: [RegExp, string][] = [
  [/\$\(|`/, 'substituicao de comando: o que rodaria so se decide na hora, nao da para aprovar'],
  // O caractere antes do & importa: em `2>&1` ele vem depois de um `>` e nao
  // solta processo nenhum — so junta a saida de erro com a normal. Sem esta
  // excecao, a forma mais comum da shell inteira era recusada como se fosse
  // segundo plano, e o motivo dado nao fazia sentido nenhum para quem lesse.
  [/(^|[^&>])&($|[^&])/, 'rodar em segundo plano escapa do tempo limite e da decisao'],
];

/**
 * Programas proibidos, conferidos **so na posicao de programa** de cada trecho.
 *
 * Isto ja foi uma lista de expressoes soltas sobre a linha inteira, e errava
 * dos dois lados:
 *
 *   - `\benv\b` casava dentro de `/opt/thor/.env` e `\bsh\b` dentro de `x.sh`.
 *     O veredito saia certo, porque eram caminhos proibidos de qualquer jeito,
 *     mas pela regra errada — e a mensagem e o que o Thor repete ao Lucas.
 *     "cat /opt/thor/.env" recusado com "esse programa executa outro" nao
 *     explica nada e manda quem investigar para o lugar errado.
 *   - `ps aux | grep node` era recusado como "interpretador". A palavra estava
 *     ali como texto de busca, nao como programa. Consulta legitima barrada.
 *
 * Conferir na posicao de programa resolve os dois, e nao abre brecha: um
 * programa perigoso so faz mal quando e ele que roda. Chegar ate ele por outro
 * caminho exige invocador, interpretador, `$(...)`, `find -exec` ou fuga
 * interna de utilitario — e cada um desses esta barrado por conta propria.
 */
const PROIBIDOS: Record<string, string> = {};
const proibir = (nomes: string, motivo: string) => {
  for (const n of nomes.split(' ')) PROIBIDOS[n] = motivo;
};

proibir('xargs env command nice timeout nohup setsid stdbuf watch script flock',
  'esse programa executa outro, e o que apareceria no cartao nao seria o que roda');
proibir('sh bash zsh dash ksh python python3 perl ruby node php lua eval exec source',
  'interpretador: roda codigo que a linha nao mostra');
proibir('crontab at systemd-run batch',
  'agendamento faria um sim de hoje valer todo dia, sem passar por voce de novo');
proibir('kill pkill killall',
  'matar processo: o que morre depende do que estiver vivo na hora, nao do que o cartao mostra');
proibir('sudo su doas pkexec', 'elevacao de privilegio');
proibir('nc ncat netcat curl wget scp sftp rsync ftp telnet socat ssh',
  'mandaria dados para fora, e ninguem confere endereco batendo o olho');
proibir('dd shred fdisk parted mount umount swapon', 'destroi ou remonta disco');
proibir('reboot shutdown halt poweroff', 'desliga a maquina, e levaria o Thor junto');
proibir('chmod chown chgrp setfacl chattr umask',
  'muda permissao, e permissao errada nao da sinal de que esta errada');
proibir('useradd usermod userdel passwd gpasswd visudo chpasswd', 'mexe em conta de usuario');
proibir('apt apt-get dpkg snap pip pip3 npm npx git make gcc cc',
  'instalaria ou mudaria codigo, o que precisa de revisao e nao de um sim');
proibir('ln', 'atalho poderia apontar para fora do que e gravavel');

/** Caminhos que o Thor nao le, em nivel nenhum. */
const CAMINHOS_PROIBIDOS = [
  /\/\.env\b/, /\/\.runpod-key\b/, /\.credentials\.json\b/, /\/shadow\b/,
  /\/\.ssh\//, /id_rsa|id_ed25519/, /\.pem\b/, /SETUP\.txt\b/,
];

/**
 * Onde escrever e aprovavel.
 *
 * Nao e uma escolha nossa: a unit do systemd ja define `ReadWritePaths` com
 * /opt/thor/data, e o resto do sistema esta em somente-leitura para este
 * processo. A lista aqui repete o que o sistema ja garante, para o Thor receber
 * uma recusa que explica em vez de um "permission denied" cru.
 *
 * E por isso que **reiniciar servico nao esta no nivel de aprovacao**: como
 * `luk` nao tem sudo, `systemctl restart` seria recusado pelo sistema de
 * qualquer jeito. Pedir autorizacao para algo que nao pode funcionar seria
 * encenacao. Para o Thor reiniciar servico de verdade falta uma regra de
 * sudoers para unidades especificas — decisao separada, que nao tomo sozinho.
 */
const CAMINHOS_GRAVAVEIS = [`${config.dataDir.replace(/\/*$/, '')}/`, '/tmp/'];

export type Veredito =
  | { nivel: 'livre' }
  | { nivel: 'aprovar'; acao: string }
  | { nivel: 'nunca'; motivo: string };

export type Resultado = {
  ok: boolean;
  saida: string;
  motivo?: string;
  pediuAprovacao?: boolean;
};

/** Casa token exato ou a forma `--opcao=valor`. */
const temOpcao = (partes: string[], opcao: string): boolean =>
  partes.some((p) => p === opcao || (opcao.startsWith('--') && p.startsWith(`${opcao}=`)));

function gravavel(caminho: string): boolean {
  if (caminho.includes('..')) return false;
  return CAMINHOS_GRAVAVEIS.some((raiz) => caminho.startsWith(raiz) && caminho.length > raiz.length);
}

/** Alvos de redirecionamento na linha. */
function alvosDeRedirecionamento(texto: string): string[] {
  const alvos: string[] = [];
  const re = /\d?>>?\s*([^\s|;&<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) alvos.push(m[1]);
  return alvos;
}

export function avaliar(comando: string): Veredito {
  const texto = comando.trim();
  if (!texto) return { nivel: 'nunca', motivo: 'comando vazio' };
  if (texto.length > 2000) return { nivel: 'nunca', motivo: 'comando longo demais' };

  for (const [padrao, motivo] of CORRESPONDENCIA_QUEBRADA) {
    if (padrao.test(texto)) return { nivel: 'nunca', motivo };
  }
  for (const padrao of CAMINHOS_PROIBIDOS) {
    if (padrao.test(texto)) {
      return { nivel: 'nunca', motivo: 'esse caminho guarda segredo e nao pode ser lido' };
    }
  }

  const acoes: string[] = [];

  // Redirecionamento escreve arquivo. Aprovavel se o destino for gravavel.
  for (const alvo of alvosDeRedirecionamento(texto)) {
    if (alvo === '&1' || alvo === '&2') continue;
    // Jogar fora nao e gravar. `2>/dev/null` existe para calar erro esperado,
    // e e tao comum que recusa-lo faz o Thor parecer quebrado.
    if (alvo === '/dev/null') continue;
    if (!gravavel(alvo)) {
      return {
        nivel: 'nunca',
        motivo: `gravar em "${alvo}" nao e permitido; so dentro de ${CAMINHOS_GRAVAVEIS.join(' ou ')}`,
      };
    }
    acoes.push(`grava em ${alvo}`);
  }

  // Cada trecho precisa comecar com um programa conhecido — e "trecho" tem de
  // considerar TODOS os separadores da shell, nao so o pipe.
  //
  // Esta linha ja foi um buraco: separando so por "|", o comando
  // `date && python3 -c ...` passava, porque o unico programa conferido era o
  // `date`. Quem escreve lista de permissoes tem de pensar como a shell le,
  // nao como a frase parece.
  for (const bruto of texto.split(/\|\||&&|[|;\n]/)) {
    const trecho = bruto.trim();
    const partes = trecho.split(/\s+/).filter(Boolean);
    if (partes.length === 0) return { nivel: 'nunca', motivo: 'trecho vazio entre separadores' };

    const programa = partes[0];

    const proibido = PROIBIDOS[programa] ?? (programa.startsWith('mkfs') ? 'formata disco' : null);
    if (proibido) return { nivel: 'nunca', motivo: proibido };

    const ehEscritor = ESCRITORES.has(programa);
    if (!PERMITIDOS.has(programa) && !ehEscritor) {
      return { nivel: 'nunca', motivo: `"${programa}" nao esta na lista de comandos conhecidos` };
    }

    for (const [padrao, prog, motivo] of FUGAS_INTERNAS) {
      if (programa === prog && padrao.test(trecho)) return { nivel: 'nunca', motivo };
    }

    // Operando de programa escritor tem de ser caminho absoluto e gravavel.
    if (ehEscritor) {
      const operandos = partes.slice(1).filter((p) => !p.startsWith('-'));
      if (operandos.length === 0) {
        return { nivel: 'nunca', motivo: `"${programa}" sem dizer onde` };
      }
      for (const alvo of operandos) {
        if (!gravavel(alvo)) {
          return {
            nivel: 'nunca',
            motivo: `"${programa}" so pode mexer dentro de ${CAMINHOS_GRAVAVEIS.join(' ou ')}, e "${alvo}" esta fora`,
          };
        }
      }
      acoes.push(`${programa} em ${operandos.join(' ')}`);
      continue;
    }

    const verbos = VERBOS_ESCRITA[programa];
    const usados = verbos?.filter((v) => temOpcao(partes, v)) ?? [];
    if (usados.length > 0) {
      // sed -i e sort -o escrevem arquivo: o destino precisa ser gravavel.
      if (programa === 'sed' || programa === 'sort') {
        const arquivos = partes.slice(1).filter((p) => p.startsWith('/'));
        if (arquivos.length === 0 || !arquivos.every(gravavel)) {
          return {
            nivel: 'nunca',
            motivo: `"${programa} ${usados[0]}" reescreve o arquivo, e so dentro de ${CAMINHOS_GRAVAVEIS.join(' ou ')}`,
          };
        }
        acoes.push(`${programa} reescreve ${arquivos.join(' ')}`);
        continue;
      }
      // systemctl, docker, ip, find: acao que este usuario nao tem permissao
      // de fazer. Recusa que explica vale mais que um "permission denied".
      return {
        nivel: 'nunca',
        motivo: `"${programa} ${usados[0]}" precisa de privilegio que o Thor nao tem; isso ainda e coisa sua`,
      };
    }
  }

  if (acoes.length > 0) return { nivel: 'aprovar', acao: acoes.join('; ') };
  return { nivel: 'livre' };
}

const LIMITE_SAIDA = 6000;
const TEMPO_LIMITE = 15_000;

/** Guarda toda tentativa. Auditoria e o que torna isto defensavel. */
function registrar(comando: string, permitido: boolean, motivo: string | null, saida: string): void {
  db.prepare(
    `INSERT INTO comandos (id, comando, permitido, motivo, saida, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(newId(), comando, permitido ? 1 : 0, motivo, saida.slice(0, 4000), now());
}

function rodar(comando: string): Promise<Resultado> {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', comando],
      { timeout: TEMPO_LIMITE, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } },
      (erro, stdout, stderr) => {
        let saida = (stdout || '') + (stderr ? `\n[erro]\n${stderr}` : '');
        if (saida.length > LIMITE_SAIDA) {
          saida = `${saida.slice(0, LIMITE_SAIDA)}\n[... cortado, ${saida.length} caracteres no total]`;
        }
        if (erro && (erro as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          saida = `[o comando passou de ${TEMPO_LIMITE / 1000}s e foi interrompido]\n${saida}`;
        }
        if (!saida.trim()) saida = '[sem saida]';

        registrar(comando, true, null, saida);
        resolve({ ok: true, saida });
      },
    );
  });
}

/**
 * Avalia e, se for o caso, pede autorizacao antes de rodar.
 *
 * `justificativa` e o que o modelo escreveu para explicar o pedido. Vai para o
 * cartao rotulada como fala dele, nunca como fato apurado — ver aprovacao.ts.
 */
export async function executar(comando: string, justificativa = ''): Promise<Resultado> {
  const veredito = avaliar(comando);

  if (veredito.nivel === 'nunca') {
    registrar(comando, false, veredito.motivo, '');
    return { ok: false, saida: '', motivo: veredito.motivo };
  }

  if (veredito.nivel === 'aprovar') {
    const estado = await pedir(comando, justificativa || veredito.acao);
    if (estado !== 'aprovado') {
      const motivo =
        estado === 'negado'
          ? 'o Lucas negou este comando'
          : 'o pedido de autorizacao venceu sem resposta';
      registrar(comando, false, motivo, '');
      return { ok: false, saida: '', motivo, pediuAprovacao: true };
    }
    const r = await rodar(comando);
    return { ...r, pediuAprovacao: true };
  }

  return rodar(comando);
}

/** Ultimos comandos, para a tela de auditoria. */
export function historico(limite = 100) {
  return db
    .prepare(
      `SELECT id, comando, permitido, motivo, saida, created_at AS createdAt
         FROM comandos ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limite);
}
