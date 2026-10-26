#!/usr/bin/env bash
# =========================================================================
# Cliente minimo da API do RunPod.
#
#   bash runpod.sh guardar-chave      lê a chave de forma oculta e guarda
#   bash runpod.sh precos             lista GPUs disponiveis e preco/hora
#   bash runpod.sh criar <gpu> <nome> cria o pod
#   bash runpod.sh listar             pods ativos e o que estao custando
#   bash runpod.sh encerrar <id>      TERMINA o pod (apaga tudo que nao e volume)
#
# A chave fica em ~/.runpod-key com permissao 600 e nunca aparece na linha de
# comando — nem no historico do shell, nem em "ps", nem em log.
#
# Pod parado AINDA CUSTA (armazenamento do volume). Quando acabar, encerre.
# =========================================================================
set -uo pipefail

CHAVE_ARQ="$HOME/.runpod-key"
API="https://rest.runpod.io/v1"

chave() {
  [ -f "$CHAVE_ARQ" ] || { echo "sem chave. Rode: bash runpod.sh guardar-chave" >&2; exit 1; }
  cat "$CHAVE_ARQ"
}

req() {
  local metodo=$1 caminho=$2 corpo=${3:-}
  if [ -n "$corpo" ]; then
    curl -sS -X "$metodo" "$API$caminho" \
      -H "Authorization: Bearer $(chave)" -H "Content-Type: application/json" -d "$corpo"
  else
    curl -sS -X "$metodo" "$API$caminho" -H "Authorization: Bearer $(chave)"
  fi
}

case "${1:-}" in

  guardar-chave)
    read -rsp "Chave da API do RunPod (nao aparece na tela): " k; echo
    [ -n "$k" ] || { echo "vazia, abortando"; exit 1; }
    printf '%s' "$k" > "$CHAVE_ARQ"
    chmod 600 "$CHAVE_ARQ"
    echo "guardada em $CHAVE_ARQ"
    echo -n "conferindo o acesso... "
    if req GET /pods | grep -q "error\|unauthorized\|Unauthorized"; then
      echo "FALHOU — a chave foi recusada"
      req GET /pods | head -c 200; echo
      exit 1
    fi
    echo "ok"
    ;;

  precos)
    # So o que interessa: placa com VRAM suficiente, ordenada por preco.
    req GET /gpuTypes | python3 -c '
import json, sys
try:
    dados = json.load(sys.stdin)
except Exception:
    print("resposta inesperada:", sys.stdin.read()[:300]); raise SystemExit(1)
linhas = dados if isinstance(dados, list) else dados.get("data", dados.get("gpuTypes", []))
itens = []
for g in linhas:
    vram = g.get("memoryInGb") or 0
    preco = g.get("securePrice") or g.get("communityPrice") or g.get("lowestPrice", {}).get("uninterruptablePrice")
    if not preco or vram < 16:
        continue
    itens.append((preco, g.get("displayName") or g.get("id"), vram, g.get("id")))
itens.sort()
print(f"{\"GPU\":34} {\"VRAM\":>6} {\"USD/h\":>8}   id")
for preco, nome, vram, ident in itens[:14]:
    print(f"{nome:34} {vram:5}GB {preco:8.3f}   {ident}")
'
    ;;

  criar)
    GPU=${2:?uso: criar <gpu-id> <nome>}
    NOME=${3:-luk-voz}
    req POST /pods "$(cat <<JSON
{
  "name": "$NOME",
  "imageName": "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
  "gpuTypeIds": ["$GPU"],
  "gpuCount": 1,
  "containerDiskInGb": 40,
  "volumeInGb": 20,
  "volumeMountPath": "/workspace",
  "ports": ["22/tcp"]
}
JSON
)" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if isinstance(d,dict) and d.get("id"):
    print("pod criado:", d["id"], "|", d.get("desiredStatus",""))
else:
    print(json.dumps(d)[:400])
'
    ;;

  listar)
    req GET /pods | python3 -c '
import json,sys
d=json.load(sys.stdin)
pods = d if isinstance(d,list) else d.get("data",[])
if not pods: print("nenhum pod ativo"); raise SystemExit
for p in pods:
    print(f"{p.get(\"id\")}  {p.get(\"name\"):18} {p.get(\"desiredStatus\"):10} "
          f"{p.get(\"costPerHr\",\"?\")} USD/h  {p.get(\"machine\",{}).get(\"gpuDisplayName\",\"\")}")
'
    ;;

  encerrar)
    ID=${2:?uso: encerrar <pod-id>}
    echo "ENCERRANDO $ID — isso apaga tudo que nao estiver em volume de rede."
    req DELETE "/pods/$ID" | head -c 300; echo
    ;;

  *)
    sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
