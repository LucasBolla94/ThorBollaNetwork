#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Confere o serviço de voz com áudio de verdade, do jeito que ele chega.

    python3 testar.py

**Por que áudio de verdade, e não um tom gerado.** Um detector de fala acerta
qualquer senoide e erra voz baixa, voz com fundo de ventilador e voz que faz
pausa para pensar. O corpus tem 300 frases gravadas pelo dono, com o texto
exato de cada uma — então dá para conferir o que importa de verdade: ele
percebeu que começou? percebeu que acabou? sobrou a primeira sílaba?

**Por que em pedaços de 64 ms.** É exatamente como o navegador manda. Entregar
a frase inteira de uma vez testaria um caminho que nunca acontece em produção
e deixaria passar o erro mais provável: contagem de silêncio que só funciona
quando o áudio chega inteiro.

O que cada conferência protege:

    começa          se não detectar o começo, o turno nunca abre e ele fica mudo
    primeira sílaba sem a folga de ANTES_MS, "não quero" chega como "quero"
    fecha           se não detectar o fim, ele nunca responde
    não fecha cedo  fechar numa pausa curta corta a pessoa no meio da frase
    tosse           um estalo não pode virar um turno
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

ENDERECO = os.environ.get("THOR_VOZ_URL", "http://127.0.0.1:8798")
CORPUS = Path(os.environ.get("CORPUS", Path.home() / "voz" / "corpus"))
TAXA = 16000
PEDACO = 1024          # amostras; igual ao do navegador (64 ms)

falhas = 0
total = 0


def conferir(o_que, ok, detalhe=""):
    global falhas, total
    total += 1
    if not ok:
        falhas += 1
    print(f"  {'ok    ' if ok else 'ERRADO'} {o_que}" + (f"   {detalhe}" if detalhe else ""))


def pedir(caminho, corpo=None, tipo="application/json"):
    dados = corpo
    if isinstance(corpo, dict):
        dados = json.dumps(corpo).encode("utf-8")
    req = urllib.request.Request(ENDERECO + caminho, data=dados, method="GET" if dados is None else "POST")
    if dados is not None:
        req.add_header("Content-Type", tipo)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            bruto = r.read()
            if r.headers.get("Content-Type", "").startswith("application/json"):
                return json.loads(bruto), dict(r.headers)
            return bruto, dict(r.headers)
    except urllib.error.HTTPError as e:
        return {"erro_http": e.code, "corpo": e.read()[:200].decode("utf-8", "replace")}, {}
    except Exception as e:  # noqa: BLE001
        return {"erro": f"{type(e).__name__}: {e}"}, {}


def ler_frase(indice=0):
    """Uma frase do corpus, a 16 kHz, como o navegador mandaria."""
    import csv
    with open(CORPUS / "metadata.csv", encoding="utf-8") as f:
        linhas = [l for l in csv.reader(f, delimiter="|") if len(l) >= 2]
    nome, texto = linhas[indice]
    caminho = CORPUS / "wavs" / f"{nome}.wav"
    with wave.open(str(caminho), "rb") as w:
        taxa, quadros = w.getframerate(), w.getnframes()
        bruto = w.readframes(quadros)
    if taxa != TAXA:
        import numpy as np
        import librosa
        x = np.frombuffer(bruto, dtype="<i2").astype("float32") / 32768.0
        x = librosa.resample(x, orig_sr=taxa, target_sr=TAXA)
        bruto = (x * 32767).astype("<i2").tobytes()
    return bruto, texto


def silencio(ms):
    return b"\x00\x00" * int(TAXA * ms / 1000)


def duracao_da_fala(pcm, piso=0.02):
    """Quanto tempo vai da primeira a ultima amostra audivel.

    Serve para conferir o corte sem culpar o servico pelo silencio que ja
    estava na gravacao. Mede em janelas de 20 ms para um estalo isolado nao
    esticar a conta.
    """
    import numpy as np
    x = np.frombuffer(pcm, dtype="<i2").astype("float32") / 32768.0
    janela = int(TAXA * 0.02)
    sobra = len(x) % janela
    if sobra:
        x = x[:-sobra]
    niveis = np.abs(x.reshape(-1, janela)).max(axis=1)
    audiveis = np.flatnonzero(niveis >= piso)
    if not len(audiveis):
        return 0.0
    return (audiveis[-1] - audiveis[0] + 1) * 0.02


def mandar(sessao, pcm, parar_ao_fechar=True):
    """Entrega o áudio em pedaços de 64 ms e devolve o que o serviço disse.

    Para no primeiro `parou`, como o Thor faz: depois que o turno fecha, o
    áudio seguinte pertence ao turno seguinte.
    """
    passo = PEDACO * 2
    estados = []
    for i in range(0, len(pcm), passo):
        resposta, _ = pedir(f"/ouvir/{sessao}", pcm[i:i + passo], "application/octet-stream")
        estados.append(resposta)
        if parar_ao_fechar and resposta.get("parou"):
            break
    return estados


def main() -> int:
    saude, _ = pedir("/saude")
    if not saude.get("ok"):
        print(f"  servico de voz nao respondeu em {ENDERECO}: {saude}")
        return 1

    na_nuvem = saude.get("na_nuvem")
    print(f"  escuta: {saude.get('escuta')}"
          f"{' (fora da maquina)' if na_nuvem else ' (aqui dentro)'}"
          f"  |  fala: {'sim' if saude.get('fala') else 'NAO'}"
          f"  |  silencio: {saude.get('silencio_ms')} ms\n")

    print("=== silencio nao e fala ===")
    estados = mandar("t-silencio", silencio(800))
    conferir("ninguem falando", all(not e.get("falando") for e in estados))
    conferir("turno nao abriu", all(not e.get("parou") for e in estados))

    print("\n=== um estalo curto nao vira turno ===")
    # 120 ms de som alto: abaixo de FALA_MINIMA_MS (280 ms), entao nao conta.
    import struct
    estalo = b"".join(struct.pack("<h", 12000 if (i // 40) % 2 else -12000)
                      for i in range(int(TAXA * 0.12)))
    estados = mandar("t-estalo", estalo + silencio(900))
    conferir("nao abriu turno com o estalo", all(not e.get("parou") for e in estados))

    print("\n=== uma frase de verdade, em pedacos de 64 ms ===")
    audio, texto = ler_frase(0)
    dur = len(audio) / (TAXA * 2)
    print(f'  frase: "{texto}"  ({dur:.1f}s)')

    t0 = time.time()
    estados = mandar("t-frase", silencio(200) + audio + silencio(1200))
    gasto = time.time() - t0

    conferir("percebeu que comecou a falar", any(e.get("falando") for e in estados))
    fechou = [e for e in estados if e.get("parou")]
    conferir("percebeu que a fala acabou", bool(fechou))

    if fechou:
        f = fechou[0]
        guardado = f.get("segundos", 0)
        # **Comparar com a duracao do arquivo seria errado**, e essa conferencia
        # ja falhou uma vez por isso. Toda gravacao tem silencio no comeco e no
        # fim, e o servico corta esse silencio de proposito — entao "guardou
        # menos que o arquivo" e o comportamento certo, nao um defeito.
        #
        # O que importa e se cobriu a FALA. Entao a medida e o trecho entre a
        # primeira e a ultima amostra audivel do original: isso o servico tem
        # de ter guardado inteiro, mais a espera de silencio.
        fala_s = duracao_da_fala(audio)
        minimo = fala_s + saude.get("silencio_ms", 520) / 1000 - 0.15
        conferir("guardou a fala inteira, sem comer o comeco",
                 guardado >= minimo,
                 f"{guardado:.2f}s guardados, {fala_s:.2f}s de fala, esperava >= {minimo:.2f}s")
        conferir("nao guardou silencio demais",
                 guardado <= fala_s + 1.4, f"{guardado:.2f}s")

        if na_nuvem:
            import base64
            wav = base64.b64decode(f.get("wav", ""))
            conferir("devolveu um WAV de verdade", wav[:4] == b"RIFF" and len(wav) > 1000,
                     f"{len(wav)} bytes")
        else:
            saiu = (f.get("texto") or "").lower()
            primeira = texto.split()[0].lower().strip(",.")
            conferir("transcreveu algo", len(saiu) > 3, f'"{saiu[:60]}"')
            conferir("pegou a primeira palavra", primeira[:4] in saiu,
                     f'esperava "{primeira}" em "{saiu[:40]}"')
        print(f"  (o turno inteiro levou {gasto:.1f}s de ponta a ponta)")

    print("\n=== uma pausa para pensar nao fecha o turno ===")
    # Pausa de 300 ms, abaixo dos 520 ms de SILENCIO_MS: tem de continuar
    # ouvindo. Fechar aqui cortaria a pessoa no meio do raciocinio.
    meio = len(audio) // 2
    estados = mandar("t-pausa", silencio(200) + audio[:meio] + silencio(300) + audio[meio:],
                     parar_ao_fechar=True)
    conferir("nao fechou na pausa curta", not any(e.get("parou") for e in estados))

    print("\n=== fechar na forca devolve o que tinha ===")
    mandar("t-forca", silencio(150) + audio[:meio], parar_ao_fechar=False)
    fim, _ = pedir("/ouvir/t-forca/fim", b"", "application/octet-stream")
    conferir("fechou e devolveu", fim.get("parou") is True and fim.get("segundos", 0) > 0.3,
             f"{fim.get('segundos')}s")

    print("\n=== falar ===")
    if not saude.get("fala"):
        print("  (sem modelo de voz instalado; nada a conferir aqui)")
    else:
        frase = "O servidor esta estavel, senhor. Nenhum alerta desde ontem."
        t0 = time.time()
        audio_saida, cabecas = pedir("/falar", {"texto": frase})
        gasto = time.time() - t0
        taxa = int(cabecas.get("X-Taxa", 0) or 0)
        segundos = len(audio_saida) / (taxa * 2) if taxa else 0
        conferir("saiu audio", len(audio_saida) > 10000, f"{len(audio_saida)} bytes")
        conferir("na taxa do modelo", taxa in (16000, 22050, 24000), f"{taxa} Hz")
        conferir("duracao plausivel para a frase", 2.0 <= segundos <= 8.0, f"{segundos:.1f}s")
        if gasto > 0:
            vezes = segundos / gasto
            conferir("rapido o bastante para conversa (>= 3x tempo real)", vezes >= 3,
                     f"{vezes:.1f}x tempo real")

        print("\n=== marcas e formatacao nao viram som ===")
        curto, _ = pedir("/falar", {"texto": "Pronto."})
        longo, _ = pedir("/falar", {"texto": "Pronto. `codigo` **negrito** [link](http://x)"})
        # O segundo tem mais palavras faladas, entao e maior — mas se as
        # marcas fossem lidas ("acento grave", "asterisco") seria MUITO maior.
        conferir("texto com marcacao nao explode de tamanho",
                 len(longo) < len(curto) * 6,
                 f"{len(curto)} -> {len(longo)} bytes")

    print(f"\n{total - falhas}/{total} conferencias passaram")
    if falhas:
        print(f"{falhas} FALHA(S)")
    for s in ("t-silencio", "t-estalo", "t-frase", "t-pausa", "t-forca"):
        urllib.request.urlopen(
            urllib.request.Request(f"{ENDERECO}/ouvir/{s}", method="DELETE"), timeout=5
        ).read()
    return 1 if falhas else 0


if __name__ == "__main__":
    raise SystemExit(main())
