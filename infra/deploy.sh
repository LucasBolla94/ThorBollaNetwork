#!/usr/bin/env bash
# =========================================================================
# Publica o que esta no GitHub.
#
#   bash infra/deploy.sh
#
# O deploy deixou de empacotar e enviar arquivo: agora o servidor busca do
# GitHub. A diferenca que importa nao e comodidade, e **saber o que esta no
# ar**. Antes, o que rodava era o que estava na maquina de quem rodou o
# script; agora e um commit, com nome e historico.
#
# Por isso o script se recusa a publicar com alteracao nao enviada: se o
# servidor busca do GitHub, o que nao chegou no GitHub nao existe.
# =========================================================================
set -euo pipefail

MAQUINA=${MAQUINA:-dedicated-1}
RAMO=${RAMO:-main}
REPO=/opt/thor/repo

cor() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ------------------------------------------------------- conferencias locais
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Ha alteracao nao commitada. O servidor busca do GitHub, entao isto nao subiria:"
  git status --short | sed 's/^/   /'
  exit 1
fi

LOCAL=$(git rev-parse HEAD)
git fetch --quiet origin "$RAMO"
REMOTO=$(git rev-parse "origin/$RAMO")

if [[ $LOCAL != "$REMOTO" ]]; then
  cor "enviando para o GitHub"
  git push origin "$RAMO"
fi

cor "publicando $(git rev-parse --short HEAD) em $MAQUINA"

# `reset --hard` e nao `pull`: o servidor e destino de deploy, nao lugar de
# editar. Se alguem mexeu la, o certo e perder essa mudanca e nao travar o
# deploy num conflito. Dados e segredos vivem fora do repositorio e nao sao
# tocados por isto.
ssh "$MAQUINA" "sudo bash -s" <<EOF
set -euo pipefail
git config --global --add safe.directory $REPO 2>/dev/null || true
cd $REPO
git fetch --quiet origin $RAMO
git reset --hard "origin/$RAMO" --quiet
bash infra/install.sh
EOF

cor "conferindo pela internet"
curl -fsS -o /dev/null -w '   https://bolla.network -> HTTP %{http_code} em %{time_total}s\n' \
  https://bolla.network
echo
