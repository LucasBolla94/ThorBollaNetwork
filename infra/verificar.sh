#!/usr/bin/env bash
# =========================================================================
# Confere o codigo do servidor antes de publicar.
#
#   bash infra/verificar.sh
#
# Existe por causa de um erro concreto: ao quebrar o index.ts de mil linhas em
# modulos, duas funcoes ficaram definidas num arquivo e usadas em outro, sem
# import. Nenhum teste de unidade pegou — so quebrava na primeira mensagem de
# uma conversa nova, em producao.
#
# O projeto roda TypeScript sem compilar, entao nao ha etapa de build que
# tropece nisso sozinha. Esta e essa etapa, rodada de proposito.
#
# Roda no servidor, onde as dependencias existem. Sem elas o compilador nao
# resolve os imports e deixa de enxergar justamente o que interessa.
# =========================================================================
set -uo pipefail

MAQUINA=${MAQUINA:-dedicated-1}
REPO=/opt/thor/repo

printf '\n\033[1;35m==>\033[0m conferindo o codigo em %s\n' "$MAQUINA"

ssh "$MAQUINA" bash -s <<'REMOTO'
set -uo pipefail
TSC=/tmp/ts/node_modules/.bin/tsc
if [[ ! -x $TSC ]]; then
  mkdir -p /tmp/ts && cd /tmp/ts && npm i --no-save --silent typescript@5 >/dev/null 2>&1
fi
[[ -x $TSC ]] || { echo "   nao consegui instalar o typescript"; exit 1; }

cd /opt/thor/repo/server
SAIDA=$("$TSC" --noEmit --skipLibCheck --target esnext --module nodenext \
  --moduleResolution nodenext --allowImportingTsExtensions \
  $(find src testes -name '*.ts') 2>&1)

# TS2307 em `node:*` e so a falta de @types/node, que nao instalamos de
# proposito: o projeto nao compila, entao tipos de biblioteca sao peso sem uso.
# O que importa e nome que nao existe e export que nao existe.
GRAVES=$(echo "$SAIDA" | grep -E 'TS2304|TS2552|TS2305|TS2724|TS1[0-9]{3}' || true)

if [[ -n $GRAVES ]]; then
  echo "$GRAVES" | sed 's/^/   /'
  echo
  echo "   $(echo "$GRAVES" | wc -l) problema(s)."
  exit 1
fi
echo "   nenhum nome solto, nenhum erro de sintaxe"
REMOTO
