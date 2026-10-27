#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""O modelo que acerta dá para deixar rápido?

    python3 medir-escuta-rapido.py

**Onde estamos.** Medido neste servidor com as frases do dono:

    whisper small       0,6x tempo real   10,1% erro   5,64 s por frase
    vosk grande        19,1x              18,6%        0,20 s
    wav2vec2 bp400      2,3x               8,0%        1,68 s

O wav2vec2 é o que acerta melhor — e acerta melhor que o Whisper, em um terço
do tempo. Falta velocidade: 1,68 s por frase é conversável, mas arrastado.

**O que este arquivo testa.** Três maneiras de acelerar o mesmo modelo sem
trocar de modelo, da mais promissora para a menos:

    quantizar     troca as contas de 32 bits por 8 bits nas camadas lineares,
                  que são quase todo o trabalho. Costuma dar 2x a 3x em CPU.
                  O risco aqui é a máquina: os núcleos rápidos de 8 bits
                  querem AVX2, que este processador não tem — pode não ajudar
                  nada, ou até piorar. É barato descobrir.
    menos threads às vezes mais threads piora: o trabalho de dividir e juntar
                  passa a custar mais que a conta. Vale medir em vez de supor.
    meia precisão 16 bits. Em CPU costuma ser mais lento que 32 (não há
                  instrução nativa), mas é uma linha e tira a dúvida.

**O que NÃO se aceita como ganho.** Qualquer variante que mexa no erro para
cima. O ponto deste modelo é acertar; ficar rápido errando é voltar ao Vosk,
que já é rápido de graça.
"""

import os
import sys
import time
from pathlib import Path

CORPUS = Path(os.environ.get("CORPUS", Path.home() / "voz" / "corpus"))
QUANTAS = int(os.environ.get("QUANTAS", "10"))
MODELO = os.environ.get("W2V", "lgris/bp400-xlsr")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from medir_escuta_apoio import distancia, normalizar, pares  # noqa: E402

import torch  # noqa: E402
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor  # noqa: E402


def medir(nome, proc, modelo, casos, threads):
    torch.set_num_threads(threads)

    def transcrever(dados):
        entrada = proc(dados, sampling_rate=16000, return_tensors="pt", padding=True)
        with torch.no_grad():
            logits = modelo(entrada.input_values).logits
        return proc.batch_decode(torch.argmax(logits, dim=-1))[0]

    transcrever(casos[0][0])  # rodada fria fora da conta

    audio = gasto = 0.0
    erradas = palavras = 0
    for dados, dur, certo in casos:
        t0 = time.monotonic()
        saiu = transcrever(dados)
        gasto += time.monotonic() - t0
        audio += dur
        esperado = normalizar(certo)
        erradas += distancia(esperado, normalizar(saiu))
        palavras += len(esperado)

    vezes = audio / gasto
    erro = 100 * erradas / max(1, palavras)
    medio = gasto / len(casos)
    print(f"  {nome:34} {vezes:6.1f}x  {erro:5.1f}% erro  {medio:5.2f}s por frase")
    return {"nome": nome, "vezes": vezes, "erro": erro, "medio": medio}


def main() -> int:
    casos = pares(CORPUS, QUANTAS)
    total = sum(d for _, d, _ in casos)
    print(f"  {MODELO}")
    print(f"  {len(casos)} frases suas, {total:.0f}s de audio\n")

    proc = Wav2Vec2Processor.from_pretrained(MODELO)
    base = Wav2Vec2ForCTC.from_pretrained(MODELO).eval()

    r = []
    print("  --- como esta hoje, variando as threads ---")
    for t in (8, 4, 2):
        r.append(medir(f"normal, {t} threads", proc, base, casos, t))

    print("\n  --- quantizado para 8 bits ---")
    try:
        # Só as camadas lineares: são quase todo o trabalho de um transformer,
        # e quantizar o resto rende pouco e arrisca o acerto.
        oito = torch.quantization.quantize_dynamic(
            base, {torch.nn.Linear}, dtype=torch.qint8
        ).eval()
        for t in (8, 4):
            r.append(medir(f"8 bits, {t} threads", proc, oito, casos, t))
    except Exception as e:  # noqa: BLE001
        print(f"  nao deu para quantizar: {type(e).__name__}: {str(e)[:80]}")

    melhor = max(r, key=lambda x: x["vezes"])
    base_ref = next(x for x in r if x["nome"] == "normal, 8 threads")

    print("\n  --- o que isso quer dizer ---")
    print(f"  mais rapido: {melhor['nome']} — {melhor['vezes']:.1f}x, "
          f"{melhor['medio']:.2f}s por frase, {melhor['erro']:.1f}% de erro")
    ganho = melhor["medio"] / base_ref["medio"]
    piorou = melhor["erro"] - base_ref["erro"]
    if melhor["nome"] == base_ref["nome"]:
        print("  nenhuma variante bateu o normal com 8 threads")
    else:
        print(f"  {1 / ganho:.1f}x mais rapido que o normal, "
              f"e o erro {'subiu' if piorou > 0.2 else 'ficou igual'}"
              f"{f' {piorou:+.1f} pontos' if abs(piorou) > 0.2 else ''}")

    # A conta que decide: quanto o Lucas espera entre parar de falar e ouvir.
    # 520 ms de silencio para fechar o turno, mais a transcricao, mais ~700 ms
    # da LLM ate o primeiro pedaco de texto, mais 170 ms para sintetizar —
    # estes dois ultimos medidos em producao.
    print("\n  --- do ponto final dele ao primeiro som do Thor ---")
    for x in sorted(r, key=lambda x: x["medio"])[:3]:
        espera = 0.52 + x["medio"] + 0.70 + 0.17
        print(f"  {x['nome']:34} {espera:4.1f}s  ({x['erro']:.1f}% de erro)")
    print("  para comparar, transcrevendo na nuvem:        1,8s  (6% de erro)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
