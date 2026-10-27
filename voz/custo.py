# -*- coding: utf-8 -*-
"""Quanto o pod ja gastou, de verdade.

A chave fica no arquivo e e lida daqui dentro; nunca passa por linha de
comando, entao nao aparece em `ps` nem no historico do shell.

    python3 custo.py
"""
import datetime as dt
import json
import subprocess
import sys

chave = open("/home/ubuntu/.runpod-key").read().strip()
bruto = subprocess.run(
    ["curl", "-sS", "-m", "30", "-H", "Authorization: Bearer " + chave,
     "https://rest.runpod.io/v1/pods"],
    capture_output=True, text=True,
).stdout

d = json.loads(bruto)
pods = d if isinstance(d, list) else d.get("data", [])
if not pods:
    print("  nenhum pod ativo - nada cobrando")
    sys.exit(0)


def quando(texto):
    """A API devolve o horario no formato do Go, nao em ISO.

    Vem como "2026-10-26 22:24:00.496 +0000 UTC". Tira o " UTC" do fim,
    aceita tambem o "Z" do ISO, e assume UTC se nao vier fuso nenhum.
    """
    t = texto.replace(" UTC", "").replace("Z", "+00:00").strip()
    try:
        d = dt.datetime.fromisoformat(t)
    except ValueError:
        d = dt.datetime.strptime(t[:23], "%Y-%m-%d %H:%M:%S.%f")
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


agora = dt.datetime.now(dt.timezone.utc)
for p in pods:
    taxa = float(p.get("costPerHr") or 0)
    print("  pod     {}  {}".format(p.get("id"), p.get("desiredStatus")))
    print("  placa   {}".format((p.get("machine") or {}).get("gpuDisplayName") or "?"))
    print("  taxa    ${:.3f}/hora".format(taxa))
    inicio = p.get("lastStartedAt") or p.get("createdAt")
    if inicio:
        horas = (agora - quando(inicio)).total_seconds() / 3600
        print("  ligado  {:.2f} horas  ->  ${:.2f} ja gastos".format(horas, horas * taxa))
    else:
        print("  ligado  (a API nao informou o inicio)")
