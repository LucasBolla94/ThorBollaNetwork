# -*- coding: utf-8 -*-
"""Mede, no servidor de verdade, se dá para rodar busca por sentido aqui.

O que importa não é o modelo ser bom em inglês num ranking. É: quanto de RAM
come, quanto demora por frase, e se ele entende português o bastante para
achar a mesma coisa dita com outras palavras — que é exatamente o caso em que
a busca por palavra do SQLite falha.
"""
import os
import resource
import time

os.environ.setdefault("OMP_NUM_THREADS", "2")  # não tomar a máquina inteira

from fastembed import TextEmbedding

CANDIDATOS = [
    "intfloat/multilingual-e5-small",
    "BAAI/bge-small-en-v1.5",
]

# Pares que o FTS5 erraria: dizem a mesma coisa sem compartilhar palavra.
PARES = [
    ("o Lucas prefere mensagens curtas", "ele não gosta de texto longo"),
    ("a reunião foi adiada", "o encontro mudou de data"),
    ("o servidor ficou sem espaço em disco", "a máquina encheu o HD"),
    ("prefiro que você decida sozinho", "não me pergunte a cada passo"),
    ("o pagamento não entrou", "a cobrança falhou"),
]
# Pares que NÃO têm relação: o modelo tem de separar isto do resto.
DISTRATORES = [
    ("o Lucas prefere mensagens curtas", "o certificado HTTPS vence em março"),
    ("a reunião foi adiada", "o gato subiu no telhado"),
]

FRASES = [
    "Bom dia, Lucas. Você tem três compromissos hoje.",
    "O backup noturno terminou sem erro.",
    "A proposta do cliente está parada esperando sua revisão.",
    "Separei quinze arquivos na pasta de contratos.",
    "O servidor está com 21 por cento do disco usado.",
] * 20  # 100 frases


def mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def cosseno(a, b):
    import numpy as np

    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


for nome in CANDIDATOS:
    print(f"\n{'=' * 62}\n{nome}\n{'=' * 62}")
    try:
        antes = mb()
        t0 = time.time()
        modelo = TextEmbedding(model_name=nome, threads=2)
        carga = time.time() - t0
        print(f"  carregar:      {carga:5.1f}s")
        print(f"  RAM depois:    {mb():5.0f} MB  (+{mb() - antes:.0f})")

        # Aquece, para não medir o primeiro uso.
        list(modelo.embed(["aquecendo"]))

        t0 = time.time()
        vetores = list(modelo.embed(FRASES))
        total = time.time() - t0
        print(f"  100 frases:    {total:5.2f}s   ({total / len(FRASES) * 1000:.1f} ms por frase)")
        print(f"  dimensao:      {len(vetores[0])}")
        print(f"  RAM no pico:   {mb():5.0f} MB")

        print("\n  Entende portugues? (quanto maior, mais parecido)")
        print("  --- deviam ser PARECIDOS ---")
        iguais = []
        for a, b in PARES:
            va, vb = list(modelo.embed([a, b]))
            s = cosseno(va, vb)
            iguais.append(s)
            print(f"    {s:.3f}  {a[:38]:<40} | {b[:34]}")
        print("  --- deviam ser DIFERENTES ---")
        difs = []
        for a, b in DISTRATORES:
            va, vb = list(modelo.embed([a, b]))
            s = cosseno(va, vb)
            difs.append(s)
            print(f"    {s:.3f}  {a[:38]:<40} | {b[:34]}")

        margem = min(iguais) - max(difs)
        print(f"\n  Menor parecido: {min(iguais):.3f}   Maior diferente: {max(difs):.3f}")
        print(f"  MARGEM: {margem:+.3f}  -> {'serve' if margem > 0.05 else 'NAO separa bem'}")
    except Exception as e:
        print(f"  FALHOU: {type(e).__name__}: {str(e)[:200]}")
