#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mede, NESTE servidor, qual modelo de escuta serve para conversa.

    python3 medir-escuta.py [modelo ...]

**Por que medir em vez de confiar em benchmark.** Todo numero publicado de
faster-whisper em CPU vem de maquina moderna com AVX2 ou AVX-512. Este
servidor e um Xeon E5-1620 v2 de 2013: tem AVX, nao tem AVX2. O motor do
Whisper (CTranslate2) depende muito dessas instrucoes, entao o numero de fora
nao vale aqui — nem para melhor, nem para pior. So medindo se sabe.

**Por que o corpus do dono e o teste certo.** Ele gravou 300 frases e o texto
exato de cada uma esta no metadata.csv. Isso da as duas coisas que importam de
uma vez: a voz e a dele (nao a de um locutor americano) e o portugues e o
dele, com acento e vocabulario reais. E da gabarito, entao mede acerto, nao
so velocidade.

**Os dois numeros que decidem.**

  tempo real  quantos segundos de audio por segundo de processador. Para
              conversa, a conta e: a pessoa fala 3s, o silencio fecha o turno
              em 0,6s, e a transcricao nao pode somar mais que ~0,8s em cima
              disso. Entao precisa de 4x ou mais.
  erro        quantas palavras saem erradas, em porcentagem. Acima de ~10% a
              conversa comeca a desandar: ele responde a outra pergunta.

Velocidade sem acerto nao serve, e acerto sem velocidade tambem nao. Por isso
os dois na mesma tabela.

**O audio e lido aqui, nao pelo faster-whisper.** Duas razoes. A primeira e
que a versao instalada do decodificador dele mudou de assinatura e quebra
("open() got an unexpected keyword argument 'metadata_errors'"). A segunda e
melhor: em producao o audio chega do navegador como PCM cru, nunca como
arquivo. Lendo e reamostrando aqui, FORA do cronometro, o numero medido passa
a ser o da transcricao sozinha — que e o que vai acontecer de verdade.
"""

import csv
import os
import re
import sys
import time
import unicodedata
import wave
from pathlib import Path

CORPUS = Path(os.environ.get("CORPUS", Path.home() / "voz" / "corpus"))
QUANTAS = int(os.environ.get("QUANTAS", "14"))
THREADS = int(os.environ.get("THREADS", "8"))
PADRAO = ["small", "medium", "large-v3-turbo"]

# Abaixo disto nao da conversa: a transcricao sozinha estouraria o orcamento
# de demora antes de a LLM comecar a pensar.
MINIMO_TEMPO_REAL = 4.0
MAXIMO_ERRO = 10.0


def normalizar(texto: str) -> list:
    """Deixa so o que importa comparar: palavras, sem acento e sem pontuacao.

    Comparar com acento puniria o modelo por escrever "reuniao" em vez de
    "reunião", e isso nao atrapalha o entendimento de ninguem. Pontuacao, pela
    mesma razao, sai.
    """
    t = unicodedata.normalize("NFD", texto.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return t.split()


def distancia(a: list, b: list) -> int:
    """Quantas palavras teriam de ser trocadas, somadas ou tiradas."""
    if not a:
        return len(b)
    anterior = list(range(len(b) + 1))
    for i, pa in enumerate(a, 1):
        atual = [i]
        for j, pb in enumerate(b, 1):
            atual.append(min(
                anterior[j] + 1,          # tirar
                atual[j - 1] + 1,         # somar
                anterior[j - 1] + (pa != pb),  # trocar
            ))
        anterior = atual
    return anterior[-1]


TAXA_WHISPER = 16000


def carregar(caminho: Path):
    """Le o wav como o Whisper quer: float32 mono a 16 kHz.

    O corpus foi gravado a 22.050 Hz e o Whisper so trabalha a 16.000. A
    reamostragem acontece aqui de proposito: e trabalho que em producao nao
    existe (o navegador ja manda 16 kHz), entao nao pode entrar na conta do
    tempo de transcricao.
    """
    import numpy as np
    with wave.open(str(caminho), "rb") as w:
        canais, largura, taxa, quadros = (
            w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes())
        bruto = w.readframes(quadros)
    if largura != 2:
        raise ValueError(f"{caminho.name}: esperava 16 bits, veio {largura * 8}")
    dados = np.frombuffer(bruto, dtype="<i2").astype("float32") / 32768.0
    if canais > 1:
        dados = dados.reshape(-1, canais).mean(axis=1)
    if taxa != TAXA_WHISPER:
        import librosa
        dados = librosa.resample(dados, orig_sr=taxa, target_sr=TAXA_WHISPER)
    return dados, len(dados) / TAXA_WHISPER


def amostras():
    """Pega frases espalhadas pelo corpus, nao as primeiras.

    As primeiras gravacoes de qualquer sessao sao as piores: a pessoa ainda
    esta achando o tom. Pegar de ponta a ponta mede o caso medio.
    """
    linhas = []
    with open(CORPUS / "metadata.csv", encoding="utf-8") as f:
        for linha in csv.reader(f, delimiter="|"):
            if len(linha) >= 2:
                wav = CORPUS / "wavs" / (linha[0] + ".wav")
                if wav.exists():
                    linhas.append((wav, linha[1]))
    if not linhas:
        print("corpus vazio em", CORPUS)
        raise SystemExit(1)
    passo = max(1, len(linhas) // QUANTAS)
    escolhidas = linhas[::passo][:QUANTAS]
    prontas = []
    for wav, texto in escolhidas:
        dados, dur = carregar(wav)
        prontas.append((dados, dur, texto))
    return prontas


def medir(nome: str, casos: list) -> dict:
    from faster_whisper import WhisperModel

    print(f"\n  {nome}")
    t0 = time.monotonic()
    try:
        modelo = WhisperModel(nome, device="cpu", compute_type="int8", cpu_threads=THREADS)
    except Exception as e:  # noqa: BLE001
        print(f"    nao carregou: {type(e).__name__}: {e}")
        return {}
    carga = time.monotonic() - t0
    print(f"    carregou em {carga:.1f}s")

    # Uma rodada fria antes de medir: a primeira transcricao paga o
    # aquecimento do motor e envenenaria a media.
    list(modelo.transcribe(casos[0][0], language="pt")[0])

    audio_total = 0.0
    gasto_total = 0.0
    erradas = 0
    palavras = 0
    pior = (0.0, "", "")

    for dados, d, certo in casos:
        t0 = time.monotonic()
        trechos, _ = modelo.transcribe(dados, language="pt", beam_size=1)
        saiu = " ".join(t.text for t in trechos).strip()
        gasto = time.monotonic() - t0

        esperado = normalizar(certo)
        obtido = normalizar(saiu)
        erro = distancia(esperado, obtido)

        audio_total += d
        gasto_total += gasto
        erradas += erro
        palavras += len(esperado)

        taxa = 100 * erro / max(1, len(esperado))
        if taxa > pior[0]:
            pior = (taxa, certo, saiu)

    tempo_real = audio_total / gasto_total if gasto_total else 0
    taxa_erro = 100 * erradas / max(1, palavras)
    print(f"    {tempo_real:.1f}x tempo real  |  {taxa_erro:.1f}% de erro  "
          f"|  {audio_total:.0f}s de audio em {gasto_total:.0f}s")
    if pior[1]:
        print(f"    pior frase ({pior[0]:.0f}% errado):")
        print(f"      certo: {pior[1]}")
        print(f"      saiu:  {pior[2]}")

    del modelo
    return {"modelo": nome, "carga": carga, "tempo_real": tempo_real, "erro": taxa_erro}


def main() -> int:
    nomes = sys.argv[1:] or PADRAO
    casos = amostras()
    total = sum(d for _, d, _ in casos)
    print(f"  {len(casos)} frases do corpus, {total:.0f}s de audio, {THREADS} threads")

    resultados = [r for r in (medir(n, casos) for n in nomes) if r]
    if not resultados:
        return 1

    print()
    print("  " + "-" * 58)
    print("  %-18s %8s %9s %9s  %s" % ("modelo", "carga", "x real", "erro", "serve?"))
    for r in resultados:
        ok = r["tempo_real"] >= MINIMO_TEMPO_REAL and r["erro"] <= MAXIMO_ERRO
        print("  %-18s %7.0fs %8.1fx %8.1f%%  %s" % (
            r["modelo"], r["carga"], r["tempo_real"], r["erro"],
            "sim" if ok else ("lento" if r["tempo_real"] < MINIMO_TEMPO_REAL else "erra demais")))
    print("  " + "-" * 58)
    print(f"  regua: >= {MINIMO_TEMPO_REAL:.0f}x tempo real e <= {MAXIMO_ERRO:.0f}% de erro")

    bons = [r for r in resultados
            if r["tempo_real"] >= MINIMO_TEMPO_REAL and r["erro"] <= MAXIMO_ERRO]
    if bons:
        # Entre os que servem, o que erra menos. Velocidade sobrando nao
        # melhora a conversa; palavra errada atrapalha.
        melhor = min(bons, key=lambda r: r["erro"])
        print(f"\n  ESCOLHA: {melhor['modelo']} "
              f"({melhor['tempo_real']:.1f}x, {melhor['erro']:.1f}% de erro)")
    else:
        print("\n  NENHUM serve nesta maquina com estes ajustes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
