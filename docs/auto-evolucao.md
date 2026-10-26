# O agente que se constrói sozinho

Como o Thor deixa de ser configurado na mão e passa a aprender: a personalidade
nasce de uma conversa, e a memória se revisa com o tempo.

Pensado como **produto**: qualquer pessoa instala, e ele se monta para ela.

**Construido.** O que esta escrito aqui e o que esta rodando; o diario tem o
relato da execucao e os erros que os testes acharam.

---

## 1. O que a pesquisa diz

Quatro achados que mudaram o desenho.

### Autocrítica solta não funciona

O resultado mais importante: **crítica ancorada em evidência funciona; o modelo
refletindo livremente sobre si mesmo não.** E a maior parte do ganho vem na
primeira ou segunda passada — insistir além disso não melhora.

Consequência prática: a reflexão não pode ser "o que você acha da sua
memória?". Ela recebe **fatos medidos** — o que nunca foi usado, o que é quase
idêntico a outra coisa, o que o dono corrigiu — e devolve **operações**.

### Memória se recupera por três sinais, não um

O desenho dos *Generative Agents* pontua cada memória por **recência,
relevância e importância**, somadas. A recência decai sozinha; a importância é
dada por um modelo no momento em que a memória nasce; a relevância é a
proximidade com a pergunta de agora.

Hoje usamos só relevância. Faltam os outros dois.

### Reflexão vira memória nova

No mesmo desenho, a reflexão não gera um relatório à parte: ela escreve
**memórias de nível mais alto** que voltam para o mesmo acervo e passam a ser
recuperadas como qualquer outra. É assim que "ele reparou em três coisas
parecidas" vira "ele entendeu um padrão".

E é disparada por acúmulo — quando chega coisa nova o bastante desde a última.

### Entrevista curta, uma pergunta por vez

Para montar persona: perguntas básicas, **uma de cada vez**, do geral para o
específico, sem deixar a conversa divagar. Começar neutro e ajustar depois,
porque **é mais fácil acrescentar personalidade do que tirar**.

E o que a máquina consegue descobrir sozinha, não se pergunta.

### O que o Hermes faz

Ele tem um fluxo de primeira execução em etapas, com registro do que já foi
respondido. Separa o fluxo (lógica), o texto (as palavras) e os fatos
automáticos (sistema, idioma) — e **só pergunta o que não dá para detectar**.

E tem uma garantia que vale copiar inteira: ele só sobrescreve a personalidade
se ela ainda for exatamente o texto que ele mesmo semeou. Qualquer edição do
dono torna o arquivo intocável.

---

## 2. O problema de hoje

| hoje | devia ser |
|---|---|
| eu escrevi a personalidade à mão | ela nasce de uma conversa com o dono |
| o nome "Lucas" está dentro dela | o dono é quem o agente conhecer |
| o arquivo mora no repositório | mora na instalação de cada um |
| eu decidi quais tipos viram essenciais | o uso decide |
| a memória nunca se revisa | ele revisa e consolida |

---

## 3. O plano

### Parte 1 — Duas camadas de personalidade

**A base** (no repositório, igual para todos): como o agente trabalha. Direto,
calcula os dois lados, nunca decide pelo dono, admite não saber. É o produto.

**O perfil** (na instalação, por pessoa): quem é o dono, como tratá-lo, quanto
detalhe quer, o que ele faz. Nasce da entrevista, e o dono pode editar.

A base nunca some. O perfil é de quem instalou.

### Parte 2 — A entrevista

Na primeira conversa, o agente faz **cinco perguntas, uma por vez**:

1. Como devo te chamar?
2. Quer que eu te trate de forma formal ou direta?
3. Quando você me pedir uma decisão: escolho por você, ou mostro os caminhos?
4. Resposta curta por padrão, ou completa?
5. Em que você mais quer ajuda?

Ele escreve o perfil a partir das respostas e **mostra para o dono confirmar**.

Não pergunta o que dá para saber sozinho: data, fuso, o que está instalado.

**Uma regra de segurança:** depois que o dono editar o perfil, o agente nunca
mais o sobrescreve sozinho — só propõe mudanças.

### Parte 3 — Importância, dada quando a memória nasce

A colheita já chama um modelo barato. Ela passa a dar também uma nota de
**importância de 1 a 5** para cada memória, no mesmo custo.

Sem isso, "o disco estava em 21%" e "ele decide rápido e odeia ser perguntado
duas vezes" valem o mesmo — e não valem.

### Parte 4 — Busca pelos três sinais

A recuperação passa a somar:

```
nota = relevância + importância + recência
```

Relevância é a proximidade de sentido; importância vem da parte 3; recência
decai sozinha com o tempo sem uso.

### Parte 5 — A reflexão

Roda quando entram memórias novas o bastante desde a última. Recebe **evidência
medida**, não a memória inteira:

- o que nunca foi usado em muito tempo
- pares quase idênticos (candidatos a repetição ou contradição)
- o que foi corrigido recentemente
- contagens

E devolve **operações**:

| operação | o que faz |
|---|---|
| `juntar` | funde memórias repetidas numa só, melhor escrita |
| `corrigir` | resolve contradição, mantendo a antiga como superada |
| `arquivar` | tira do núcleo o que não serve mais (não apaga) |
| `entender` | escreve uma memória nova, de nível mais alto |

A última é a que faz ele evoluir: três observações parecidas viram um
entendimento.

**Nada é apagado, nunca.** Toda operação deixa rastro, e dá para ver depois o
que ele mudou sozinho e por quê.

### Parte 6 — Limites que ele não mexe

Separação importante: **aprendizado** ele ajusta; **limite de segurança** não.

| ele ajusta | fixo |
|---|---|
| o que é essencial | tempo de expiração de uma autorização |
| o limiar da busca | o que a ferramenta de comandos deixa passar |
| o que está repetido ou errado | o que nunca roda nem com autorização |

Um agente que pudesse afrouxar a própria trava de segurança aprendendo não é
auto-evolutivo: é um problema esperando acontecer.

---

## 4. Como saber que funcionou

| | prova |
|---|---|
| entrevista | instalação limpa faz as perguntas e gera o perfil |
| perfil do dono | editado à mão, nunca é sobrescrito |
| importância | memória boba e memória importante recebem notas diferentes |
| busca | a memória importante e recente ganha da antiga e irrelevante |
| reflexão | duas memórias repetidas viram uma; contradição é resolvida |
| evolução | várias observações parecidas viram um entendimento novo |
| segurança | a reflexão não consegue mexer em trava de segurança |
