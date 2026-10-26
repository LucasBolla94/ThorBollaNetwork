#!/usr/bin/env bash
# =========================================================================
# Primeira instalacao num servidor novo. Roda uma vez.
#
#   curl -fsSL https://raw.githubusercontent.com/LucasBolla94/ThorBollaNetwork/main/infra/bootstrap.sh | sudo bash
#
# ou, com o repositorio ja na maquina:
#
#   sudo bash infra/bootstrap.sh
#
# Depois desta, toda atualizacao e `bash infra/deploy.sh` da maquina de
# desenvolvimento — este script nao precisa rodar de novo.
# =========================================================================
set -euo pipefail

ORIGEM=${ORIGEM:-https://github.com/LucasBolla94/ThorBollaNetwork.git}
RAMO=${RAMO:-main}
RAIZ=/opt/thor
REPO=$RAIZ/repo

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }
[[ $EUID -eq 0 ]] || { echo "rode com sudo"; exit 1; }

log "pacotes do sistema"
apt-get update -qq
apt-get install -y -qq git curl rsync librsvg2-bin >/dev/null
echo "   git, curl, rsync e rsvg-convert prontos"

# O Node vem do tarball oficial e nao do apt: o apt do Ubuntu entrega uma
# versao antiga demais para rodar TypeScript direto, que e como este projeto
# roda — sem passo de compilacao.
if [[ ! -x /usr/local/bin/node ]]; then
  log "node"
  VERSAO=$(curl -fsSL https://nodejs.org/dist/index.json \
    | grep -o '"version":"v2[0-9][^"]*"' | head -1 | cut -d'"' -f4)
  curl -fsSL "https://nodejs.org/dist/$VERSAO/node-$VERSAO-linux-x64.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
  echo "   node $(/usr/local/bin/node --version)"
fi

log "codigo"
if [[ -d $REPO/.git ]]; then
  git config --global --add safe.directory "$REPO" 2>/dev/null || true
  git -C "$REPO" fetch --quiet origin "$RAMO"
  git -C "$REPO" reset --hard "origin/$RAMO" --quiet
  echo "   clone atualizado"
else
  mkdir -p "$RAIZ"
  git clone --quiet --branch "$RAMO" "$ORIGEM" "$REPO"
  git config --global --add safe.directory "$REPO" 2>/dev/null || true
  echo "   clonado de $ORIGEM"
fi

log "instalando"
bash "$REPO/infra/install.sh"
