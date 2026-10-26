# -*- coding: utf-8 -*-
"""Tira do checkpoint so os ajustes antigos, mantendo todo o resto.

**O problema.** O checkpoint pt-BR guarda, junto dos pesos, os hiperparametros
do treino que o gerou. Um deles (`sample_bytes`) nao existe mais nesta versao
do Piper, e o treinador se recusa a comecar: "Subcommand 'fit' does not accept
option 'model.sample_bytes'".

**A tentativa anterior errou a dose.** Deixar so os pesos resolveu esse erro e
criou outro: o treinador quer retomar o estado do otimizador e nao achou
("Trying to restore optimizer state but checkpoint contains only the model").

Entao a dose certa e cirurgica: fora **apenas** os dois dicionarios de
hiperparametros, que descrevem o treino anterior e que nos substituimos pela
linha de comando de qualquer jeito. Pesos, otimizador, agendador e contadores
continuam onde estavam.

**Sobre seguranca:** le com `weights_only=True`, a trava fechada, autorizando
apenas `PosixPath` — tipo da biblioteca padrao que so guarda texto. O pickle
do arquivo nunca e executado.

    python3 limpar-ajustes.py entrada.ckpt saida.ckpt
"""
import pathlib
import sys

import torch
import torch.serialization

torch.serialization.add_safe_globals(
    [pathlib.PosixPath, pathlib.PurePosixPath, pathlib.WindowsPath, pathlib.PureWindowsPath]
)

# Os unicos que saem. Descrevem o treino anterior, de outra voz.
FORA = ("hyper_parameters", "datamodule_hyper_parameters", "hparams_name")


def main() -> int:
    entrada, saida = sys.argv[1], sys.argv[2]

    print(f"  lendo {entrada} (trava fechada)")
    dados = torch.load(entrada, map_location="cpu", weights_only=True)

    tirados = [k for k in FORA if k in dados]
    for k in tirados:
        dados.pop(k)

    print(f"  pesos:       {len(dados.get('state_dict', {}))} tensores")
    print(f"  otimizador:  {'mantido' if dados.get('optimizer_states') else 'ausente'}")
    print(f"  epoca:       {dados.get('epoch')}, passo {dados.get('global_step')}")
    print(f"  retirado:    {', '.join(tirados) or 'nada'}")
    print(f"  ficou:       {', '.join(sorted(dados))}")

    torch.save(dados, saida)
    torch.load(saida, map_location="cpu", weights_only=True)
    print(f"  gravado em {saida}, e volta a carregar")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
