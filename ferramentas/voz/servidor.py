#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Serviço de voz do Thor: ele ouve e ele fala.

Roda como processo separado, igual ao serviço de embed, e pela mesma razão: um
modelo que trava não pode levar o agente junto. Se este serviço cair, o Thor
continua respondendo por texto e só perde a voz até ele voltar.

Escuta só em 127.0.0.1. Não tem autenticação porque não precisa: quem fala com
ele é o Thor, de dentro da mesma máquina, e nada de fora alcança esta porta.

    python3 servidor.py            # porta 8798
    THOR_VOZ_PORTA=9000 python3 servidor.py


## Por que a detecção de fala mora aqui, e não no navegador

O caminho óbvio seria detectar no navegador e mandar só o que é fala. Economiza
banda. Foi descartado por três motivos, em ordem de peso:

1. **Quem decide o fim do turno precisa ouvir o silêncio.** Se o navegador
   manda só a fala, o servidor nunca ouve a pausa e o fim do turno passa a ser
   um aviso do cliente — mais uma coisa para desalinhar.
2. **O detector no navegador erra mais.** Rodando em WebAssembly ele dispara
   fora de hora em alguns navegadores, e o jeito de descobrir isso é o usuário
   reclamando.
3. **Afinar num lugar só.** A espera de silêncio é o maior pedaço da demora
   percebida (ver SILENCIO_MS). Ajustar isso num arquivo do servidor é
   recarregar um serviço; no navegador é publicar e esperar o cache virar.

A banda que isto custa é 32 KB/s enquanto o microfone está ligado — menos que
uma ligação telefônica.


## Por que HTTP comum e não WebSocket

O serviço guarda o estado de cada conversa (o áudio juntado e a contagem de
silêncio) e o Thor manda os pedaços conforme chegam. Isso dá para fazer com
HTTP simples, sem dependência nova, e com uma vantagem prática grande: dá para
depurar com `curl`. WebSocket aqui dentro só acrescentaria uma biblioteca e um
jeito a mais de quebrar.


## Onde a transcrição acontece: aqui ou na nuvem

Medido neste servidor, com as 300 frases que o dono gravou (a conta está em
`ferramentas/medir-escuta.py` e `medir-escuta-fundo.py`):

    modelo            velocidade        erro      por frase
    small               0,6x real       10%         5,6 s
    medium              0,2x real        6%        17,0 s
    large-v3-turbo      0,1x real        6%        27,5 s

**0,6x significa mais devagar do que a fala acontece.** Uma frase de quatro
segundos custa 5,6 segundos para ser entendida. Isso não é conversa, é
rádio amador.

A causa é o processador: um Xeon de 2013, com AVX mas **sem AVX2**, que é a
instrução de que o motor do Whisper mais depende. Testei quantizar diferente
(int8, int16, float32) e não muda nada — float32 saiu até um pouco mais lento.
Não é ajuste errado, é a máquina.

Então existem dois modos, e o padrão é `nuvem`:

    local   transcreve aqui. Honesto e privado, mas 5,6 s por frase neste
            processador. Serve se um dia a máquina trocar, ou se o dono
            preferir que nada saia daqui e aceitar a espera.
    nuvem   manda o áudio do turno para o Thor transcrever fora. Rápido e
            barato. O serviço nem carrega o modelo de escuta, o que economiza
            2,9 GB de memória.

**Sobre o que sai da máquina no modo nuvem.** Sai o áudio do que o dono falou.
O texto dessa mesma conversa já vai para a LLM na nuvem de qualquer forma —
então o conteúdo já saía; o que passa a sair é a gravação. O que **não** sai
nunca é o modelo da voz dele, que é o que permitiria clonagem: falar continua
100% aqui dentro.


## As rotas

    POST /ouvir/<sessao>      corpo = PCM 16 kHz, 16 bits, mono, cru
                              -> {"falando", "parou", "texto", "ms"}
                              no modo nuvem, "wav" (base64) em vez de "texto"
    POST /ouvir/<sessao>/fim  fecha o turno na força
    DELETE /ouvir/<sessao>    descarta a sessão
    POST /falar               {"texto": "..."} -> PCM 22,05 kHz cru
    GET  /saude
"""

import base64
import io
import json
import os
import re
import sys
import threading
import time
import wave
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Antes de carregar qualquer modelo: sem isto o onnxruntime toma todos os
# núcleos e o servidor inteiro engasga a cada frase transcrita.
THREADS = int(os.environ.get("THOR_VOZ_THREADS", "4"))
os.environ.setdefault("OMP_NUM_THREADS", str(THREADS))

import numpy as np  # noqa: E402

PORTA = int(os.environ.get("THOR_VOZ_PORTA", "8798"))
MODELO_ESCUTA = os.environ.get("THOR_VOZ_ESCUTA", "small")
CAMINHO_VOZ = os.environ.get("THOR_VOZ_MODELO", "/opt/thor/data/voz/voz.onnx")

TAXA_ESCUTA = 16000      # o Whisper só trabalha nesta taxa
QUADRO = 512             # amostras; a v5 do detector exige exatamente isto
QUADRO_MS = QUADRO / TAXA_ESCUTA * 1000   # 32 ms

# ---------------------------------------------------------------------------
# Os números que decidem como a conversa parece.
#
# SILENCIO_MS é o maior pedaço da demora que dá para controlar. É quanto tempo
# de silêncio conta como "ele terminou de falar". Curto demais, ele corta você
# no meio de uma pausa para pensar; longo demais, a conversa fica pesada.
# 520 ms fica no limite de baixo do que se usa na prática (500 a 640 ms) — e
# quem corrige um corte errado é a interrupção: dá para falar por cima.
#
# FALA_MINIMA_MS evita que tosse, batida de mesa ou um "ãh" virem um turno.
#
# ANTES_MS é o que se guarda de áudio ANTES de a fala ser reconhecida. O
# detector precisa de uns quadros para ter certeza, e sem esta folga a primeira
# sílaba se perde — some o "não" de "não quero", que inverte a frase.
# ---------------------------------------------------------------------------
SILENCIO_MS = int(os.environ.get("THOR_VOZ_SILENCIO_MS", "520"))
FALA_MINIMA_MS = int(os.environ.get("THOR_VOZ_FALA_MINIMA_MS", "280"))
ANTES_MS = int(os.environ.get("THOR_VOZ_ANTES_MS", "320"))
LIMIAR_FALA = float(os.environ.get("THOR_VOZ_LIMIAR", "0.5"))

TETO_TURNO_S = 45        # ninguém fala 45s seguidos com um assistente
VALIDADE_SESSAO_S = 300  # sessão esquecida é limpa, para não vazar memória
LIMITE_CORPO = 4_000_000

print("[voz] carregando detector de fala...", flush=True)
_t0 = time.time()
import torch  # noqa: E402

torch.set_num_threads(THREADS)
from silero_vad import load_silero_vad  # noqa: E402

_detector = load_silero_vad(onnx=True)
print(f"[voz] detector pronto em {time.time() - _t0:.1f}s "
      f"(0,4 ms por quadro de 32 ms, medido)", flush=True)

# No modo nuvem o modelo nem e carregado: quem transcreve e o Thor, do outro
# lado. Economiza 2,9 GB de memoria e os 30s de arranque.
_escuta = None
NA_NUVEM = MODELO_ESCUTA.lower() in ("nuvem", "remota", "remoto")
if NA_NUVEM:
    print("[voz] escuta NA NUVEM: aqui so detecto fala e mando o audio do turno",
          flush=True)
else:
    print(f"[voz] carregando escuta ({MODELO_ESCUTA}) aqui mesmo...", flush=True)
    _t0 = time.time()
    from faster_whisper import WhisperModel  # noqa: E402

    _escuta = WhisperModel(MODELO_ESCUTA, device="cpu", compute_type="int8",
                           cpu_threads=THREADS)
    print(f"[voz] escuta pronta em {time.time() - _t0:.1f}s "
          f"(medido: ~5,6s por frase com `small` nesta maquina)", flush=True)

_fala = None
_ajuste_fala = None
_taxa_fala = 22050
if os.path.exists(CAMINHO_VOZ):
    print(f"[voz] carregando fala ({CAMINHO_VOZ})...", flush=True)
    _t0 = time.time()
    from piper import PiperVoice, SynthesisConfig  # noqa: E402

    _fala = PiperVoice.load(CAMINHO_VOZ, config_path=CAMINHO_VOZ + ".json")
    _taxa_fala = _fala.config.sample_rate
    _ajuste_fala = SynthesisConfig(volume=1.0, length_scale=1.0, normalize_audio=True)
    print(f"[voz] fala pronta em {time.time() - _t0:.1f}s, {_taxa_fala} Hz", flush=True)
else:
    print(f"[voz] SEM VOZ: {CAMINHO_VOZ} nao existe — ele ouve, mas nao fala", flush=True)

# Nem o Whisper nem o Piper prometem ser seguros para chamadas simultâneas, e
# uma trava é mais barata que descobrir isso em produção. Travas separadas:
# transcrever uma frase não precisa esperar a síntese de outra.
_trava_escuta = threading.Lock()
_trava_fala = threading.Lock()
_trava_sessoes = threading.Lock()


# ===========================================================================
# Uma conversa que está sendo ouvida.
# ===========================================================================
class Sessao:
    def __init__(self):
        self.falando = False
        self.fala = bytearray()      # o áudio do turno em curso
        self.sobra = b""             # bytes que ainda não completam um quadro
        self.quadros_fala = 0
        self.quadros_silencio = 0
        # Guarda o pouco de áudio anterior à fala, para não comer a primeira
        # sílaba. O tamanho é em quadros.
        self.antes = deque(maxlen=max(1, int(ANTES_MS / QUADRO_MS)))
        self.visto = time.time()
        self.trava = threading.Lock()

    def zerar(self):
        self.falando = False
        self.fala = bytearray()
        self.quadros_fala = 0
        self.quadros_silencio = 0
        self.antes.clear()


_sessoes: dict = {}


def sessao(nome: str) -> Sessao:
    with _trava_sessoes:
        agora = time.time()
        # Limpa o que foi abandonado, aproveitando a passagem.
        for k in [k for k, s in _sessoes.items() if agora - s.visto > VALIDADE_SESSAO_S]:
            _sessoes.pop(k, None)
        s = _sessoes.get(nome)
        if s is None:
            s = _sessoes[nome] = Sessao()
        s.visto = agora
        return s


# ===========================================================================
# Ouvir.
# ===========================================================================
def curto_demais(audio: bytes) -> bool:
    """Menos de 0,2s nao e frase: e porta batendo, estalo, um "ah"."""
    return len(audio) < TAXA_ESCUTA * 2 * 0.2


def como_wav(pcm: bytes) -> bytes:
    """Poe o cabecalho de WAV no PCM cru.

    Quem transcreve na nuvem recebe um arquivo, nao amostras soltas. Montar o
    cabecalho aqui — 44 bytes — evita uma dependencia inteira so para isso.
    """
    saco = io.BytesIO()
    with wave.open(saco, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TAXA_ESCUTA)
        w.writeframes(pcm)
    return saco.getvalue()


def resultado_do_turno(audio: bytes, extra: dict) -> dict:
    """O que devolver quando o turno fecha, conforme quem transcreve.

    No modo nuvem vai o audio em base64. Base64 cresce o corpo em um terco —
    213 KB em vez de 160 KB para cinco segundos de fala — e isso nao importa,
    porque a viagem e pelo proprio computador. A alternativa seria uma segunda
    requisicao para buscar o audio, o que obrigaria a guardar o turno fechado
    aqui e inventar quando jogar fora.
    """
    base = {"falando": False, "parou": True,
            "segundos": round(len(audio) / (TAXA_ESCUTA * 2), 2), **extra}
    if curto_demais(audio):
        return {**base, "texto": ""}
    if NA_NUVEM:
        return {**base, "wav": base64.b64encode(como_wav(audio)).decode("ascii")}
    return {**base, "texto": transcrever(audio)}


def transcrever(audio: bytes) -> str:
    if _escuta is None or curto_demais(audio):
        return ""
    dados = np.frombuffer(bytes(audio), dtype="<i2").astype("float32") / 32768.0
    with _trava_escuta:
        # beam_size=1 de propósito: em conversa, 200 ms de demora pesam mais
        # que o ganho de qualidade de procurar mais caminhos.
        trechos, _ = _escuta.transcribe(
            dados, language="pt", beam_size=1,
            condition_on_previous_text=False,
            vad_filter=False,   # o corte já foi feito aqui, pelo detector
        )
        return " ".join(t.text for t in trechos).strip()


def engolir(s: Sessao, pcm: bytes) -> dict:
    """Recebe um pedaço de áudio e diz se o turno fechou."""
    t0 = time.time()
    with s.trava:
        dados = s.sobra + pcm
        passo = QUADRO * 2
        inteiros = len(dados) // passo
        s.sobra = dados[inteiros * passo:]
        parou = False

        for i in range(inteiros):
            quadro = dados[i * passo:(i + 1) * passo]
            amostras = np.frombuffer(quadro, dtype="<i2").astype("float32") / 32768.0
            chance = float(_detector(torch.from_numpy(amostras), TAXA_ESCUTA).item())

            if chance >= LIMIAR_FALA:
                s.quadros_silencio = 0
                s.quadros_fala += 1
                if not s.falando:
                    if s.quadros_fala * QUADRO_MS >= FALA_MINIMA_MS:
                        # Começou de verdade: o que foi guardado entra na frente.
                        s.falando = True
                        for antigo in s.antes:
                            s.fala += antigo
                        s.antes.clear()
                    else:
                        s.antes.append(quadro)
                        continue
                s.fala += quadro
            else:
                if s.falando:
                    s.quadros_silencio += 1
                    # O silêncio entra no áudio: cortar exatamente na última
                    # sílaba deixa a transcrição sem o final da palavra.
                    s.fala += quadro
                    if s.quadros_silencio * QUADRO_MS >= SILENCIO_MS:
                        parou = True
                        break
                else:
                    s.quadros_fala = 0
                    s.antes.append(quadro)

        if s.falando and len(s.fala) / (TAXA_ESCUTA * 2) >= TETO_TURNO_S:
            parou = True

        if not parou:
            return {"falando": s.falando, "parou": False, "texto": "",
                    "ms": round((time.time() - t0) * 1000)}

        audio = bytes(s.fala)
        s.zerar()

    # Fora da trava da sessão: transcrever dura segundos e não pode bloquear a
    # chegada do próximo pedaço de áudio.
    return resultado_do_turno(audio, {"ms": round((time.time() - t0) * 1000)})


def fechar(s: Sessao) -> dict:
    """Fecha o turno na força — quem está do outro lado soltou o botão."""
    with s.trava:
        audio = bytes(s.fala)
        s.zerar()
    return resultado_do_turno(audio, {})


# ===========================================================================
# Falar.
# ===========================================================================
# Marcas de formatação não se leem em voz alta: "**certo**" sairia como
# "asterisco asterisco certo". Também saem as cercas de código e os links, que
# viram ruído puro quando falados.
_LIMPEZAS = [
    (re.compile(r"```[\s\S]*?```"), " "),
    (re.compile(r"`([^`]*)`"), r"\1"),
    (re.compile(r"!?\[([^\]]*)\]\([^)]*\)"), r"\1"),
    (re.compile(r"[*_#>|]+"), " "),
    (re.compile(r"^\s*[-+]\s+", re.M), " "),
    (re.compile(r"\s{2,}"), " "),
]


def para_voz(texto: str) -> str:
    for padrao, troca in _LIMPEZAS:
        texto = padrao.sub(troca, texto)
    return texto.strip()


def sintetizar(texto: str) -> bytes:
    limpo = para_voz(texto)
    if not limpo or _fala is None:
        return b""
    partes = []
    with _trava_fala:
        for pedaco in _fala.synthesize(limpo, syn_config=_ajuste_fala):
            partes.append(pedaco.audio_int16_bytes)
    return b"".join(partes)


# ===========================================================================
# HTTP.
# ===========================================================================
class Alca(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, codigo, corpo):
        dados = json.dumps(corpo).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        self.wfile.write(dados)

    def _corpo(self) -> bytes:
        tamanho = int(self.headers.get("Content-Length", 0))
        if tamanho > LIMITE_CORPO:
            return b""
        return self.rfile.read(tamanho) if tamanho else b""

    def do_GET(self):
        if self.path == "/saude":
            return self._json(200, {
                "ok": True,
                "escuta": MODELO_ESCUTA,
                "na_nuvem": NA_NUVEM,
                "fala": bool(_fala),
                "taxa_escuta": TAXA_ESCUTA,
                "taxa_fala": _taxa_fala,
                "silencio_ms": SILENCIO_MS,
                "sessoes": len(_sessoes),
            })
        self._json(404, {"erro": "nao encontrado"})

    def do_DELETE(self):
        partes = self.path.strip("/").split("/")
        if len(partes) == 2 and partes[0] == "ouvir":
            with _trava_sessoes:
                _sessoes.pop(partes[1], None)
            return self._json(200, {"ok": True})
        self._json(404, {"erro": "nao encontrado"})

    def do_POST(self):
        partes = self.path.strip("/").split("/")
        try:
            if partes[:1] == ["falar"]:
                pedido = json.loads(self._corpo() or b"{}")
                texto = str(pedido.get("texto") or "")[:2000]
                if not texto.strip():
                    return self._json(400, {"erro": "texto vazio"})
                if _fala is None:
                    return self._json(503, {"erro": "sem modelo de voz"})
                t0 = time.time()
                audio = sintetizar(texto)
                segundos = len(audio) / (_taxa_fala * 2)
                gasto = time.time() - t0
                self.send_response(200)
                self.send_header("Content-Type", "audio/pcm")
                self.send_header("X-Taxa", str(_taxa_fala))
                self.send_header("X-Segundos", f"{segundos:.2f}")
                self.send_header("X-Ms", str(round(gasto * 1000)))
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                return self.wfile.write(audio)

            if partes[:1] == ["ouvir"] and len(partes) >= 2:
                s = sessao(partes[1])
                if len(partes) == 3 and partes[2] == "fim":
                    return self._json(200, fechar(s))
                corpo = self._corpo()
                if not corpo:
                    return self._json(400, {"erro": "corpo vazio"})
                return self._json(200, engolir(s, corpo))

            self._json(404, {"erro": "nao encontrado"})
        except Exception as e:  # noqa: BLE001
            print(f"[voz] erro em {self.path}: {type(e).__name__}: {e}",
                  file=sys.stderr, flush=True)
            self._json(500, {"erro": "falha no servico de voz"})

    def log_message(self, *_args):
        """Silencia o log por requisicao: sao varios por segundo quando o
        microfone esta ligado, e nenhum informa nada."""


if __name__ == "__main__":
    servidor = ThreadingHTTPServer(("127.0.0.1", PORTA), Alca)
    print(f"[voz] escutando em 127.0.0.1:{PORTA}", flush=True)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
