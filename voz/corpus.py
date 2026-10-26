# -*- coding: utf-8 -*-
"""
Monta o corpus de frases que o professor vai falar.

O que um treino de voz precisa do texto:

  - **variedade fonetica**: todo som do portugues tem de aparecer muitas vezes,
    em posicoes diferentes da palavra e da frase
  - **variedade prosodica**: afirmacao, pergunta, lista, numero, nome proprio —
    cada um tem curva de entonacao diferente
  - **frases curtas**: 4 a 15 palavras. Frase longa faz o modelo
    autorregressivo entrar em laco, e e nela que a geracao erra
  - **texto acentuado**: sem acento a silaba tonica sai errada (plan.md §31.11)

Em vez de escrever centenas de frases na mao, componho a partir de moldes com
lacunas. Sai variedade real de vocabulario e de ritmo com pouco texto fonte.
"""

import random
import sys
import unicodedata

random.seed(20261025)  # mesmo corpus toda vez que rodar

PROJETOS = [
    "o site novo", "a migração do banco", "o relatório mensal", "a proposta do cliente",
    "o backup noturno", "a integração com o pagamento", "o painel de métricas",
    "a revisão do contrato", "o ajuste no servidor", "a campanha de outubro",
    "o inventário", "a auditoria interna", "o treinamento da equipe",
]
PESSOAS = [
    "o João", "a Giulia", "o Rafael", "a Helena", "o Henrique", "a Mônica",
    "o Thiago", "a Letícia", "o Gustavo", "a Bianca", "o pessoal do suporte",
    "a equipe de produto", "o time comercial",
]
HORAS = [
    "às nove da manhã", "às dez e meia", "ao meio-dia", "às duas da tarde",
    "às três e quinze", "às cinco em ponto", "no fim da tarde", "amanhã cedo",
    "depois de amanhã", "na próxima segunda", "na quinta-feira", "ainda hoje",
]
NUMEROS = [
    "três", "sete", "doze", "quinze", "vinte e um", "trinta e quatro",
    "quarenta e cinco", "cinquenta e oito", "setenta", "cem", "duzentos e dez",
]
LUGARES = [
    "na pasta de contratos", "no servidor principal", "aqui no painel",
    "na planilha compartilhada", "no e-mail de ontem", "no canal da equipe",
    "no arquivo que você mandou", "na nuvem", "no relatório anterior",
]
ESTADOS = [
    "está tudo certo", "continua estável", "voltou ao normal", "segue pendente",
    "foi resolvido", "está em andamento", "já foi aprovado", "ainda não começou",
]

MOLDES = [
    "Bom dia, Lucas. {hora} você tem {num} compromissos.",
    "{projeto} {estado}, não precisa de nada seu agora.",
    "{pessoa} mandou mensagem sobre {projeto}.",
    "Separei {num} arquivos {lugar}.",
    "Você quer que eu avise {pessoa} ou prefere falar direto?",
    "A reunião sobre {projeto} ficou {hora}.",
    "Encontrei {num} itens que precisam da sua atenção {lugar}.",
    "{projeto} {estado}. Te aviso se mudar alguma coisa.",
    "{pessoa} perguntou se {projeto} {estado}.",
    "Posso adiantar {projeto} enquanto você resolve o resto?",
    "Olha só: {pessoa} ligou {hora}, e deixou recado.",
    "Guardei o que você falou sobre {projeto}.",
    "Tem {num} mensagens novas, e {num} delas parecem urgentes.",
    "Lembrei de uma coisa: {projeto} vence {hora}.",
    "Achei uma diferença de {num} itens entre as duas versões.",
    "Prefere que eu resuma, ou mando o relatório inteiro?",
    "{hora} eu te lembro de {projeto}, pode deixar comigo.",
    "Conferi {lugar} e {estado}.",
    "Nenhum alerta desde ontem. {projeto} {estado}.",
    "Acabei de salvar isso {lugar}.",
    "{pessoa} e {pessoa2} concordaram sobre {projeto}.",
    "Não encontrei nada {lugar}. Quer que eu procure em outro lugar?",
    "São {num} horas de trabalho estimadas para {projeto}.",
    "Já corrigi o erro, e nada se perdeu.",
    "Houve uma falha no carregamento, mas o backup estava bom.",
    "Qualquer coisa é só chamar, estou aqui.",
]

# Frases fixas para sons que molde nenhum garante: ditongo nasal, erre forte,
# lh, nh, ch, e vogais abertas contra fechadas.
FIXAS = [
    "A reunião de amanhã foi remarcada para a próxima terça.",
    "São opções diferentes, e nenhuma delas atrapalha o cronograma.",
    "O carro do João ficou na garagem, e ele veio de ônibus.",
    "Olha, a planilha tem um erro no cálculo da coluna de março.",
    "Amanhã cedo eu chego antes e organizo tudo.",
    "Minha mãe ligou, e o irmão dela também.",
    "Esse arquivo é antigo, aquele outro é que está certo.",
    "Já achei. Estava escondido numa pasta velha.",
    "Chove muito aqui no final da tarde, então saia antes.",
    "O relatório, o contrato e a proposta estão todos prontos.",
    "Você viu o que o Henrique escreveu sobre a campanha?",
    "Não, ainda não. Mas eu vi o resumo que a Helena mandou.",
    "Trinta e sete por cento dos clientes responderam até agora.",
    "Ele falou que vem, mas não disse a que horas.",
    "Precisamos decidir isso hoje, senão o prazo não fecha.",
    "Tudo bem. Vou deixar anotado e te lembro depois.",
    "A senha foi trocada ontem à noite, por segurança.",
    "O pagamento caiu, e a nota fiscal já foi emitida.",
    "Esqueci de avisar: o João trocou de telefone.",
    "Que horas você quer que eu comece a preparar?",
]


def maiuscula_apos_ponto(texto: str) -> str:
    """Primeira letra da frase E de cada oracao depois de ponto.

    Os moldes tem lacunas no comeco e no meio, e algumas frases tem ponto
    interno — sem isto sai "ontem. a campanha", que o modelo le como
    continuacao e nao como frase nova, com a entonacao errada.
    """
    saida = []
    comecar = True
    for ch in texto:
        saida.append(ch.upper() if comecar and ch.isalpha() else ch)
        if ch.isalpha():
            comecar = False
        elif ch in ".!?":
            comecar = True
    return "".join(saida)


def compor(quantidade: int) -> list[str]:
    frases = list(FIXAS)
    vistos = {texto.lower() for texto in frases}

    tentativas = 0
    while len(frases) < quantidade and tentativas < quantidade * 60:
        tentativas += 1
        molde = random.choice(MOLDES)
        pessoa, pessoa2 = random.sample(PESSOAS, 2)
        texto = molde.format(
            projeto=random.choice(PROJETOS),
            pessoa=pessoa,
            pessoa2=pessoa2,
            hora=random.choice(HORAS),
            num=random.choice(NUMEROS),
            lugar=random.choice(LUGARES),
            estado=random.choice(ESTADOS),
        )
        texto = maiuscula_apos_ponto(texto)
        if texto.lower() in vistos:
            continue
        vistos.add(texto.lower())
        frases.append(texto)

    return frases


def conferir(frases: list[str]) -> None:
    """Avisa se alguma frase perdeu acento — o erro que estragou a §31.11.

    So palavras que SEMPRE levam acento neste corpus. "e" e "ja" ficam de fora
    porque existem sem acento (a conjuncao "e", o "ja" de "ja era") e davam
    falso positivo em um terco das frases.
    """
    suspeitas = [
        f for f in frases
        if any(p in f.split() for p in ("esta", "voce", "reuniao", "nao", "tambem", "proxima"))
    ]
    if suspeitas:
        print(f"AVISO: {len(suspeitas)} frases podem estar sem acento", file=sys.stderr)
        for f in suspeitas[:3]:
            print("   ", f, file=sys.stderr)


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    frases = compor(n)
    conferir(frases)
    comprimento = sum(len(f.split()) for f in frases) / len(frases)
    print(f"# {len(frases)} frases, media de {comprimento:.1f} palavras", file=sys.stderr)
    for f in frases:
        print(f)
