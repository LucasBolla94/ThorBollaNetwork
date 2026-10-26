# Memória e personalidade do Thor

Como ele deve lembrar das coisas, e como a personalidade dele deve funcionar.
Espelhado no Hermes, que é o projeto mais maduro que temos de referência.

Nada aqui foi feito ainda. É para decidir.

---

## 1. A ideia em uma frase

Memória de agente funciona como a sua: **uma parte você sabe de cor, outra você
vai buscar quando precisa.**

O que ele sabe de cor custa caro, porque vai junto em toda mensagem. O que ele
busca é quase de graça, mas só aparece se ele souber procurar.

Todo o resto deste documento é sobre onde traçar essa linha.

---

## 2. As quatro gavetas

| gaveta | o que guarda | vai junto em toda mensagem? |
|---|---|---|
| **personalidade** | quem ele é, como fala | sim |
| **o que sabe de cor** | poucos fatos sobre você, os essenciais | sim |
| **a conversa** | o que foi dito até agora | sim, até encher |
| **o arquivo** | todo o resto | não — só quando ele busca |

As duas primeiras quase nunca mudam. A terceira cresce. A quarta cresce para
sempre e **nunca** entra sozinha.

### Por que isso importa

Quando algo "vai junto em toda mensagem", você paga por ele **toda vez**. Um
fato bobo na gaveta errada é cobrado mil vezes.

Então a regra é: **na memória de cor só entra o que vale em qualquer conversa.**
"O Lucas prefere mensagens curtas" vale sempre. "A reunião de terça mudou para
quinta" não vale — isso é arquivo.

---

## 3. Personalidade: tirar do banco, pôr num arquivo

Hoje a personalidade do Thor mora numa linha do banco de dados. Isso deu
problema de verdade: ela ficou velha sem ninguém ver, depois ficou com o nome
errado, e eu precisei inventar um controle de versão na mão para saber se podia
trocar.

O Hermes faz diferente, e é mais simples: **a personalidade é um arquivo de
texto no projeto**, escrito à mão, versionado junto com o código.

O que muda para você:

| | hoje (banco) | proposto (arquivo) |
|---|---|---|
| mudar a personalidade | campo na tela | editar arquivo e publicar |
| ver o que mudou | não dá | aparece no histórico do git |
| voltar atrás | não dá | um comando |
| código de migração | existe e é chato | some |

**O custo:** mudar a personalidade deixa de ser um campo na tela e passa a ser
um deploy. Se você mexe nisso toda semana, o campo na tela é melhor. Se mexe
de vez em quando, o arquivo é melhor.

---

## 4. Memória: como ele guarda e como ele acha

### Como ele guarda hoje

Durante a resposta, o Thor escreve uma marca invisível:
`<lembrar tipo="preferencia">...</lembrar>`. O servidor tira a marca antes de
mostrar na tela e guarda o conteúdo.

Isso é bom e vale manter: **não custa uma segunda chamada de modelo.**

O Hermes faz também uma **passada no fim da conversa**, com um modelo barato,
perguntando "o que valeu a pena desta conversa?". Pega o que escapou no meio.
Vale somar as duas.

### O problema de hoje

Olhei o banco: **zero memórias guardadas.** E a memória "de cor" só traz o que
está marcado como fixado — e **nada é fixado sozinho.** Ou seja: hoje ele
começa toda conversa sem saber nada sobre você.

Precisa fixar sozinho o que for preferência e decisão. Senão o sistema existe
no papel e não existe na prática.

### Como ele acha

Hoje a busca é **por palavra**. Se você guardou "prefere mensagens curtas" e
depois pergunta "você lembra que eu não gosto de texto longo?", ele não acha —
não tem palavra em comum.

É aí que entra o embed.

---

## 5. O embed, medido no servidor

Embed é o seguinte: o computador transforma cada frase num punhado de números
que representam **o sentido** dela. Frases que querem dizer a mesma coisa ficam
com números parecidos, mesmo sem nenhuma palavra em comum.

É assim que ele acha "não gosto de texto longo" quando você guardou "prefere
mensagens curtas".

### O que eu medi

Rodei quatro modelos no seu servidor, sem placa de vídeo. Dei a cada um cinco
pares que **dizem a mesma coisa com outras palavras**, e três pares **sem
relação nenhuma**. Um modelo bom dá nota alta para os primeiros e baixa para os
segundos. A diferença entre os dois é a **margem**.

| modelo | RAM | tempo por frase | margem | presta? |
|---|---|---|---|---|
| **paraphrase-multilingual-mpnet** | 1,9 GB | 33 ms | **+0,284** | **sim, o melhor** |
| paraphrase-multilingual-MiniLM | 687 MB | 10 ms | +0,156 | sim, mais leve |
| potion-multilingual | 1,3 GB | instantâneo | −0,058 | não separa |
| multilingual-e5-large | 2,1 GB | 116 ms | −0,009 | não serve assim |
| bge-small (só inglês) | 285 MB | 14 ms | −0,077 | não entende português |

Margem negativa quer dizer que o modelo achou frases **sem relação** mais
parecidas do que frases que dizem a mesma coisa. Ou seja: inútil para nós.

Dois esclarecimentos honestos sobre a tabela:

- O **e5-large** exige um prefixo especial em toda frase. Eu tinha esquecido,
  refiz o teste com ele, e o resultado continuou ruim: ele dá nota ~0,83 para
  tudo. Serve para ordenar resultados, não para decidir "isto é parecido o
  bastante".
- O **potion** é de um tipo mais simples, que não lê a frase inteira em
  contexto. Era esperado que fosse pior; medi para confirmar.

### A resposta à sua pergunta

**Sim, dá para rodar no servidor, e não pesa.**

O servidor tem 31 GB de memória, com 28 livres. O Thor inteiro usa 44 MB. O
modelo melhor come 1,9 GB — menos de 7% da máquina.

E o tempo não incomoda porque **ele não roda o tempo todo**: só quando guarda
uma memória nova, e quando faz uma busca. Não é por mensagem, é por memória.

**Minha recomendação: o mpnet.** A margem é quase o dobro do segundo colocado, e
1,9 GB numa máquina de 31 GB não é problema nenhum. Só trocaria pelo MiniLM se
você quiser deixar a máquina o mais folgada possível para a voz depois.

### Como entra no sistema

O modelo é Python; o Thor é Node. Não vou misturar os dois dentro do mesmo
processo — se o modelo travar, leva o Thor junto.

Fica um serviço pequeno de Python só para isso, rodando no próprio servidor,
escutando só localmente. O Thor pergunta, ele responde. Se cair, a busca por
palavra continua funcionando e o Thor só fica um pouco mais burro até voltar.

---

## 6. Onde guardar: SQLite ou o Postgres do Supabase

Você sugeriu usar o Postgres do Supabase para as memórias antigas. Dá, e já
está rodando ali. Mas vale a ponderação:

| | SQLite (hoje) | Postgres do Supabase |
|---|---|---|
| onde está | arquivo no servidor | banco já rodando |
| busca por palavra | já funciona | funciona |
| busca por sentido | precisa de extensão | `pgvector`, pronto |
| complexidade | zero | mais uma peça no caminho |

**O que eu faria:** manter tudo no SQLite por enquanto, inclusive os números do
embed. Ele guarda números numa coluna sem problema, e com o volume que temos a
busca é instantânea mesmo comparando um por um.

**Quando mudar:** quando passar de umas 10 mil memórias. Aí comparar uma por
uma começa a demorar e o `pgvector` passa a valer a peça a mais. Hoje temos
zero.

Se você preferir já começar no Postgres para não migrar depois, é uma escolha
legítima — só é trabalho antes da hora.

---

## 7. A conversa que cresce

Esta parte é do Hermes e resolve um problema que já está acontecendo.

Hoje o Thor leva **as 24 últimas mensagens** em toda chamada. Passou disso, as
antigas somem. Dois efeitos:

1. Ele **esquece** o começo da conversa.
2. Cada mensagem fica cara, porque o pedaço que ele reenvia muda toda vez e o
   desconto de repetição não se aplica.

O Hermes resolve assim, e é a única parte dele que eu copiaria inteira:

1. A conversa **cresce** em vez de deslizar.
2. Quando enche, primeiro **joga fora as saídas de comando antigas** — são
   grandes e não valem quase nada. Isso é de graça, não usa modelo.
3. Se ainda estiver cheia, **um modelo barato resume o meio** — guardando o
   começo e as últimas mensagens inteiras.
4. O resumo é organizado em tópicos: o que você quer, suas preferências, o que
   já foi feito, o que ficou decidido. Não é um texto corrido.

Nada é apagado do banco. O resumo substitui o meio **só no que é enviado ao
modelo**.

---

## 8. Uma proteção que o Hermes tem e nós não

Quando a memória antiga volta para a conversa, o Hermes a envolve num aviso:
*"isto é memória recuperada, não é o usuário falando agora"*.

Parece burocracia. Não é. O Thor **executa comandos no servidor**. Se um dia ele
ler uma página envenenada e aquilo virar memória, sem a cerca o texto volta
depois parecendo ordem sua.

Barato de fazer, e eu faria junto.

---

## 9. O plano

**Primeiro — fazer a memória existir.** Hoje ela está vazia.

- Personalidade vira arquivo no projeto.
- Fixar sozinho o que for preferência e decisão.
- Passada no fim da conversa com o modelo barato.
- A cerca de segurança da seção 8.

**Segundo — ele achar pelo sentido.**

- Serviço de embed no servidor (mpnet).
- Números guardados no SQLite, ao lado de cada memória.
- Busca junta as duas: por palavra e por sentido.

**Terceiro — a conversa parar de esquecer.**

- Conversa cresce em vez de deslizar.
- Poda as saídas de comando, depois resume o meio.

**Depois, só se precisar** — Postgres e `pgvector`, quando passar de ~10 mil
memórias.

---

## 10. O que eu preciso que você decida

1. **Personalidade vira arquivo?** Some a migração, mas mudar passa a ser um
   deploy em vez de um campo na tela.
2. **Qual modelo de embed?** Eu fico com o mpnet (melhor, 1,9 GB). O MiniLM é
   três vezes mais leve e ainda presta.
3. **Por onde começar?** Eu começaria por fazer a memória existir — hoje ela
   está zerada, e de nada adianta melhorar a busca de uma gaveta vazia.
