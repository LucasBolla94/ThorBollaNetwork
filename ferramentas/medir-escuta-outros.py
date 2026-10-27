#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Escuta que não é Whisper: dá para rodar rápido nesta máquina?

    python3 medir-escuta-outros.py

**Por que este arquivo existe.** A primeira conclusão foi "nenhum modelo de
escuta serve neste servidor". Estava incompleta: eu tinha testado só o
Whisper. O dono perguntou se não dá para rodar um modelo bom aqui, e a
pergunta é boa o bastante para merecer medição em vez de repetição.

**Por que outro tipo de modelo pode mudar o resultado.** O que trava o Whisper
aqui não é o tamanho dele — é o formato: ele sempre processa uma janela de 30
segundos, completando com silêncio o que falta, e depois escreve a resposta
palavra por palavra, cada uma dependendo da anterior. Isso dá ~5,2 s fixos por
frase, medido. Conversa é feita de frases de três segundos, que pagam o preço
inteiro dos trinta.

Os dois candidatos aqui não fazem nenhuma das duas coisas:

    Vosk        reconhecedor de streaming, feito para rodar em maquina fraca.
                Processa conforme o audio chega e nao tem janela fixa. Modelo
                pequeno (31 MB). A duvida e o acerto em portugues falado.
    wav2vec2    olha o audio inteiro de uma vez e escreve tudo de uma vez
                (CTC), sem depender da palavra anterior. O custo acompanha a
                duracao real do audio, entao frase curta custa pouco.

A régua é a mesma usada com o Whisper, de propósito: mesmas frases, mesma
conta de erro. Número que não é comparável não ajuda a decidir nada.
"""

import os
import sys
import time
from pathlib import Path

THREADS = int(os.environ.get("THREADS", "8"))
os.environ.setdefault("OMP_NUM_THREADS", str(THREADS))

CORPUS = Path(os.environ.get("CORPUS", Path.home() / "voz" / "corpus"))
QUANTAS = int(os.environ.get("QUANTAS", "10"))
MODELOS = Path(os.environ.get("MODELOS", Path.home() / "voz" / "modelos-escuta"))

sys.path.insert(0, str(Path(__file__).resolve().parent))
from medir_escuta_apoio import distancia, normalizar, pares  # noqa: E402

# A régua para conversa, repetida do medir-escuta.py para ficar à vista.
MINIMO_TEMPO_REAL = 4.0
MAXIMO_ERRO = 12.0


def contar(casos, transcrever, nome):
    """Roda o transcritor em todas as frases e devolve velocidade e erro."""
    # Rodada fria fora da conta: a primeira paga o aquecimento.
    transcrever(casos[0][0])

    audio = gasto = 0.0
    erradas = palavras = 0
    pior = (0.0, "", "")

    for dados, dur, certo in casos:
        t0 = time.monotonic()
        saiu = transcrever(dados)
        d = time.monotonic() - t0

        esperado = normalizar(certo)
        erro = distancia(esperado, normalizar(saiu))
        audio += dur
        gasto += d
        erradas += erro
        palavras += len(esperado)
        taxa = 100 * erro / max(1, len(esperado))
        if taxa > pior[0]:
            pior = (taxa, certo, saiu)

    vezes = audio / gasto if gasto else 0
    pct = 100 * erradas / max(1, palavras)
    print(f"  {nome:28} {vezes:6.1f}x  {pct:5.1f}% erro  {gasto / len(casos):5.2f}s por frase")
    if pior[1]:
        print(f"      pior: {pior[1]}")
        print(f"      saiu: {pior[2]}")
    return {"nome": nome, "vezes": vezes, "erro": pct, "medio": gasto / len(casos)}


# ------------------------------------------------------------------- vosk

def tentar_vosk(casos):
    try:
        from vosk import KaldiRecognizer, Model, SetLogLevel
    except ImportError:
        print("  vosk nao instalado (pip install vosk)")
        return []

    SetLogLevel(-1)
    import json
    import numpy as np

    saidas = []
    for pasta in sorted(MODELOS.glob("vosk-model-*")):
        if not (pasta / "am").exists() and not (pasta / "am.conf").exists():
            # Alguns pacotes trazem uma pasta extra por dentro.
            dentro = [p for p in pasta.iterdir() if p.is_dir() and (p / "am").exists()]
            if dentro:
                pasta = dentro[0]
        try:
            modelo = Model(str(pasta))
        except Exception as e:  # noqa: BLE001
            print(f"  {pasta.name}: nao carregou ({type(e).__name__})")
            continue

        def transcrever(dados, _m=modelo):
            r = KaldiRecognizer(_m, 16000)
            r.SetWords(False)
            pcm = (np.clip(dados, -1, 1) * 32767).astype("<i2").tobytes()
            # Em pedacos de 64 ms, como o navegador manda: medir de outro jeito
            # mediria um caminho que nunca acontece.
            passo = 1024 * 2
            for i in range(0, len(pcm), passo):
                r.AcceptWaveform(pcm[i:i + passo])
            return json.loads(r.FinalResult()).get("text", "")

        saidas.append(contar(casos, transcrever, pasta.name[:28]))
        del modelo
    if not saidas:
        print(f"  nenhum modelo vosk em {MODELOS}")
    return saidas


# --------------------------------------------------------------- wav2vec2

def tentar_wav2vec2(casos):
    nomes = os.environ.get(
        "W2V",
        "jonatasgrosman/wav2vec2-large-xlsr-53-portuguese,"
        "lgris/bp400-xlsr",
    ).split(",")
    saidas = []
    try:
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
    except ImportError:
        print("  transformers nao instalado (pip install transformers)")
        return []

    torch.set_num_threads(THREADS)
    for nome in [n.strip() for n in nomes if n.strip()]:
        try:
            proc = Wav2Vec2Processor.from_pretrained(nome)
            modelo = Wav2Vec2ForCTC.from_pretrained(nome).eval()
        except Exception as e:  # noqa: BLE001
            print(f"  {nome}: nao carregou ({type(e).__name__}: {str(e)[:60]})")
            continue

        def transcrever(dados, _p=proc, _m=modelo):
            import torch as t
            entrada = _p(dados, sampling_rate=16000, return_tensors="pt", padding=True)
            with t.no_grad():
                logits = _m(entrada.input_values).logits
            return _p.batch_decode(t.argmax(logits, dim=-1))[0]

        saidas.append(contar(casos, transcrever, nome.split("/")[-1][:28]))
        del modelo
    return saidas


def main() -> int:
    casos = pares(CORPUS, QUANTAS)
    total = sum(d for _, d, _ in casos)
    print(f"  {len(casos)} frases suas, {total:.0f}s de audio, {THREADS} threads")
    print(f"  regua: >= {MINIMO_TEMPO_REAL:.0f}x tempo real e <= {MAXIMO_ERRO:.0f}% de erro")
    print(f"  (para comparar: whisper small deu 0,6x e 10% de erro, 5,64s por frase)\n")

    print("  --- vosk (streaming, feito para maquina fraca) ---")
    r = tentar_vosk(casos)
    print("\n  --- wav2vec2 (le tudo de uma vez, sem janela de 30s) ---")
    r += tentar_wav2vec2(casos)

    if not r:
        print("\n  nenhum candidato rodou")
        return 1

    print("\n  --- resumo ---")
    print(f"  {'modelo':28} {'x real':>7}  {'erro':>5}  serve?")
    for x in r:
        serve = x["vezes"] >= MINIMO_TEMPO_REAL and x["erro"] <= MAXIMO_ERRO
        motivo = "sim" if serve else ("lento" if x["vezes"] < MINIMO_TEMPO_REAL else "erra demais")
        print(f"  {x['nome']:28} {x['vezes']:6.1f}x  {x['erro']:4.1f}%  {motivo}")

    bons = [x for x in r if x["vezes"] >= MINIMO_TEMPO_REAL and x["erro"] <= MAXIMO_ERRO]
    if bons:
        melhor = min(bons, key=lambda x: x["erro"])
        print(f"\n  SERVE AQUI DENTRO: {melhor['nome']} "
              f"({melhor['vezes']:.1f}x, {melhor['erro']:.1f}% de erro, "
              f"{melhor['medio']:.2f}s por frase)")
    else:
        print("\n  nenhum destes serve: ou e lento, ou erra demais")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
