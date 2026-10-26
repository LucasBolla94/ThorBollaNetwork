#!/usr/bin/env bash
# =========================================================================
# Treina a voz do dono, dentro do pod alugado.
#
#   bash treinar-no-pod.sh [epocas-extras]
#
# Roda DENTRO do pod. O corpus ja tem de estar em /workspace/corpus
# (metadata.csv + wavs/), enviado antes.
#
# Tudo fica em /workspace, que e o volume: sobrevive a reiniciar o pod. O
# container disk nao sobrevive, entao nada importante mora fora dali.
#
# No fim deixa /workspace/saida/voz.onnx, que precisa DESCER para o servidor
# antes de o pod ser encerrado — encerrar apaga o volume junto.
# =========================================================================
set -euo pipefail

EXTRAS=${1:-1000}
LOTE=${LOTE:-32}
TRABALHO=/workspace
CORPUS=$TRABALHO/corpus
SAIDA=$TRABALHO/saida
CKPT=$TRABALHO/base

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

[[ -d $CORPUS/wavs ]] || { echo "corpus ausente em $CORPUS"; exit 1; }
mkdir -p "$SAIDA" "$CKPT" "$TRABALHO/cache"

log "a maquina"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | sed 's/^/   /'
python3 -c "import torch; print('   torch', torch.__version__, '| cuda', torch.cuda.is_available())"

log "piper (treino)"
python3 -c "import piper.train" 2>/dev/null || pip install -q 'piper-tts[train]' 2>&1 | tail -2
python3 -c "import piper; print('   piper', getattr(piper, '__version__', 'ok'))"

# O pacote publicado vem INCOMPLETO para treino: falta a extensao compilada
# `monotonic_align`, e falta ate o fonte dela (`core.pyx`) de onde compilar. O
# erro so aparece depois de baixar 800 MB de checkpoint e montar o treino
# inteiro — "No module named piper.train.vits.monotonic_align.monotonic_align".
#
# Entao: busca o fonte no repositorio, compila, e poe o resultado no
# subdiretorio aninhado que o __init__.py espera. Os tres passos sao
# necessarios; os dois primeiros sozinhos deixam o erro igual.
if ! python3 -c "from piper.train.vits.monotonic_align import maximum_path" 2>/dev/null; then
  log "compilando a extensao que falta no pacote"
  PKG=$(python3 -c "import piper, os; print(os.path.dirname(os.path.dirname(piper.__file__)))")
  MA=$PKG/piper/train/vits/monotonic_align
  pip install -q cython numpy 2>&1 | tail -1
  curl -fsSL -m 30 \
    https://raw.githubusercontent.com/OHF-Voice/piper1-gpl/main/src/piper/train/vits/monotonic_align/core.pyx \
    -o "$MA/core.pyx"
  # De dentro de $PKG: o setup usa caminho relativo para gravar o .so.
  (cd "$PKG" && python3 piper/train/vits/monotonic_align/setup.py build_ext --inplace >/dev/null 2>&1)
  mkdir -p "$MA/monotonic_align"
  touch "$MA/monotonic_align/__init__.py"
  cp "$MA"/core.cpython-*.so "$MA/monotonic_align/"
  python3 -c "from piper.train.vits.monotonic_align import maximum_path; print('   extensao pronta')"
fi

log "checkpoint base (pt-BR)"
# Voz masculina pt-BR, qualidade media, ja com 6159 epocas. Ajustar a partir
# daqui e o que torna 19 minutos de audio viavel: do zero nao sairia voz
# utilizavel com tao pouco material.
BASE=$CKPT/faber.ckpt
if [[ ! -f $BASE ]]; then
  URL=https://huggingface.co/datasets/rhasspy/piper-checkpoints/resolve/main/pt/pt_BR/faber/medium
  curl -fL -# "$URL/epoch%3D6159-step%3D1230728.ckpt" -o "$BASE"
  curl -fsSL "$URL/config.json" -o "$CKPT/config.json"
fi
# O checkpoint vem com os hiperparametros do treino anterior, e um deles
# (`sample_bytes`) nao existe mais — o treinador atual se recusa a comecar por
# causa disso. Sai apenas o dicionario de hiperparametros: pesos, otimizador
# e contadores ficam, porque o treinador precisa deles para retomar.
PESOS=$CKPT/ajustado.ckpt
[[ -f $PESOS ]] || python3 limpar-ajustes.py "$BASE" "$PESOS"
ls -lh "$PESOS" | awk '{print "   " $5, $9}'

log "treinando (+$EXTRAS epocas sobre as 6159 do checkpoint)"
# Tres coisas que, se saírem erradas, só aparecem no fim:
#
#   max_epochs e o TOTAL, nao o quanto somar. Pedir 1000 faria o treino
#   terminar na hora, por ja estar em 6159.
#
#   num_symbols tem de ser o do checkpoint (256). Diferente, o modelo nao
#   carrega — e a mensagem de erro fala de formato de tensor, nao de fonema.
#
#   O checkpoint e carregado por treinar.py, que autoriza so o tipo PosixPath
#   que ele guarda dentro. Abrir a trava inteira (weights_only=False) seria
#   executar o pickle de um arquivo baixado da internet, e isso nao se faz.
#
#   sample_rate tem de ser 22050, do checkpoint. Outro valor NAO da erro: da
#   voz com o tom errado, que e pior porque parece que funcionou.
TOTAL=$((6159 + EXTRAS))
echo "   ate a epoca $TOTAL, lote $LOTE"

python3 treinar.py fit \
  --data.voice_name thor \
  --data.csv_path "$CORPUS/metadata.csv" \
  --data.audio_dir "$CORPUS/wavs" \
  --data.config_path "$SAIDA/config.json" \
  --data.cache_dir "$TRABALHO/cache" \
  --data.espeak_voice pt-br \
  --data.num_symbols 256 \
  --data.batch_size "$LOTE" \
  --model.sample_rate 22050 \
  --model.num_speakers 1 \
  --ckpt_path "$PESOS" \
  --trainer.max_epochs "$TOTAL" \
  --trainer.default_root_dir "$SAIDA" \
  --trainer.accelerator gpu \
  --trainer.devices 1

log "exportando para onnx"
ULTIMO=$(find "$SAIDA" -name '*.ckpt' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)
[[ -n $ULTIMO ]] || { echo "nenhum checkpoint foi gerado"; exit 1; }
echo "   usando $ULTIMO"

python3 -m piper.train.export_onnx \
  --checkpoint "$ULTIMO" \
  --output-file "$SAIDA/voz.onnx"
cp "$SAIDA/config.json" "$SAIDA/voz.onnx.json"

log "pronto"
ls -lh "$SAIDA"/voz.onnx* | awk '{print "   " $5, $9}'
echo
echo "   BAIXE ISTO ANTES DE ENCERRAR O POD:"
echo "     $SAIDA/voz.onnx"
echo "     $SAIDA/voz.onnx.json"
