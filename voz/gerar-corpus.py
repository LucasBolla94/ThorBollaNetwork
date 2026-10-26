# -*- coding: utf-8 -*-
"""
Gera o corpus de audio que vai treinar a voz final.

Le as frases do corpus.py, fala cada uma com a voz de referencia e salva no
formato que o treino do Piper espera (LJSpeech):

    corpus/
      wavs/0001.wav, 0002.wav, ...
      metadata.csv        ->  0001|texto da frase

Dois cuidados que vem do que ja deu errado antes:

  - **retoma de onde parou.** Na CPU do servidor cada frase leva ~40s, entao
    isto roda por horas. Se cair, nao recomeca do zero.
  - **descarta frase que saiu torta.** O modelo as vezes entra em repeticao e o
    proprio codigo dele corta a geracao a forca; isso aparece como audio curto
    demais ou longo demais para o texto. Frase ruim no dataset ensina o erro.
"""

import csv
import sys
import time
import wave
from pathlib import Path

import torch

torch.set_num_threads(int(sys.argv[3]) if len(sys.argv) > 3 else 8)
from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # noqa: E402

REF = sys.argv[1]
DESTINO = Path(sys.argv[2])
WAVS = DESTINO / "wavs"
META = DESTINO / "metadata.csv"
WAVS.mkdir(parents=True, exist_ok=True)

# Quanto tempo de fala e plausivel por palavra. Fora disto, a geracao escorregou.
SEG_POR_PALAVRA = (0.18, 0.75)


def salvar(wav, caminho: Path, sr: int) -> float:
    dados = (wav.squeeze().clamp(-1, 1) * 32767).to(torch.int16).numpy().tobytes()
    with wave.open(str(caminho), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(dados)
    return len(dados) / 2 / sr


frases = [l.strip() for l in sys.stdin if l.strip()]
feitas = set()
if META.exists():
    with META.open(encoding="utf-8") as f:
        feitas = {linha.split("|")[0] for linha in f if "|" in linha}

print(f"{len(frases)} frases | {len(feitas)} ja prontas", flush=True)

modelo = ChatterboxMultilingualTTS.from_pretrained(device="cpu")
print("modelo carregado, comecando", flush=True)

inicio = time.time()
total_audio = 0.0
descartadas = 0

with META.open("a", encoding="utf-8", newline="") as fmeta:
    escritor = csv.writer(fmeta, delimiter="|", quoting=csv.QUOTE_NONE, escapechar="\\")
    for i, texto in enumerate(frases, start=1):
        ident = f"{i:04d}"
        if ident in feitas:
            continue

        t0 = time.time()
        try:
            wav = modelo.generate(texto, language_id="pt", audio_prompt_path=REF)
        except Exception as e:  # noqa: BLE001
            print(f"{ident} FALHOU: {type(e).__name__}", flush=True)
            continue

        destino = WAVS / f"{ident}.wav"
        dur = salvar(wav, destino, modelo.sr)

        palavras = len(texto.split())
        minimo, maximo = SEG_POR_PALAVRA[0] * palavras, SEG_POR_PALAVRA[1] * palavras
        if not (minimo <= dur <= maximo):
            destino.unlink(missing_ok=True)
            descartadas += 1
            print(f"{ident} descartada: {dur:.1f}s para {palavras} palavras", flush=True)
            continue

        escritor.writerow([ident, texto])
        fmeta.flush()
        total_audio += dur

        if i % 10 == 0 or i == len(frases):
            passado = time.time() - inicio
            feito = i - len(feitas)
            resta = (len(frases) - i) * (passado / max(1, feito))
            print(
                f"{i}/{len(frases)} | {total_audio/60:.1f} min de audio | "
                f"descartadas {descartadas} | faltam ~{resta/3600:.1f}h",
                flush=True,
            )

print(f"PRONTO: {total_audio/60:.1f} minutos de audio em {DESTINO}", flush=True)
