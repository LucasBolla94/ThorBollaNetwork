#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Quanto tempo entre ele parar de falar e o texto estar pronto.

    python3 medir-espera.py

**Por que este arquivo existe separado do testar.py.** Aquele manda o áudio o
mais rápido que a rede aceita, porque está conferindo comportamento. Isso
esconde justamente o número que importa: o áudio chega **em tempo real** na
vida real, um pedaço de 64 ms a cada 64 ms, e é a partir do último pedaço de
fala que a pessoa começa a esperar.

Então aqui o áudio é entregue no ritmo do relógio, e o cronômetro começa no
instante em que o último pedaço de FALA sai — não no começo da frase.

**O que a conta deve mostrar.** Sem adiantar nada, a espera seria a soma de
duas coisas: os 520 ms de silêncio que confirmam o fim do turno, mais o tempo
de transcrever (1,65 s medido). Com o adiantamento, a transcrição começa
depois de 200 ms de pausa — então ~320 ms dela acontecem enquanto o silêncio
ainda está sendo confirmado, e deveriam desaparecer da espera.

Se o número medido não cair perto disso, o adiantamento não está funcionando —
e não existe erro que apareça, porque funcionar devagar e não funcionar são a
mesma coisa vista de fora.
"""

import csv
import json
import os
import sys
import time
import urllib.request
import wave
from pathlib import Path

ENDERECO = os.environ.get("THOR_VOZ_URL", "http://127.0.0.1:8798")
CORPUS = Path(os.environ.get("CORPUS", Path.home() / "voz" / "corpus"))
QUANTAS = int(os.environ.get("QUANTAS", "4"))
TAXA = 16000
PEDACO = 1024                      # amostras: 64 ms, igual ao navegador
PEDACO_S = PEDACO / TAXA


def aparar(x):
    """Tira o silêncio das pontas da gravação.

    **Sem isto a medição mente, e já mentiu.** Uma frase do corpus tem ~700 ms
    de silêncio no fim do arquivo — mais que os 520 ms que fecham o turno.
    Então o turno fechava ENQUANTO a fala ainda estava sendo enviada, e o laço
    de silêncio depois esperava para sempre por um segundo fechamento que
    nunca vem. O relatório dizia "não fechou o turno", acusando o serviço de
    um defeito que era desta ferramenta.

    O que esta medição quer é um instante bem definido: "ele acabou de falar".
    Isso só existe se o áudio enviado for só fala.
    """
    import numpy as np
    janela = int(TAXA * 0.02)
    sobra = len(x) % janela
    corpo = x[:-sobra] if sobra else x
    niveis = np.abs(corpo.reshape(-1, janela)).max(axis=1)
    audiveis = np.flatnonzero(niveis >= 0.02)
    if not len(audiveis):
        return x
    # Uma janela de folga de cada lado, para não cortar o ataque da primeira
    # consoante nem a cauda da última.
    ini = max(0, (audiveis[0] - 1)) * janela
    fim = min(len(niveis), audiveis[-1] + 2) * janela
    return x[ini:fim]


def ler(nome):
    with wave.open(str(CORPUS / "wavs" / f"{nome}.wav"), "rb") as w:
        taxa, quadros = w.getframerate(), w.getnframes()
        bruto = w.readframes(quadros)
    import numpy as np
    x = np.frombuffer(bruto, dtype="<i2").astype("float32") / 32768.0
    if taxa != TAXA:
        import librosa
        x = librosa.resample(x, orig_sr=taxa, target_sr=TAXA)
    x = aparar(x)
    # Trava em -1..1 antes de voltar para inteiro. Reamostrar pode passar de
    # 1,0 (uma frase do corpus chega a 1,008), e 1,008 × 32767 estoura o
    # inteiro de 16 bits virando um negativo enorme — um estalo. A mesma trava
    # está no código do navegador, pelo mesmo motivo.
    return (np.clip(x, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def postar(caminho, corpo):
    req = urllib.request.Request(ENDERECO + caminho, data=corpo, method="POST")
    req.add_header("Content-Type", "application/octet-stream")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main() -> int:
    with urllib.request.urlopen(ENDERECO + "/saude", timeout=10) as r:
        saude = json.loads(r.read())
    if saude.get("na_nuvem"):
        print("  o serviço está no modo nuvem: esta medição é do caminho local")
        return 0

    print(f"  escuta: {saude.get('escuta')}")
    print(f"  silêncio para fechar o turno: {saude.get('silencio_ms')} ms")
    print(f"  começa a entender após: {saude.get('adianta_em_ms')} ms de pausa\n")

    with open(CORPUS / "metadata.csv", encoding="utf-8") as f:
        linhas = [l for l in csv.reader(f, delimiter="|") if len(l) >= 2]
    passo = max(1, len(linhas) // QUANTAS)
    escolhidas = linhas[::passo][:QUANTAS]

    esperas = []
    for n, (nome, certo) in enumerate(escolhidas):
        audio = ler(nome)
        passo_b = PEDACO * 2
        sessao = f"espera-{n}"

        # A fala, no ritmo do relógio.
        fechou_cedo = False
        for i in range(0, len(audio), passo_b):
            alvo = time.monotonic() + PEDACO_S
            d = postar(f"/ouvir/{sessao}", audio[i:i + passo_b])
            # Não pode fechar antes de a fala terminar. Se fechar, o áudio
            # tinha silêncio no meio ou nas pontas, e "ele acabou de falar"
            # deixa de ter um instante definido — então não há o que medir.
            if d.get("parou"):
                fechou_cedo = True
                break
            folga = alvo - time.monotonic()
            if folga > 0:
                time.sleep(folga)
        if fechou_cedo:
            print(f"  (pulei: o turno fechou no meio do áudio de {certo[:30]}...)")
            continue
        fim_da_fala = time.monotonic()

        # O silêncio depois, também no ritmo do relógio. O cronômetro já corre.
        quieto = b"\x00\x00" * PEDACO
        espera = None
        for _ in range(60):
            alvo = time.monotonic() + PEDACO_S
            d = postar(f"/ouvir/{sessao}", quieto)
            if d.get("parou"):
                espera = time.monotonic() - fim_da_fala
                saiu = (d.get("texto") or "")[:54]
                print(f"  {espera:5.2f}s  {saiu}")
                break
            folga = alvo - time.monotonic()
            if folga > 0:
                time.sleep(folga)
        if espera is None:
            print("  nao fechou o turno em 4s")
        else:
            esperas.append(espera)
        urllib.request.urlopen(
            urllib.request.Request(f"{ENDERECO}/ouvir/{sessao}", method="DELETE"), timeout=5
        ).read()

    if not esperas:
        return 1

    media = sum(esperas) / len(esperas)
    print(f"\n  media: {media:.2f}s do ponto final dele ao texto pronto")
    print(f"  pior:  {max(esperas):.2f}s")

    sem_adiantar = saude.get("silencio_ms", 520) / 1000 + 1.65
    print(f"\n  sem adiantar, seria perto de {sem_adiantar:.2f}s "
          f"(os {saude.get('silencio_ms')} ms de silêncio mais 1,65s de transcrição)")
    poupado = sem_adiantar - media
    print(f"  o adiantamento está poupando ~{poupado:.2f}s" if poupado > 0.1
          else "  ATENÇÃO: o adiantamento não está poupando nada")

    print(f"\n  somando o resto, medido em produção:")
    print(f"    {media:.2f}s  entender o que ele falou")
    print(f"    0,70s  a LLM comecar a responder")
    print(f"    0,17s  o primeiro pedaco de voz sair")
    print(f"    ----")
    print(f"    {media + 0.87:.2f}s  do ponto final dele ao primeiro som do Thor")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
