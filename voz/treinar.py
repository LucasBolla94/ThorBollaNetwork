# -*- coding: utf-8 -*-
"""Roda o treino do Piper permitindo apenas o tipo que falta no checkpoint.

**O problema.** O checkpoint pt-BR foi salvo por uma versao antiga e guardou
caminhos de arquivo (`pathlib.PosixPath`) junto dos hiperparametros. O torch
2.4 carrega com `weights_only=True` por padrao, que so aceita tipos simples, e
recusa com uma mensagem sobre "unsupported global".

**A saida errada** seria carregar com `weights_only=False`. Isso executa o
pickle do arquivo inteiro — qualquer coisa que estivesse la dentro rodaria com
as permissoes de quem chamou. Para um arquivo baixado da internet, nao importa
de onde, e risco que nao precisa ser corrido.

**A saida certa** e esta: dizer ao torch que `PosixPath` especificamente pode
ser reconstruido, e deixar a trava fechada para todo o resto. `PosixPath` e um
tipo da biblioteca padrao que so guarda texto; reconstrui-lo nao executa nada.
Se o checkpoint trouxesse qualquer outra coisa inesperada, continuaria sendo
recusado — que e exatamente o que se quer.

    python3 treinar.py fit --data.csv_path ... (demais argumentos do piper)
"""
import pathlib
import sys

import torch.serialization

# So isto. Nenhum tipo alem dos caminhos da biblioteca padrao.
torch.serialization.add_safe_globals(
    [pathlib.PosixPath, pathlib.PurePosixPath, pathlib.WindowsPath, pathlib.PureWindowsPath]
)

from piper.train.__main__ import main  # noqa: E402  (depois do allowlist, de proposito)

if __name__ == "__main__":
    sys.argv[0] = "piper.train"
    raise SystemExit(main())
