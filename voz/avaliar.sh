#!/usr/bin/env bash
# =========================================================================
# Avalia audios de referencia e gera uma amostra clonada de cada um.
#
#   bash avaliar.sh <pasta-com-audios>
#
# Faz, para cada arquivo:
#   1. mede duracao, nivel e conteudo espectral — e diz se serve
#   2. prepara a referencia como o modelo quer (24 kHz, normalizada, aparada)
#   3. gera uma frase de teste com aquela voz
#
# Existe porque a qualidade da referencia e o que mais muda o resultado, e
# porque ja perdi um teste inteiro por mandar ao modelo um arquivo de 16 kHz
# que era sobra do teste de transcricao (plan.md §31.8).
# =========================================================================
set -uo pipefail

ENTRADA=${1:-}
[ -d "$ENTRADA" ] || { echo "uso: bash avaliar.sh <pasta-com-audios>"; exit 1; }

VOZ=~/voz
REFS=$VOZ/refs-novas
SAIDA=$VOZ/saidas-novas
mkdir -p "$REFS" "$SAIDA"

echo "=============================================================="
echo " DIAGNOSTICO"
echo "=============================================================="
printf "%-22s %7s %9s %9s %9s  %s\n" "arquivo" "dur" "medio" "8-12kHz" "15k+" "veredito"

nivel() {
  ffmpeg -i "$1" -af "${2:-anull},volumedetect" -f null - 2>&1 |
    grep mean_volume | sed 's/.*mean_volume: //;s/ dB//'
}

for f in "$ENTRADA"/*.{wav,mp3,m4a,flac,ogg,opus}; do
  [ -e "$f" ] || continue
  nome=$(basename "$f")

  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null)
  [ -z "$dur" ] && continue
  sr=$(ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of default=nw=1:nk=1 "$f")

  med=$(nivel "$f")
  brilho=$(nivel "$f" "highpass=f=8000,lowpass=f=12000")
  alto=$(nivel "$f" "highpass=f=15000")

  # Veredito: o que de fato atrapalha o clone.
  v=""
  (( $(echo "$dur < 8" | bc -l) )) && v="$v curto;"
  (( $(echo "$dur > 40" | bc -l) )) && v="$v longo demais;"
  [ "$sr" -lt 24000 ] 2>/dev/null && v="$v TAXA BAIXA ($sr Hz);"
  (( $(echo "$brilho < -55" | bc -l) )) && v="$v sem brilho;"
  (( $(echo "$med > -10" | bc -l) )) && v="$v alto demais, risco de corte;"
  [ -z "$v" ] && v=" ok"

  printf "%-22s %6.1fs %8sdB %8sdB %8sdB  %s\n" "$nome" "$dur" "$med" "$brilho" "$alto" "$v"

  # Referencia como o modelo quer: 24 kHz mono, silencio aparado, loudness igual.
  base="${nome%.*}"
  ffmpeg -y -loglevel error -i "$f" \
    -af "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_silence=0.1:start_threshold=-45dB,areverse,loudnorm=I=-18:TP=-2:LRA=7" \
    -ar 24000 -ac 1 "$REFS/$base.wav"
done

echo
echo "referencias preparadas em $REFS"
echo
echo "=============================================================="
echo " GERANDO UMA AMOSTRA DE CADA (na CPU: ~2 min por arquivo)"
echo "=============================================================="

cd "$VOZ" && ./venv/bin/python gerar-amostras.py "$REFS" "$SAIDA"

echo
for w in "$SAIDA"/*.wav; do
  [ -e "$w" ] || continue
  ffmpeg -y -loglevel error -i "$w" -b:a 160k "${w%.wav}.mp3"
done
echo "amostras em $SAIDA (wav e mp3)"
