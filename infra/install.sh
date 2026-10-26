#!/usr/bin/env bash
# =========================================================================
# Instala ou atualiza o Thor a partir do clone em /opt/thor/repo.
#
#   sudo bash infra/install.sh
#
# Roda de dentro do proprio clone e e idempotente: pode rodar a cada deploy
# sem perder dados, sem invalidar sessao e sem pedir nada.
#
# O que ESTE script nunca toca:
#   /opt/thor/data   o banco
#   /opt/thor/.env   os segredos
#
# Os dois ficam fora do repositorio justamente porque o deploy e um
# `git reset --hard`: o que estiver dentro e versionado some, e o que estiver
# dentro sem ser versionado some junto.
# =========================================================================
set -euo pipefail

RAIZ=/opt/thor
REPO=$RAIZ/repo
NODE=/usr/local/bin/node
NPM=/usr/local/bin/npm

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "rode com sudo"; exit 1; }
[[ -x $NODE ]] || { echo "Node nao encontrado em $NODE"; exit 1; }
[[ -d $REPO/server ]] || { echo "nao parece um clone do Thor: $REPO"; exit 1; }

# ------------------------------------------------------------------ usuario
log "usuario de servico"
if ! id -u thor >/dev/null 2>&1; then
  useradd --system --home-dir "$RAIZ" --shell /usr/sbin/nologin thor
  echo "   usuario thor criado"
else
  echo "   usuario thor ja existe"
fi

mkdir -p "$RAIZ/data"

# ------------------------------------------------------- migracao do antigo
# O projeto chamava luk e morava em /opt/luk. Esta parte roda uma vez, move
# dados e segredos para o lugar novo, e depois nunca mais faz nada.
if [[ -d /opt/luk/data && ! -f $RAIZ/data/thor.db && ! -f $RAIZ/data/luk.db ]]; then
  log "migrando dados de /opt/luk"
  cp -a /opt/luk/data/. "$RAIZ/data/"
  # O banco mudou de nome junto com o agente. Os arquivos -wal e -shm sao do
  # SQLite e precisam acompanhar, ou ele os descarta e perde o que estava
  # pendente de gravacao.
  for sufixo in '' '-wal' '-shm'; do
    [[ -f $RAIZ/data/luk.db$sufixo ]] && mv "$RAIZ/data/luk.db$sufixo" "$RAIZ/data/thor.db$sufixo"
  done
  echo "   banco copiado e renomeado (o original em /opt/luk continua la)"
fi

if [[ -f /opt/luk/.env && ! -f $RAIZ/.env ]]; then
  cp -a /opt/luk/.env "$RAIZ/.env"
  echo "   .env copiado de /opt/luk"
fi

# ------------------------------------------------------------------ segredos
log "segredos"
if [[ ! -f $RAIZ/.env ]]; then
  SESSION_SECRET=$("$NODE" -e 'console.log(require("crypto").randomBytes(48).toString("base64url"))')
  SETUP_TOKEN=$("$NODE" -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')
  cat > "$RAIZ/.env" <<EOF
SESSION_SECRET=$SESSION_SECRET
SETUP_TOKEN=$SETUP_TOKEN
EOF
  echo "$SETUP_TOKEN" > "$RAIZ/PRIMEIRO-ACESSO.txt"
  chmod 600 "$RAIZ/PRIMEIRO-ACESSO.txt"
  echo "   .env criado"
else
  echo "   .env preservado"
fi
chmod 600 "$RAIZ/.env"

# --------------------------------------------------------------- dependencias
log "dependencias"
cd "$REPO/server"
"$NPM" install --omit=dev --no-audit --no-fund --loglevel=error

# ---------------------------------------------------------------- icones PWA
# Gerados a partir do SVG, nunca versionados: uma fonte de verdade em vez de
# quatro arquivos para manter em sincronia. Ficam no .gitignore, entao nao
# aparecem como alteracao e nao atrapalham o proximo `git reset --hard`.
log "icones do PWA"
if command -v rsvg-convert >/dev/null 2>&1; then
  for tamanho in 180 192 512; do
    rsvg-convert -w $tamanho -h $tamanho "$REPO/web/icon.svg" -o "$REPO/web/icon-$tamanho.png"
  done
  echo "   png gerados"
else
  echo "   rsvg-convert ausente, mantendo so o svg"
fi

# ----------------------------------------------------------------- permissoes
log "permissoes"
chown -R thor:thor "$RAIZ"
chmod 700 "$RAIZ/data"

# -------------------------------------------------------------------- systemd
log "systemd"
install -m 644 "$REPO/infra/thor.service" /etc/systemd/system/thor.service
systemctl daemon-reload

# A unit antiga sai de cena depois da nova estar escrita, e so entao. O
# ARQUIVO dela fica: as duas disputam a porta 8787, entao a troca tem um
# instante em que nenhuma atende, e nesse instante a unica saida boa e poder
# voltar com um comando. Apagar a unit antiga seria queimar a ponte no meio
# da travessia.
TINHA_ANTIGA=nao
if [[ -f /etc/systemd/system/luk.service ]] && systemctl is-enabled luk.service >/dev/null 2>&1; then
  TINHA_ANTIGA=sim
  log "desligando luk.service"
  systemctl disable --now luk.service >/dev/null 2>&1 || true
  echo "   desligado (a unit continua em /etc/systemd/system, para poder voltar)"
fi

systemctl enable thor.service >/dev/null 2>&1
systemctl restart thor.service

# Se o novo nao atender, volta o antigo sozinho. Um deploy que derruba o site
# e um problema; um deploy que derruba o site e vai dormir e outro.
sleep 2
if ! curl -fsS -o /dev/null http://127.0.0.1:8787/ 2>/dev/null; then
  echo
  echo "   O thor.service nao respondeu. Ultimas linhas:"
  journalctl -u thor -n 25 --no-pager | sed 's/^/      /'
  if [[ $TINHA_ANTIGA == sim ]]; then
    echo
    echo "   Voltando para luk.service para o site nao ficar fora do ar."
    systemctl stop thor.service || true
    systemctl enable --now luk.service || true
  fi
  exit 1
fi

# ---------------------------------------------------------------------- caddy
log "caddy"
if [[ -f $REPO/infra/Caddyfile ]]; then
  install -m 644 "$REPO/infra/Caddyfile" /etc/caddy/Caddyfile
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi

# --------------------------------------------------------------------- estado
log "estado"
sleep 2
for unidade in thor caddy; do
  printf '   %-6s %s\n' "$unidade" "$(systemctl is-active $unidade)"
done

if curl -fsS -o /dev/null -w '' http://127.0.0.1:8787/ 2>/dev/null; then
  echo "   local HTTP ok"
else
  echo "   AVISO: o servidor nao respondeu em 127.0.0.1:8787"
  journalctl -u thor -n 20 --no-pager | sed 's/^/      /'
  exit 1
fi

[[ -f $RAIZ/PRIMEIRO-ACESSO.txt ]] && echo "
   token de primeiro acesso em $RAIZ/PRIMEIRO-ACESSO.txt"
echo
