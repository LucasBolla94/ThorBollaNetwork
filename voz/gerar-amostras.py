# -*- coding: utf-8 -*-
"""
Gera uma frase de teste com cada referencia de uma pasta.

Chamado pelo avaliar.sh. A frase de teste e fixa e **acentuada corretamente**,
porque texto sem acento muda a silaba tonica e some com a nasalizacao — foi o
que estragou a primeira rodada de testes (plan.md §31.11).

Gera frase a frase, nao o paragrafo inteiro: o modelo e autorregressivo e as
vezes entra em repeticao, e o proprio codigo dele corta a geracao a forca
quando isso acontece. Trecho curto tem menos chance de entrar em laco, e um
trecho ruim nao contamina o resto.
"""

import sys
import time
import wave
from pathlib import Path

import torch

torch.set_num_threads(8)
from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # noqa: E402

FRASES = [
    "Bom dia, Lucas.",
    "O servidor está estável, nenhum alerta desde ontem.",
    "Você tem uma reunião em quarenta e cinco minutos, e eu já separei a pauta.",
]

PAUSA = 0.18  # segundos de silêncio entre frases


def salvar(wav, caminho: Path, sr: int) -> None:
    dados = (wav.squeeze().clamp(-1, 1) * 32767).to(torch.int16).numpy().tobytes()
    with wave.open(str(caminho), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(dados)


def main() -> None:
    refs = Path(sys.argv[1])
    saida = Path(sys.argv[2])
    saida.mkdir(parents=True, exist_ok=True)

    arquivos = sorted(refs.glob("*.wav"))
    if not arquivos:
        print("nenhuma referencia encontrada")
        return

    modelo = ChatterboxMultilingualTTS.from_pretrained(device="cpu")
    silencio = torch.zeros(int(modelo.sr * PAUSA))

    for ref in arquivos:
        t0 = time.time()
        pedacos = []
        for frase in FRASES:
            wav = modelo.generate(frase, language_id="pt", audio_prompt_path=str(ref))
            pedacos.append(wav.squeeze())
            pedacos.append(silencio)
        junto = torch.cat(pedacos[:-1])
        destino = saida / f"{ref.stem}.wav"
        salvar(junto, destino, modelo.sr)
        print(f"  {ref.name}  ->  {destino.name}   ({time.time() - t0:.0f}s)", flush=True)


if __name__ == "__main__":
    main()
