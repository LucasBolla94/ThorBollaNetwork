#!/usr/bin/env bash
# =========================================================================
# Confere o codigo daqui ANTES de publicar.
#
#   bash infra/verificar.sh
#
# Existe por causa de um erro concreto: ao quebrar o index.ts de mil linhas em
# modulos, duas funcoes ficaram definidas num arquivo e usadas em outro, sem
# import. Nenhum teste de unidade pegou — so quebrava na primeira mensagem de
# uma conversa nova, em producao.
#
# O projeto roda TypeScript sem compilar, entao nao ha etapa de build que
# tropece nisso sozinha. Esta e essa etapa.
#
# A primeira versao conferia o que ja estava NO SERVIDOR, o que e o avesso do
# util: aprovava o codigo velho e deixava passar o novo. Agora envia o codigo
# local para um diretorio temporario e confere ESSE — as dependencias ficam no
# servidor, e sem elas o compilador nao resolve os imports e deixa de enxergar
# justamente o que interessa.
# =========================================================================
set -uo pipefail

MAQUINA=${MAQUINA:-dedicated-1}
AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

printf '\n\033[1;35m==>\033[0m conferindo o codigo local em %s\n' "$MAQUINA"

TGZ=$(mktemp -t thor-src-XXXX.tgz)
tar -czf "$TGZ" -C "$AQUI/server" src testes
scp -q "$TGZ" "$MAQUINA:/tmp/thor-src.tgz"
rm -f "$TGZ"

ssh "$MAQUINA" bash -s <<'REMOTO'
set -uo pipefail
TSC=/tmp/ts/node_modules/.bin/tsc
if [[ ! -x $TSC ]]; then
  mkdir -p /tmp/ts && cd /tmp/ts && npm i --no-save --silent typescript@5 >/dev/null 2>&1
fi
[[ -x $TSC ]] || { echo "   nao consegui instalar o typescript"; exit 1; }

# O codigo que veio daqui, com as dependencias que ja estao no servidor.
rm -rf /tmp/thor-check && mkdir -p /tmp/thor-check
tar -xzf /tmp/thor-src.tgz -C /tmp/thor-check
ln -sfn /opt/thor/repo/server/node_modules /tmp/thor-check/node_modules
cp /opt/thor/repo/server/package.json /tmp/thor-check/ 2>/dev/null || true

cd /tmp/thor-check
SAIDA=$("$TSC" --noEmit --skipLibCheck --target esnext --module nodenext \
  --moduleResolution nodenext --allowImportingTsExtensions \
  $(find src testes -name '*.ts') 2>&1)

# TS2307 em `node:*` e so a falta de @types/node, que nao instalamos de
# proposito: o projeto nao compila, entao tipos de biblioteca sao peso sem uso.
# O que importa e nome que nao existe, export que nao existe e erro de sintaxe.
GRAVES=$(echo "$SAIDA" | grep -E 'TS2304|TS2552|TS2305|TS2724|TS1[0-9]{3}' || true)

rm -rf /tmp/thor-check /tmp/thor-src.tgz

if [[ -n $GRAVES ]]; then
  echo "$GRAVES" | sed 's/^/   /'
  echo
  echo "   $(echo "$GRAVES" | wc -l) problema(s). Nao publique assim."
  exit 1
fi
echo "   nenhum nome solto, nenhum erro de sintaxe"
REMOTO
