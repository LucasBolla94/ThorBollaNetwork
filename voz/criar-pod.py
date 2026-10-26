# -*- coding: utf-8 -*-
"""Cria o pod, tentando as placas do mais barato para cima.

A A5000 esta com estoque baixo e a primeira tentativa falhou sem criar nada.
Em vez de insistir cega numa so, tenta uma lista curta em ordem de preco e
PARA NA PRIMEIRA que entrar.

Continua com `gpuTypePriority: custom` em cada tentativa: assim cada pedido vale
por aquela placa e so por ela. Deixar no padrao "availability" seria o mesmo que
dizer "me da qualquer uma" — e qualquer uma pode custar oito vezes mais.
"""
import json
import subprocess
import sys

CHAVE = open("/home/ubuntu/.runpod-key").read().strip()
PUBLICA = open("/home/ubuntu/.ssh/id_ed25519.pub").read().strip()

# (id da placa, nuvem, preco informado). Ordem = ordem de tentativa.
CANDIDATAS = [
    ("NVIDIA RTX A5000", "SECURE", 0.160),
    ("NVIDIA RTX A5000", "COMMUNITY", 0.160),
    ("NVIDIA RTX 4000 SFF Ada Generation", "SECURE", 0.180),
    ("NVIDIA RTX A6000", "SECURE", 0.330),
    ("NVIDIA GeForce RTX 4090", "SECURE", 0.340),
    ("NVIDIA A40", "SECURE", 0.350),
]

# Teto de seguranca: nenhuma tentativa acima disto, aconteca o que acontecer.
TETO = 0.40


def tentar(gpu, nuvem):
    corpo = {
        "name": "thor-voz",
        "imageName": "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
        "gpuTypeIds": [gpu],
        "gpuTypePriority": "custom",
        "gpuCount": 1,
        "cloudType": nuvem,
        "interruptible": False,
        "containerDiskInGb": 30,
        "volumeInGb": 20,
        "volumeMountPath": "/workspace",
        "ports": ["22/tcp"],
        "env": {"PUBLIC_KEY": PUBLICA},
    }
    saida = subprocess.run(
        ["curl", "-sS", "-m", "90", "-X", "POST",
         "-H", "Authorization: Bearer " + CHAVE,
         "-H", "Content-Type: application/json",
         "-d", json.dumps(corpo),
         "https://rest.runpod.io/v1/pods"],
        capture_output=True, text=True,
    ).stdout
    try:
        return json.loads(saida)
    except Exception:
        return {"error": saida[:200]}


for gpu, nuvem, preco in CANDIDATAS:
    if preco > TETO:
        print(f"  parando: {gpu} custaria ${preco:.3f}, acima do teto de ${TETO:.2f}")
        break
    print(f"  tentando {gpu} em {nuvem} (${preco:.3f}/h)... ", end="", flush=True)
    d = tentar(gpu, nuvem)
    if isinstance(d, dict) and d.get("id"):
        print("ENTROU")
        print()
        print(f"  pod:     {d['id']}")
        custo = d.get("costPerHr")
        print(f"  custo:   ${float(custo):.3f}/hora" if custo else f"  custo:   ~${preco:.3f}/hora")
        maq = d.get("machine") or {}
        print(f"  placa:   {maq.get('gpuDisplayName') or gpu}")
        print(f"  estado:  {d.get('desiredStatus')}")
        print()
        print("  A partir de agora esta cobrando.")
        sys.exit(0)
    erro = (d or {}).get("error", "")
    print("nao" if "no instances" in str(erro) else f"falhou: {str(erro)[:70]}")

print()
print("  Nenhuma das candidatas tinha vaga. Nada foi criado, nada esta cobrando.")
sys.exit(2)
