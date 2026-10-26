# -*- coding: utf-8 -*-
"""Quais placas estao realmente disponiveis agora, e por quanto. So le."""
import json
import subprocess
import sys

CHAVE = open("/home/ubuntu/.runpod-key").read().strip()

CONSULTA = """
query {
  gpuTypes {
    id
    displayName
    memoryInGb
    secureCloud
    communityCloud
    lowestPrice(input: {gpuCount: 1}) {
      uninterruptablePrice
      stockStatus
    }
  }
}
"""

saida = subprocess.run(
    ["curl", "-sS", "-m", "40", "-X", "POST",
     "-H", "Content-Type: application/json",
     "-d", json.dumps({"query": CONSULTA}),
     "https://api.runpod.io/graphql?api_key=" + CHAVE],
    capture_output=True, text=True,
).stdout

try:
    d = json.loads(saida)
except Exception:
    print("resposta inesperada:", saida[:400])
    sys.exit(1)

tipos = (d.get("data") or {}).get("gpuTypes") or []

itens = []
for g in tipos:
    vram = g.get("memoryInGb") or 0
    lp = g.get("lowestPrice") or {}
    preco = lp.get("uninterruptablePrice")
    estoque = lp.get("stockStatus")
    if vram < 16 or not preco:
        continue
    itens.append((preco, g.get("displayName") or g["id"], vram, estoque, g["id"]))

itens.sort()
print(f'{"GPU":24} {"VRAM":>5} {"por hora":>9}  {"estoque":10} id')
print("-" * 88)
for preco, nome, vram, estoque, ident in itens[:14]:
    marca = "  <-- tem" if estoque and estoque.lower() not in ("none", "null") else ""
    print(f"{nome[:24]:24} {vram:4}GB  ${preco:7.3f}  {str(estoque):10} {ident}{marca}")
