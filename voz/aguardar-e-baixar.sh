#!/usr/bin/env bash
# =========================================================================
# Espera o treino acabar no pod e BAIXA o modelo, aqui no servidor.
#
#   nohup setsid bash aguardar-e-baixar.sh > ~/voz/espera.log 2>&1 &
#
# Roda NO SERVIDOR, nao na maquina de quem pediu.
#
# Existe por um erro que quase custou o treino: o esperador rodava como um ssh
# em dois saltos (maquina -> servidor -> pod) e morreu com codigo 255 quando a
# conexao caiu. O treino sobreviveu porque estava solto no pod, mas se tivesse
# acabado naquela janela, ninguem baixaria o modelo — e **encerrar o pod apaga
# o volume**. O arquivo se perderia.
#
# Entao a regra: quem espera tem de estar do lado de quem guarda. Este script
# fica no servidor, reconecta ao pod quantas vezes precisar, e o download
# acontece aqui. Se a conexao de quem pediu cair, nao muda nada.
# =========================================================================
set -uo pipefail   # sem -e de proposito: queda de ssh e esperada, nao e fim

POD=${POD:-pod}
DESTINO=${DESTINO:-$HOME/voz/modelo}
ESTADO=$DESTINO/ESTADO
ESPERA=20          # segundos entre olhadas
PACIENCIA=14400    # 4 horas de teto, para nao esperar para sempre

mkdir -p "$DESTINO"

no_pod() {
  ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -o BatchMode=yes -o LogLevel=ERROR "$POD" "$1" 2>/dev/null
}

anotar() { printf '%s  %s\n' "$(date -u +'%F %T')" "$*" | tee -a "$ESTADO"; }

anotar "esperando o treino terminar"

inicio=$(date +%s)
while :; do
  if (( $(date +%s) - inicio > PACIENCIA )); then
    anotar "DESISTI: passou de 4 horas esperando"
    exit 3
  fi

  # Uma unica ida ao pod por rodada, trazendo tudo o que interessa.
  leitura=$(no_pod '
    if grep -q "BAIXE ISTO" /workspace/treino.log 2>/dev/null; then echo PRONTO
    elif grep -qE "Traceback|CUDA out of memory" /workspace/treino.log 2>/dev/null; then echo ERRO
    elif pgrep -f treinar.py >/dev/null || pgrep -f treinar-no-pod >/dev/null; then echo RODANDO
    else echo SUMIU
    fi
    grep -o "Epoch [0-9]*" /workspace/treino.log 2>/dev/null | tail -1 | tr -d "\r"
  ')

  # Conexao caiu: nao e motivo para desistir. Tenta de novo na proxima volta.
  if [[ -z $leitura ]]; then
    sleep "$ESPERA"
    continue
  fi

  situacao=$(head -1 <<<"$leitura")
  epoca=$(sed -n 2p <<<"$leitura")

  case $situacao in
    RODANDO)
      sleep "$ESPERA"
      ;;
    PRONTO|SUMIU)
      # SUMIU tambem desce: o treino salva checkpoint a cada epoca, e se o
      # processo morreu sem exportar, o que existir ainda vale mais no
      # servidor do que num volume que vai ser apagado.
      anotar "treino terminou ($situacao, $epoca) — baixando"
      ok=1
      for f in voz.onnx voz.onnx.json; do
        if scp -o ConnectTimeout=20 -o BatchMode=yes -o LogLevel=ERROR \
               "$POD:/workspace/saida/$f" "$DESTINO/$f" 2>/dev/null; then
          anotar "  baixado $f  ($(stat -c %s "$DESTINO/$f") bytes)"
        else
          anotar "  FALTOU $f"
          ok=0
        fi
      done
      # O ultimo checkpoint tambem desce: e o unico jeito de treinar mais
      # depois sem comecar de novo do zero.
      # Pergunta o caminho em vez de chutar: o numero da versao muda a cada
      # relancamento do treino, e `version_2` so vale para esta corrida.
      ULT=$(no_pod 'ls -1t /workspace/saida/lightning_logs/*/checkpoints/last.ckpt 2>/dev/null | head -1')
      if [[ -n $ULT ]] && scp -o ConnectTimeout=20 -o BatchMode=yes -o LogLevel=ERROR \
             "$POD:$ULT" "$DESTINO/ultimo.ckpt" 2>/dev/null; then
        anotar "  baixado ultimo.ckpt  ($(stat -c %s "$DESTINO/ultimo.ckpt") bytes)"
      else
        anotar "  sem ultimo.ckpt (da para viver sem, mas treinar mais exigiria recomecar)"
      fi
      no_pod 'tail -40 /workspace/treino.log | tr -d "\r"' > "$DESTINO/fim-do-treino.log"
      anotar "$([[ $ok == 1 ]] && echo 'TUDO AQUI — o pod pode ser encerrado' || echo 'INCOMPLETO — NAO encerre o pod ainda')"
      exit $(( ok == 1 ? 0 : 4 ))
      ;;
    ERRO)
      anotar "TREINO FALHOU na $epoca — veja /workspace/treino.log no pod"
      no_pod 'grep -A24 "Traceback" /workspace/treino.log | tr -d "\r" | head -40' \
        > "$DESTINO/erro.log"
      exit 5
      ;;
  esac
done
