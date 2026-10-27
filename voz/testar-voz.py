# -*- coding: utf-8 -*-
"""Sintetiza frases com a voz treinada e mede se o resultado presta.

    python3 testar-voz.py <voz.onnx> <pasta-de-saida>

Existe porque "o arquivo baixou" nao e a mesma coisa que "a voz funciona". Um
ONNX pode carregar e devolver silencio, ou devolver o tom errado, e os dois
parecem sucesso para quem so olha o tamanho do arquivo.

As frases sao **acentuadas de proposito**. Texto sem acento muda a silaba
tonica e some com a nasalizacao — foi o que estragou a primeira rodada de
testes da voz clonada, e a licao vale igual aqui.

O que e medido, e por que:

  duracao     silencio total sai como 0,0s. Tambem pega o caso em que o
              modelo entra em laco e gera audio sem fim.
  nivel       um ONNX quebrado costuma devolver quase-zero. Abaixo de 0,01
              nao e voz, e ruido de fundo.
  recorte     amostra encostada no limite significa distorcao audivel.
  velocidade  quantos segundos de audio por segundo de CPU. Decide se a voz
              pode responder em tempo real no servidor, sem GPU.
"""
import json
import struct
import sys
import time
import wave
from pathlib import Path

FRASES = [
    "Bom dia, Lucas.",
    "O servidor está estável, nenhum alerta desde ontem.",
    "Você tem uma reunião em quarenta e cinco minutos, e eu já separei a pauta.",
    "Com apenas dezenove por cento de energia, as chances não são boas, senhor.",
    "Identifiquei três caminhos. O primeiro é mais rápido, mas apaga o histórico.",
]


def medir(caminho):
    """Le o wav e devolve (duracao, nivel medio, pico, fracao recortada)."""
    with wave.open(str(caminho), "rb") as w:
        quadros = w.getnframes()
        taxa = w.getframerate()
        largura = w.getsampwidth()
        bruto = w.readframes(quadros)
    if largura != 2 or quadros == 0:
        return 0.0, 0.0, 0.0, 0.0, taxa
    amostras = struct.unpack("<%dh" % quadros, bruto)
    soma = 0
    pico = 0
    recortadas = 0
    for a in amostras:
        v = a if a >= 0 else -a
        soma += v
        if v > pico:
            pico = v
        if v >= 32700:
            recortadas += 1
    n = len(amostras)
    return quadros / taxa, soma / n / 32768, pico / 32768, recortadas / n, taxa


def main():
    modelo, pasta = Path(sys.argv[1]), Path(sys.argv[2])
    pasta.mkdir(parents=True, exist_ok=True)

    config = json.loads(Path(str(modelo) + ".json").read_text(encoding="utf-8"))
    print("  modelo      %s (%.0f MB)" % (modelo.name, modelo.stat().st_size / 1e6))
    print("  amostragem  %s Hz" % config.get("audio", {}).get("sample_rate"))

    from piper import PiperVoice

    t0 = time.monotonic()
    voz = PiperVoice.load(str(modelo), config_path=str(modelo) + ".json")
    print("  carregou em %.1f s" % (time.monotonic() - t0))
    print()
    print("  %-52s %6s %7s %6s %7s" % ("frase", "dur", "nivel", "pico", "x tempo"))

    problemas = []
    for i, frase in enumerate(FRASES, 1):
        destino = pasta / ("frase-%d.wav" % i)
        t0 = time.monotonic()
        with wave.open(str(destino), "wb") as w:
            voz.synthesize_wav(frase, w)
        gasto = time.monotonic() - t0

        dur, nivel, pico, recorte, taxa = medir(destino)
        veloc = (dur / gasto) if gasto > 0 else 0
        corte = frase if len(frase) <= 52 else frase[:49] + "..."
        print("  %-52s %5.1fs %7.3f %6.2f %6.1fx" % (corte, dur, nivel, pico, veloc))

        if dur < 0.3:
            problemas.append("frase %d saiu muda (%.2fs)" % (i, dur))
        elif nivel < 0.01:
            problemas.append("frase %d saiu quase sem sinal (nivel %.4f)" % (i, nivel))
        elif recorte > 0.001:
            problemas.append("frase %d recorta em %.1f%% das amostras" % (i, recorte * 100))
        elif taxa != config.get("audio", {}).get("sample_rate"):
            problemas.append("frase %d saiu a %d Hz, o modelo diz %s" % (i, taxa, config.get("audio", {}).get("sample_rate")))

    print()
    if problemas:
        print("  NAO PASSOU:")
        for p in problemas:
            print("    - " + p)
        return 1
    print("  PASSOU: todas as frases geraram audio com sinal, no tom certo.")
    print("  amostras em %s" % pasta)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
