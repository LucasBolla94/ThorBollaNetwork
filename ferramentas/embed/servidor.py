#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Serviço de embed do Thor.

Transforma frase em vetor, para a memória poder ser achada por **sentido** e
não só por palavra igual. É o que faz "não gosto de texto longo" encontrar
"prefere mensagens curtas".

Roda como processo separado, de propósito. O Thor é Node e isto é Python; mais
importante, um modelo que trava não pode levar o agente junto. Se este serviço
cair, a busca por palavra continua funcionando e o Thor só fica um pouco mais
limitado até ele voltar.

Escuta só em 127.0.0.1. Não tem autenticação porque não precisa: nada de fora
do servidor alcança esta porta.

    python3 servidor.py            # porta 8799
    THOR_EMBED_PORTA=9000 python3 servidor.py
"""

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Duas linhas, antes de carregar o modelo: sem isto o onnxruntime toma todos os
# núcleos para si e o servidor inteiro engasga durante uma busca.
THREADS = int(os.environ.get("THOR_EMBED_THREADS", "2"))
os.environ.setdefault("OMP_NUM_THREADS", str(THREADS))

from fastembed import TextEmbedding  # noqa: E402

# Medido neste servidor contra pares que dizem a mesma coisa com outras
# palavras: margem +0,284, contra +0,156 do MiniLM. Custa 1,9 GB numa máquina
# de 31 GB e 33 ms por frase, e só roda quando se guarda ou se busca memória.
# A conta está em ferramentas/medir-embed.py.
MODELO = os.environ.get("THOR_EMBED_MODELO", "sentence-transformers/paraphrase-multilingual-mpnet-base-v2")
PORTA = int(os.environ.get("THOR_EMBED_PORTA", "8799"))
LIMITE_TEXTOS = 64
LIMITE_CARACTERES = 4000

print(f"[embed] carregando {MODELO} com {THREADS} threads...", flush=True)
_t0 = time.time()
_modelo = TextEmbedding(model_name=MODELO, threads=THREADS)
_dim = len(list(_modelo.embed(["aquecendo"]))[0])
print(f"[embed] pronto em {time.time() - _t0:.1f}s, dimensao {_dim}", flush=True)

# O fastembed não promete ser seguro para chamadas simultâneas; uma trava é
# mais barata que descobrir isso em produção.
_trava = threading.Lock()


def vetorizar(textos):
    limpos = [t.strip()[:LIMITE_CARACTERES] for t in textos if isinstance(t, str) and t.strip()]
    if not limpos:
        return []
    with _trava:
        return [v.tolist() for v in _modelo.embed(limpos)]


class Alca(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _responder(self, codigo, corpo):
        dados = json.dumps(corpo).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        self.wfile.write(dados)

    def do_GET(self):
        if self.path == "/saude":
            return self._responder(200, {"ok": True, "modelo": MODELO, "dim": _dim})
        self._responder(404, {"erro": "nao encontrado"})

    def do_POST(self):
        if self.path != "/vetor":
            return self._responder(404, {"erro": "nao encontrado"})
        try:
            tamanho = int(self.headers.get("Content-Length", 0))
            if tamanho > 1_000_000:
                return self._responder(413, {"erro": "pedido grande demais"})
            pedido = json.loads(self.rfile.read(tamanho) or b"{}")
            textos = pedido.get("textos") or []
            if not isinstance(textos, list):
                return self._responder(400, {"erro": "textos deve ser uma lista"})
            if len(textos) > LIMITE_TEXTOS:
                return self._responder(400, {"erro": f"no maximo {LIMITE_TEXTOS} textos por vez"})
            t0 = time.time()
            vetores = vetorizar(textos)
            return self._responder(200, {"vetores": vetores, "ms": round((time.time() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001
            print(f"[embed] erro: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            self._responder(500, {"erro": "falha ao vetorizar"})

    def log_message(self, *_args):
        """Silencia o log por requisicao: sao centenas por dia e nenhum informa nada."""


if __name__ == "__main__":
    servidor = ThreadingHTTPServer(("127.0.0.1", PORTA), Alca)
    print(f"[embed] escutando em 127.0.0.1:{PORTA}", flush=True)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
