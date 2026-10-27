# -*- coding: utf-8 -*-
"""O que as duas medicoes de escuta compartilham.

Existe para as duas nao terem copia da mesma conta de erro: medir com reguas
diferentes produziria numeros que parecem comparaveis e nao sao.
"""

import csv
import re
import unicodedata
import wave
from pathlib import Path

TAXA_WHISPER = 16000


def normalizar(texto: str) -> list:
    """Deixa so o que vale comparar: palavras, sem acento e sem pontuacao.

    Comparar com acento puniria o modelo por escrever "reuniao" em vez de
    "reunião", e isso nao atrapalha o entendimento de ninguem.

    **O que esta regua NAO resolve, e e bom saber:** "duzentos e dez" e "210"
    sao a mesma coisa dita de dois jeitos, e aqui contam como tres palavras
    erradas. Quando esse for o pior caso de um modelo, o erro de verdade e
    menor que o numero mostrado.
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
                anterior[j] + 1,
                atual[j - 1] + 1,
                anterior[j - 1] + (pa != pb),
            ))
        anterior = atual
    return anterior[-1]


def carregar(caminho: Path):
    """Le o wav como o Whisper quer: float32 mono a 16 kHz.

    A reamostragem acontece aqui, FORA de qualquer cronometro, de proposito: em
    producao o navegador ja manda 16 kHz, entao esse trabalho nao existe e nao
    pode entrar na conta do tempo de transcricao.
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


def pares(corpus: Path, quantas: int):
    """Frases espalhadas pelo corpus, com o audio ja carregado.

    Espalhadas, e nao as primeiras: as primeiras gravacoes de qualquer sessao
    sao as piores, porque a pessoa ainda esta achando o tom.
    """
    linhas = []
    with open(corpus / "metadata.csv", encoding="utf-8") as f:
        for linha in csv.reader(f, delimiter="|"):
            if len(linha) >= 2:
                wav = corpus / "wavs" / (linha[0] + ".wav")
                if wav.exists():
                    linhas.append((wav, linha[1]))
    if not linhas:
        raise SystemExit(f"corpus vazio em {corpus}")
    passo = max(1, len(linhas) // quantas)
    return [(*carregar(w), t) for w, t in linhas[::passo][:quantas]]
