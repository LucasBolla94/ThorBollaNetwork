#!/usr/bin/env bash
# =========================================================================
# Instala/atualiza o Luk no servidor. Idempotente: pode rodar de novo a
# cada deploy sem perder dados nem invalidar a sessao do navegador.
#
#   sudo bash install.sh
# =========================================================================
set -euo pipefail

ROOT=/opt/luk
STAGE=${STAGE:-/tmp/luk-stage}
NODE=/usr/local/bin/node
NPM=/usr/local/bin/npm

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "rode com sudo"; exit 1; }
[[ -x $NODE ]] || { echo "Node nao encontrado em $NODE"; exit 1; }
[[ -d $STAGE ]] || { echo "nada em $STAGE para instalar"; exit 1; }

log "usuario de servico"
if ! id -u luk >/dev/null 2>&1; then
  useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin luk
  echo "   usuario luk criado"
else
  echo "   usuario luk ja existe"
fi

log "diretorios"
mkdir -p "$ROOT"/{server,web,data}

log "codigo"
# O rsync preserva data/ e .env; --delete limpa so o que e codigo.
rsync -a --delete "$STAGE/server/src/" "$ROOT/server/src/"
install -m 644 "$STAGE/server/package.json" "$ROOT/server/package.json"
rsync -a --delete "$STAGE/web/" "$ROOT/web/"

log "segredos"
if [[ ! -f $ROOT/.env ]]; then
  SESSION_SECRET=$("$NODE" -e 'console.log(require("crypto").randomBytes(48).toString("base64url"))')
  SETUP_TOKEN=$("$NODE" -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')
  cat >"$ROOT/.env" <<ENVEOF
# Luk — configuracao. Este arquivo tem segredo: nao versione.
PORT=8787
HOST=127.0.0.1
SECURE_COOKIES=true
LUK_PUBLIC_URL=https://bolla.network
LUK_SITE_NAME=Luk

# Assina os tokens de sessao. Trocar isto desconecta todo mundo.
SESSION_SECRET=$SESSION_SECRET

# Libera a tela de primeiro acesso. Pode apagar depois de criar a conta.
SETUP_TOKEN=$SETUP_TOKEN

# A chave da IA. Sem ela o site sobe e entra, mas o chat avisa que falta.
OPENROUTER_API_KEY=
LUK_MODEL=anthropic/claude-sonnet-5.5
ENVEOF
  printf '%s\n' "$SETUP_TOKEN" >"$ROOT/SETUP.txt"
  chmod 600 "$ROOT/SETUP.txt"
  echo "   .env criado"
else
  echo "   .env preservado"
fi
chmod 600 "$ROOT/.env"

log "dependencias"
cd "$ROOT/server"
"$NPM" install --omit=dev --no-audit --no-fund --loglevel=error

log "versao do cache do PWA"
# Carimba o service worker com a marca do que esta sendo instalado.
#
# A versao ficava escrita na mao, e numa troca de nome do agente ela nao foi
# trocada junto: quem tivesse o site na tela inicial continuava com a casca
# antiga em cache. Como o service worker busca na rede primeiro, ninguem viu —
# mas offline serviria conteudo velho, e isso so apareceria no pior momento.
#
# Dependendo de alguem lembrar, cedo ou tarde nao lembra. Entao a versao passa
# a ser derivada do conteudo: se os arquivos mudaram, o cache antigo cai.
MARCA=$(cat "$ROOT"/web/app.js "$ROOT"/web/app.css "$ROOT"/web/index.html 2>/dev/null \
  | sha256sum | cut -c1-12)
sed -i "s/^const VERSION = .*/const VERSION = 'thor-$MARCA';/" "$ROOT/web/sw.js"
echo "   cache marcado como thor-$MARCA"

log "icones do PWA"
if command -v rsvg-convert >/dev/null 2>&1; then
  for size in 192 512; do
    rsvg-convert -w $size -h $size "$ROOT/web/icon.svg" -o "$ROOT/web/icon-$size.png"
  done
  rsvg-convert -w 180 -h 180 "$ROOT/web/icon.svg" -o "$ROOT/web/icon-180.png"
  echo "   png gerados"
else
  echo "   rsvg-convert ausente, mantendo so o svg"
fi

log "permissoes"
chown -R luk:luk "$ROOT"
chmod 700 "$ROOT/data"

log "systemd"
install -m 644 "$STAGE/deploy/luk.service" /etc/systemd/system/luk.service
systemctl daemon-reload
systemctl enable luk >/dev/null 2>&1 || true
systemctl restart luk

log "caddy"
install -m 644 "$STAGE/deploy/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

sleep 2
log "estado"
systemctl is-active luk && echo "   luk: ativo"
systemctl is-active caddy && echo "   caddy: ativo"
curl -fsS -o /dev/null -w '   local HTTP %{http_code}\n' http://127.0.0.1:8787/api/state || echo "   app nao respondeu"

if [[ -f $ROOT/SETUP.txt ]]; then
  echo
  echo "   token de primeiro acesso em $ROOT/SETUP.txt"
fi
echo
