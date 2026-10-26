# Memória e personalidade — estudo e plano

Levantamento do que o Thor tem hoje, do que as specs do SandeClaw pediam, do que
o Hermes faz, e um plano em fases.

Nada aqui foi implementado. É para decidir.

---

## 1. O furo de custo que eu achei

Começo por aqui porque é o achado que muda a prioridade de tudo.

`buildPrompt` monta o histórico assim:

```sql
SELECT role, content FROM messages
 WHERE conversation_id = ?
 ORDER BY created_at DESC LIMIT 24
```

É uma **janela deslizante**: sempre as 24 últimas. E janela deslizante é
**incompatível com cache de prompt**.

O cache casa por **prefixo exato**. Numa conversa de 30 mensagens:

| turno | o histórico enviado começa em |
|---|---|
| 30 | mensagem 6 |
| 31 | mensagem 7 |
| 32 | mensagem 8 |

O começo muda a cada turno, então **o prefixo inteiro muda** e o cache erra
sempre. A partir da 25ª mensagem, toda interação paga preço cheio pelo histórico
completo.

Ordem de grandeza, com entrada a US$ 3/Mtok e leitura de cache a 10% disso:

| situação | por turno | 50 turnos/dia |
|---|---|---|
| cache acertando | ~US$ 0,004 | ~US$ 6/mês |
| hoje, passando de 24 mensagens | ~US$ 0,040 | ~US$ 60/mês |

São estimativas, não medições — mas a razão de 10× não depende da estimativa, e
sim de como o cache é cobrado.

**O conserto não é aumentar a janela. É parar de deslizar.** O histórico precisa
só **crescer**, e quando encher, ser **comprimido** — que é exatamente o que
você pediu, e exatamente o que o Hermes faz.

---

## 2. O que o Thor tem hoje

| peça | onde | o que faz |
|---|---|---|
| conversas e mensagens | SQLite + FTS5 | histórico cru, buscável |
| teia de pensamentos | `thoughts` + `thought_links` | fatos duráveis, com correção sem perda |
| núcleo | `coreBlock()` | o que está **fixado**, dentro do system prompt |
| arquivo | `recall()` | busca por palavra, roda no banco, **sem chamar LLM** |
| extração | marcas `<lembrar>` na resposta | sem segunda chamada de modelo |

O desenho está certo em dois pontos que o Hermes confirma: o núcleo é estável
entre turnos (não quebra cache) e a busca não custa tokens.

### Dois problemas

**Nunca guardou nada.** Hoje: 0 pensamentos, 0 fixados, 7 mensagens. O sistema
existe e nunca foi exercitado de verdade.

**O núcleo está sempre vazio.** `coreBlock()` só traz o que tem `pinned = 1`, e
**nada nunca é fixado automaticamente** — só pela sua mão, na tela. Então, na
prática, o Thor começa toda conversa sem memória nenhuma no prompt.

---

## 3. As specs do SandeClaw — o que seguimos

A spec de memória é bem mais simples do que o que construímos: SQLite,
`conversations` + `messages`, WAL, janela de N mensagens, repository pattern, e
**sem banco vetorial** (NG-01).

| | |
|---|---|
| ✅ SQLite, WAL, conversas/mensagens | igual |
| ✅ janela de N mensagens | `MEMORY_WINDOW = 24` |
| ✅ SQL nativo, sem ORM | igual |
| ✅ banco fora do git | `/opt/thor/data` |
| ✅ sem banco vetorial | FTS5 é busca por palavra, não vetor |
| ❌ **EC-02: tirar byte nulo da entrada** | não fazemos |
| ❌ **EC-03: limitar tamanho da mensagem** | `saveMessage` grava o que vier |
| ⚠️ **G-03: repository pattern** | 8 `db.prepare` soltos fora da camada |

Os três de baixo são dívida pequena e real. EC-02 e EC-03 são proteção contra
entrada hostil ou modelo descontrolado — baratos de fazer.

Fomos **além** da spec na teia de pensamentos e na correção sem perda. Isso não
contraria nada: NG-01 proíbe busca semântica complexa, e FTS5 não é isso.

---

## 4. O que o Hermes faz

### A regra que governa tudo

> **O cache por conversa é sagrado.** Mudar contexto passado, trocar ferramentas,
> recarregar memória ou reconstruir o system prompt no meio da conversa quebra o
> prefixo e multiplica o custo. **A única exceção é a compressão.**

E a consequência prática:

> O system prompt é **estável byte a byte** pela vida da conversa. Qualquer coisa
> que precise entrar no meio **anda numa mensagem de usuário ou num resultado de
> ferramenta** — nunca no system prompt.

Isso valida o nosso `coreBlock`, e proíbe uma ideia tentadora: injetar memória
recuperada no system prompt a cada turno.

### Como ele comprime

Três fases, nesta ordem:

1. **Poda os resultados de ferramenta antigos — sem chamar LLM.** São os maiores
   e os menos valiosos. De graça.
2. **Escolhe as fronteiras.** Protege a cabeça (system, primeira mensagem) e a
   cauda (N turnos recentes). Resume só o meio. **Nunca separa um par
   chamada/resultado de ferramenta.**
3. **Resume com um modelo auxiliar barato**, em formato estruturado:

```
## Goal                     o que a pessoa quer
## Constraints & Preferences  preferências, estilo, restrições
## Progress
### Done / In Progress / Blocked
## Key Decisions            decisões técnicas e por quê
```

Resumo estruturado em vez de texto corrido, porque compressão achatada destrói
as dimensões que o raciocínio seguinte precisa.

**Dois gatilhos:** 50% da janela para a compressão normal, 85% como rede de
segurança.

**Uma armadilha documentada:** o modelo que resume precisa de janela **pelo menos
igual** à do modelo principal. Se for menor, a chamada falha, o resumo volta
vazio, e o meio da conversa é **descartado em silêncio**. É a causa mais comum de
compactação ruim.

### Como ele cerca a memória recuperada

```
<memory-context>
[System note: isto é memória recuperada, NÃO entrada nova do usuário.]
...
</memory-context>
```

E tem um limpador que **tira essas marcas do texto que sai**, inclusive quando a
marca é partida entre dois pedaços do streaming.

Isso não é organização, é fronteira de segurança: memória recuperada é **dado**,
não instrução. Para nós importa mais do que para eles — o Thor executa comandos.

### Um detalhe de custo que vale ouro

Um trecho injetado numa mensagem é **pago em todo turno seguinte**, enquanto
aquela mensagem estiver no contexto. Por isso o Hermes **deduplica** as linhas
recuperadas antes de injetar: cada linha repetida custa uma vez por turno, para
sempre.

### Outras escolhas dele

- **Modelo auxiliar barato** para resumo, título, embedding, busca.
- **Extração de memória no fim da sessão**, não a cada turno.
- Falha de resumo arma um **tempo de espera crescente** (60s → 300s → 900s) e,
  no fim, um resumo determinístico de reserva.

---

## 5. Sobre os `.md`: o que o Hermes realmente faz

Vale corrigir uma impressão antes de construir em cima dela.

**A memória do Hermes não é em `.md`. É SQLite** — a mesma escolha nossa. São
dezenas de arquivos `hermes_state_*.py` em cima de um banco, com FTS.

Os `.md` dele são outra coisa: `SOUL.md` (personalidade), `AGENTS.md`
(instruções), as skills. São **escritos à mão**, versionados em git, e carregados
no começo da sessão. Nunca são escritos pela máquina.

A divisão é essa, e é boa:

| | escrito por | onde | por quê |
|---|---|---|---|
| **personalidade** | você | arquivo `.md` no git | revisável, diffável, versionado |
| **memória** | a máquina | banco | transação, busca, correção, volume |

Usar `.md` como *armazenamento de memória* seria um retrocesso: sem transação,
sem busca, com risco de escrita concorrente, e o arquivo cresce para dentro do
prompt.

**Mas a metade da ideia que é boa, é muito boa para nós.** Hoje a alma do Thor
mora numa linha do banco — e foi exatamente isso que gerou aquela confusão de
migração: ela ficou velha sem ninguém ver, depois ficou com o nome errado, e
precisei inventar marcação por hash para saber se podia trocar.

Se a alma for `personalidade.md` no repositório:

- some a lógica de migração inteira
- toda mudança vira um diff revisável
- o deploy por git já leva
- e continua estável byte a byte dentro da conversa

---

## 6. Sobre o Postgres do Supabase

Ele existe e está rodando (hoje só para autenticação). Com `pgvector` daria
busca semântica — achar por sentido, não por palavra.

**Minha recomendação: isso é fase 3, não fase 1.** Os motivos:

- O FTS5 que já temos faz busca por palavra a **custo zero** e sem rede no meio.
- Busca semântica exige **embeddings**: outro modelo, outra chamada, outro custo
  por memória guardada e por busca feita.
- Hoje temos **0 pensamentos**. Dimensionar recall para volume que não existe é
  resolver o problema errado.
- O que vai doer primeiro é **tamanho de conversa e custo por turno** — não
  qualidade de recall.

**O gatilho para subir isso de fase**, escrito agora para não ser decidido no
impulso depois: quando você perguntar algo que o Thor sabe e o `recall` não
achar, por ser outra palavra para a mesma coisa, **três vezes**. Aí a busca por
palavra provou que não basta, e o `pgvector` passa a valer o custo.

---

## 7. O desenho proposto

Quatro camadas, da mais quente para a mais fria:

```
1. ALMA           personalidade.md, no git        estável, cacheada
2. NÚCLEO         fatos fixados, poucos           estável, cacheada
3. CONVERSA       cresce; comprime ao encher      cacheada até comprimir
4. ARQUIVO        tudo o mais, por ferramenta     fora do prompt
```

**A regra que une as quatro:** 1 e 2 nunca mudam no meio da conversa. 3 só muda
na compressão. 4 nunca entra sozinho — só quando o Thor busca, e entra como
resultado de ferramenta, cercado e marcado como dado.

---

## 8. O plano, em fases

### Fase 1 — parar de queimar dinheiro

O conserto do item 1. É o que tem retorno imediato.

- Trocar a janela deslizante por **histórico que cresce**.
- Comprimir quando passar de um limite (começar em 50% da janela do modelo).
- Ordem da compressão: **podar resultado de ferramenta antigo** (de graça) →
  escolher fronteiras protegendo cabeça e cauda → resumir o meio.
- Resumo **estruturado**, no formato de quatro seções do Hermes.
- Resumo feito por **modelo barato**, com a regra da janela respeitada.
- Guardar o resumo no banco, ligado à conversa — compressão não apaga nada.

**Como vamos saber que funcionou:** a tela já mostra a fração de cache. Hoje ela
cai a zero depois de 24 mensagens. Depois disso, tem de ficar alta e só dar um
mergulho no turno em que comprimiu.

### Fase 2 — fazer a memória existir

Hoje ela está vazia.

- **Alma vira arquivo** `personalidade.md` no repositório; apaga a migração.
- **Fixar automaticamente** o que for `preferencia` e `decisao` com confiança
  alta — o núcleo precisa se encher sozinho, ou continua vazio para sempre.
- **Cerca de memória** no padrão do Hermes, com limpeza do texto que sai.
- **Deduplicar** o que é recuperado antes de injetar.
- **Extração no fim da conversa** com o modelo barato, somando às marcas
  `<lembrar>` que já existem no meio.
- Teto no núcleo, para ele nunca crescer sem limite.

### Fase 3 — só quando o gatilho da seção 6 disparar

- Memórias antigas para o Postgres do Supabase.
- `pgvector` para busca por sentido.
- SQLite continua sendo o quente; Postgres vira o frio.

### Dívida pequena, junto da Fase 1

- EC-02: tirar byte nulo da entrada.
- EC-03: limitar o tamanho da mensagem guardada.
- G-03: tirar os 8 `db.prepare` soltos para uma camada de repositório.

---

## 9. O que eu preciso que você decida

1. **A ordem.** Eu faria Fase 1 primeiro — é dinheiro saindo agora. Mas se você
   prefere ver o Thor lembrando das coisas antes de economizar, a Fase 2 também
   se sustenta sozinha.
2. **A alma virar arquivo.** Some a migração e tudo fica no git. O custo é que
   mudar a personalidade passa a ser um deploy, não um campo na tela.
3. **O Postgres ficar para depois.** Se você quiser na Fase 1, eu faço — mas
   acho que é resolver um problema que ainda não temos.
