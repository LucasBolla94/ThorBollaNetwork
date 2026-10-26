#!/usr/bin/env bash
# =========================================================================
# Treina a voz do dono, dentro do pod alugado.
#
#   bash treinar-no-pod.sh [epocas-extras]
#
# Roda DENTRO do pod, nao no servidor. O corpus ja tem de estar em
# /workspace/corpus (metadata.csv + wavs/), enviado antes.
#
# Tudo fica em /workspace, que e o volume: sobrevive a reiniciar o pod.
# O container disk nao sobrevive, entao nada importante mora fora dali.
#
# No fim ele deixa /workspace/saida/voz.onnx, que e o que precisa descer para
# o servidor ANTES de o pod ser encerrado — encerrar apaga o volume junto.
# =========================================================================
set -euo pipefail

EXTRAS=${1:-1000}
TRABALHO=/workspace
CORPUS=$TRABALHO/corpus
SAIDA=$TRABALHO/saida
CKPT=$TRABALHO/base

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

[[ -d $CORPUS/wavs ]] || { echo "corpus ausente em $CORPUS"; exit 1; }
mkdir -p "$SAIDA" "$CKPT"

log "a maquina"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | sed 's/^/   /'
python3 -c "import torch; print('   torch', torch.__version__, '| cuda', torch.cuda.is_available())"

log "piper (treino)"
if ! python3 -c "import piper.train" 2>/dev/null; then
  pip install -q 'piper-tts[train]' 2>&1 | tail -2 || pip install -q piper-tts 2>&1 | tail -2
fi
python3 -c "import piper; print('   piper', getattr(piper, '__version__', 'ok'))"

log "checkpoint base (pt-BR)"
# Voz masculina pt-BR de qualidade media, ja com 6159 epocas. Ajustar a partir
# daqui e MUITO mais rapido e melhor que comecar do zero — com 19 minutos de
# audio, comecar do zero nem daria voz utilizavel.
BASE=$CKPT/faber.ckpt
if [[ ! -f $BASE ]]; then
  URL=https://huggingface.co/datasets/rhasspy/piper-checkpoints/resolve/main/pt/pt_BR/faber/medium
  curl -fL --progress-bar "$URL/epoch%3D6159-step%3D1230728.ckpt" -o "$BASE"
  curl -fsSL "$URL/config.json" -o "$CKPT/config.json"
fi
ls -lh "$BASE" | awk '{print "   " $5, $9}'

log "preparando o corpus"
# 22050 Hz e o que o checkpoint medium espera. Mandar outra taxa aqui nao da
# erro: da uma voz com o tom errado, que e pior porque parece que funcionou.
python3 -m piper.train.preprocess \
  --input-dir "$CORPUS" \
  --output-dir "$TRABALHO/preparado" \
  --language pt_BR \
  --dataset-format ljspeech \
  --single-speaker \
  --sample-rate 22050 2>&1 | tail -5

log "treinando (+$EXTRAS epocas sobre as 6159 do checkpoint)"
# max_epochs e o TOTAL, nao o quanto somar. Pedir 1000 aqui faria o treino
# terminar na hora, por ja estar em 6159.
TOTAL=$((6159 + EXTRAS))
echo "   indo ate a epoca $TOTAL"

# Lote 32 cabe em 24 GB. Em placa menor, baixar para 16 so muda a velocidade,
# nao a qualidade do resultado.
LOTE=${LOTE:-32}

python3 -m piper.train fit \
  --data.voice_name "thor" \
  --data.csv_path "$TRABALHO/preparado/dataset.jsonl" \
  --data.config_path "$TRABALHO/preparado/config.json" \
  --data.cache_dir "$TRABALHO/cache" \
  --data.batch-size "$LOTE" \
  --ckpt_path "$BASE" \
  --trainer.max_epochs "$TOTAL" \
  --trainer.default_root_dir "$SAIDA" \
  --trainer.accelerator gpu \
  --trainer.devices 1 2>&1 | tail -40

log "exportando para onnx"
ULTIMO=$(find "$SAIDA" -name '*.ckpt' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)
[[ -n $ULTIMO ]] || { echo "nenhum checkpoint foi gerado"; exit 1; }
echo "   usando $ULTIMO"

python3 -m piper.train.export_onnx \
  --checkpoint "$ULTIMO" \
  --output-file "$SAIDA/voz.onnx" 2>&1 | tail -5
cp "$TRABALHO/preparado/config.json" "$SAIDA/voz.onnx.json"

log "pronto"
ls -lh "$SAIDA"/voz.onnx* | awk '{print "   " $5, $9}'
echo
echo "   BAIXE ISTO ANTES DE ENCERRAR O POD:"
echo "     $SAIDA/voz.onnx"
echo "     $SAIDA/voz.onnx.json"
echo
echo "   Encerrar o pod apaga o volume. O que nao descer, se perde."
