#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Por que a escuta esta lenta nesta maquina, e se tem jeito.

    python3 medir-escuta-fundo.py

A primeira medicao (medir-escuta.py) deu um veredito duro: nenhum modelo de
escuta alcanca a velocidade que uma conversa exige neste servidor. O `small`
transcreve a 0,7x — mais devagar do que a fala acontece.

Antes de desistir e partir para fora da maquina, tres hipoteses valem teste.
Cada uma, se verdadeira, muda a decisao:

**1. int8 pode ser mais LENTO que float32 aqui.**
O padrao para CPU e quantizar em int8, e em maquina moderna isso acelera
muito. Mas os nucleos int8 do CTranslate2 dependem de AVX2 e VNNI, e este
Xeon de 2013 tem apenas AVX. Sem essas instrucoes a quantizacao pode custar
mais do que economiza. Se float32 ganhar, resolve de graca.

**2. O custo pode ser FIXO por chamada, nao proporcional ao audio.**
O Whisper sempre processa uma janela de 30 segundos: audio menor e completado
com silencio. Se o gasto for quase o mesmo para 4s e para 20s, entao o
problema nao e "lento por segundo" e sim "caro por frase" — e a conclusao
pratica muda, porque juntar fala nao ajuda e cortar antes nao ajuda.

**3. Modelo menor pode trocar velocidade por erro de forma aceitavel.**
`base` e `tiny` sao mais rapidos. A pergunta e quanto erram em portugues
falado de verdade, com a voz do dono — nao em benchmark de locutor em ingles.
"""

import os
import sys
import time
import wave
from pathlib import Path

THREADS = int(os.environ.get("THREADS", "8"))
os.environ.setdefault("OMP_NUM_THREADS", str(THREADS))

CORPUS = Path(os.environ.get("CORPUS", Path.home() / "voz" / "corpus"))
QUANTAS = int(os.environ.get("QUANTAS", "8"))

sys.path.insert(0, str(Path(__file__).resolve().parent))
from medir_escuta_apoio import carregar, distancia, normalizar, pares  # noqa: E402

# (modelo, tipo de calculo). Ordem = ordem de teste.
COMBINACOES = [
    ("small", "int8"),
    ("small", "float32"),
    ("small", "int16"),
    ("base", "int8"),
    ("base", "float32"),
    ("tiny", "int8"),
]


def medir(nome, tipo, casos):
    from faster_whisper import WhisperModel

    try:
        modelo = WhisperModel(nome, device="cpu", compute_type=tipo, cpu_threads=THREADS)
    except Exception as e:  # noqa: BLE001
        print(f"  {nome:8} {tipo:8}  nao carregou: {type(e).__name__}")
        return None

    # Rodada fria fora da conta: a primeira paga o aquecimento do motor.
    list(modelo.transcribe(casos[0][0], language="pt", beam_size=1)[0])

    audio = 0.0
    gasto = 0.0
    erradas = 0
    palavras = 0
    por_frase = []

    for dados, dur, certo in casos:
        t0 = time.monotonic()
        trechos, _ = modelo.transcribe(dados, language="pt", beam_size=1)
        saiu = " ".join(t.text for t in trechos).strip()
        d = time.monotonic() - t0
        por_frase.append(d)

        esperado = normalizar(certo)
        erradas += distancia(esperado, normalizar(saiu))
        palavras += len(esperado)
        audio += dur
        gasto += d

    vezes = audio / gasto if gasto else 0
    erro = 100 * erradas / max(1, palavras)
    medio = sum(por_frase) / len(por_frase)
    print(f"  {nome:8} {tipo:8}  {vezes:5.2f}x  {erro:5.1f}% erro  "
          f"{medio:5.2f}s por frase")
    del modelo
    return {"modelo": nome, "tipo": tipo, "vezes": vezes, "erro": erro, "medio": medio}


def custo_fixo(casos):
    """Compara o gasto de uma frase curta com o de varias emendadas.

    Se o gasto quase nao mudar, o custo e por chamada e nao por segundo — e
    entao nao existe ajuste de tamanho de trecho que salve.
    """
    import numpy as np
    from faster_whisper import WhisperModel

    modelo = WhisperModel("small", device="cpu", compute_type="int8", cpu_threads=THREADS)
    list(modelo.transcribe(casos[0][0], language="pt", beam_size=1)[0])

    curta = casos[0][0]
    longa = np.concatenate([c[0] for c in casos])

    for rotulo, dados in (("uma frase", curta), ("todas emendadas", longa)):
        segundos = len(dados) / 16000
        t0 = time.monotonic()
        list(modelo.transcribe(dados, language="pt", beam_size=1)[0])
        gasto = time.monotonic() - t0
        print(f"  {rotulo:18} {segundos:5.1f}s de audio  ->  {gasto:5.2f}s  "
              f"({segundos / gasto:.2f}x)")
    del modelo


def main() -> int:
    casos = pares(CORPUS, QUANTAS)
    total = sum(d for _, d, _ in casos)
    print(f"  {len(casos)} frases, {total:.0f}s de audio, {THREADS} threads\n")

    print("  --- 1. o tipo de calculo muda algo? ---")
    print(f"  {'modelo':8} {'tipo':8}  {'x real':>6}  {'erro':>10}  por frase")
    resultados = [r for r in (medir(n, t, casos) for n, t in COMBINACOES) if r]

    print("\n  --- 2. o custo e por frase ou por segundo? ---")
    custo_fixo(casos)

    if not resultados:
        return 1

    print("\n  --- o que isso quer dizer ---")
    melhor = max(resultados, key=lambda r: r["vezes"])
    print(f"  mais rapido:  {melhor['modelo']} {melhor['tipo']} "
          f"({melhor['vezes']:.2f}x, {melhor['erro']:.1f}% de erro)")
    uteis = [r for r in resultados if r["erro"] <= 12]
    if uteis:
        bom = max(uteis, key=lambda r: r["vezes"])
        print(f"  mais rapido com erro aceitavel (<=12%): {bom['modelo']} {bom['tipo']} "
              f"({bom['vezes']:.2f}x, {bom['medio']:.2f}s por frase)")
    else:
        print("  nenhuma combinacao fica abaixo de 12% de erro")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
