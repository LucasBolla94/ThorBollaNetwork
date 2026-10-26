#!/usr/bin/env bash
# =========================================================================
# Manda os scripts de treino para o pod, do jeito certo.
#
#   bash enviar-ao-pod.sh            # so os scripts
#   bash enviar-ao-pod.sh --corpus   # scripts + corpus
#
# Existe por um erro que custou tempo e credito: os scripts foram copiados da
# maquina Windows direto para o pod, e chegaram com fim de linha CRLF. O bash
# leu `set -euo pipefail\r` e recusou com "pipefail: invalid option name" —
# mensagem que nao diz nada sobre o verdadeiro problema.
#
# O `.gitattributes` do projeto forca LF, mas isso vale para o que o git grava.
# Um `scp` da copia de trabalho no Windows passa por fora dele.
#
# Entao a regra aqui e: copiar do CLONE DO SERVIDOR, que tem LF, e ainda assim
# tirar qualquer CR que escape. Cinto e suspensorio, porque o sintoma e
# enganoso demais para confiar so no cinto.
# =========================================================================
set -euo pipefail

REPO=${REPO:-/opt/thor/repo}
POD=${POD:-pod}
ORIGEM=$REPO/voz

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

[[ -d $ORIGEM ]] || { echo "nao achei $ORIGEM"; exit 1; }

log "scripts"
for f in treinar-no-pod.sh treinar.py limpar-ajustes.py; do
  [[ -f $ORIGEM/$f ]] || { echo "   falta $f"; exit 1; }
  scp -q "$ORIGEM/$f" "$POD:/workspace/$f"
  echo "   $f"
done
ssh "$POD" 'cd /workspace && sed -i "s/\r$//" treinar-no-pod.sh treinar.py limpar-ajustes.py'
echo "   fim de linha conferido"

if [[ ${1:-} == --corpus ]]; then
  log "corpus"
  tar -czf /tmp/corpus.tgz -C "$HOME/voz" corpus
  scp -q /tmp/corpus.tgz "$POD:/workspace/"
  rm -f /tmp/corpus.tgz
  ssh "$POD" 'cd /workspace && tar -xzf corpus.tgz && rm -f corpus.tgz'
  ssh "$POD" 'echo "   $(ls /workspace/corpus/wavs | wc -l) arquivos de audio"'
fi

log "pronto"
echo "   para treinar:  ssh $POD 'cd /workspace && nohup bash treinar-no-pod.sh 1000 > treino.log 2>&1 &'"
