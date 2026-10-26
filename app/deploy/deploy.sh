#!/usr/bin/env bash
# =========================================================================
# Manda o codigo daqui para o servidor e reinstala.
#
#   bash app/deploy/deploy.sh
#
# Roda do Git Bash no Windows ou de qualquer shell com ssh/scp/tar.
# Nao toca em /opt/luk/.env nem em /opt/luk/data: so o codigo sobe.
# =========================================================================
set -euo pipefail

HOST=${HOST:-dedicated-1}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TGZ=$(mktemp -t luk-app-XXXX.tgz)

printf '\n\033[1;35m==>\033[0m empacotando %s\n' "$HERE"
tar -czf "$TGZ" -C "$HERE" server web deploy

printf '\033[1;35m==>\033[0m enviando para %s\n' "$HOST"
scp -q "$TGZ" "$HOST:/tmp/luk-app.tgz"
rm -f "$TGZ"

printf '\033[1;35m==>\033[0m instalando\n'
ssh "$HOST" '
  rm -rf /tmp/luk-stage && mkdir -p /tmp/luk-stage
  cd /tmp/luk-stage && tar -xzf /tmp/luk-app.tgz
  sudo bash deploy/install.sh
'

printf '\033[1;35m==>\033[0m conferindo pela internet\n'
curl -fsS -o /dev/null -w '   https://bolla.network -> HTTP %{http_code} em %{time_total}s\n' \
  https://bolla.network
echo
