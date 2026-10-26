# -*- coding: utf-8 -*-
import os, resource, sys, time
os.environ.setdefault("OMP_NUM_THREADS", "2")
from fastembed import TextEmbedding
import numpy as np

NOME = sys.argv[1]

PARES = [
    ("o Lucas prefere mensagens curtas", "ele nao gosta de texto longo"),
    ("a reuniao foi adiada", "o encontro mudou de data"),
    ("o servidor ficou sem espaco em disco", "a maquina encheu o HD"),
    ("prefiro que voce decida sozinho", "nao me pergunte a cada passo"),
    ("o pagamento nao entrou", "a cobranca falhou"),
]
DISTRATORES = [
    ("o Lucas prefere mensagens curtas", "o certificado HTTPS vence em marco"),
    ("a reuniao foi adiada", "o gato subiu no telhado"),
    ("o backup rodou de madrugada", "ele prefere cafe sem acucar"),
]
FRASES = [
    "Bom dia, Lucas. Voce tem tres compromissos hoje.",
    "O backup noturno terminou sem erro.",
    "A proposta do cliente esta parada esperando sua revisao.",
    "Separei quinze arquivos na pasta de contratos.",
    "O servidor esta com 21 por cento do disco usado.",
] * 20

mb = lambda: resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
cos = lambda a, b: float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

try:
    base = mb()
    t0 = time.time(); modelo = TextEmbedding(model_name=NOME, threads=2); carga = time.time() - t0
    list(modelo.embed(["aquecendo"]))
    ram = mb()
    t0 = time.time(); vs = list(modelo.embed(FRASES)); dur = time.time() - t0

    iguais = [cos(*list(modelo.embed([a, b]))) for a, b in PARES]
    difs = [cos(*list(modelo.embed([a, b]))) for a, b in DISTRATORES]
    margem = min(iguais) - max(difs)

    print(f'{NOME}|{ram:.0f}|{carga:.1f}|{dur/len(FRASES)*1000:.1f}|{len(vs[0])}|'
          f'{min(iguais):.3f}|{max(difs):.3f}|{margem:+.3f}')
except Exception as e:
    print(f"{NOME}|FALHOU|{type(e).__name__}: {str(e)[:90]}")
