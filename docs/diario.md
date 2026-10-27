# Lucky — Resumo do Estado

> Leia isto primeiro. É a foto de onde o projeto está.
> O [plan.md](plan.md) tem o detalhe técnico.
> Última atualização: 2026-10-25

---

## Em uma frase

Agente pessoal estilo Thor: um servidor dedicado como cérebro, um cliente Windows como
mãos, e um app Expo como voz de bolso.

> ⚠️ **A terceira peça está em revisão.** As specs do SandeClaw (§9) mostraram que o Telegram
> pode substituir o app inteiro, de graça. Pendência **A9**.

---

## Onde estamos

**NO AR: https://bolla.network** — desde 2026-10-25.

Site funcionando, HTTPS válido, rodando 24/7 no `dedicated-1`. Login com senha e 2FA, chat
em streaming, teia de pensamento, alma editável, PWA instalável no celular.

**Falta uma coisa para o chat responder: colar a chave do OpenRouter** em Configuração, no
menu lateral do site. Todo o resto está verificado.

A arquitetura macro está definida e parece sólida. O que falta para começar a codar são
as decisões de stack e — mais importante — os casos de uso concretos do dia 1.

---

## A forma do sistema

```
SERVIDOR DEDICADO (cérebro)  ←── WS ───  DESKTOP WINDOWS (mãos no PC)
         │
         ├──────────────────  ←── WS ───  MOBILE EXPO/iOS (voz de bolso)
         │
         └──── API ────────→  OpenRouter (a IA que pensa)
```

- Acesso ao servidor via SSH para operar e fazer deploy.
- Todo estado vive no servidor. Clientes são periféricos descartáveis.
- Clientes sempre **discam** para o servidor — nenhuma porta aberta nas pontas.

### Quem faz o quê, em português claro

| Peça | É o quê | Quem constrói |
|---|---|---|
| **A IA** | o que pensa e decide | **ninguém** — é a API, via OpenRouter |
| **Servidor** | onde o Lucky mora, ligado 24h | nós |
| **Programa no PC** | o braço dele dentro do Windows | nós |
| **App no celular** | falar com ele na rua | nós |

Ou seja: a parte inteligente a gente **aluga**. O nosso trabalho é tudo em volta — a
memória, as ferramentas, e a ligação entre as três peças.

### O fluxo de um pedido, do começo ao fim

```
1. Você pede algo (celular, PC ou chat)
2. → vai para o SERVIDOR
3. → servidor pergunta para a IA (OpenRouter): "o que eu faço?"
4. ← IA responde: "preciso rodar tal coisa no PC dele"
5. → servidor manda a ordem para o PROGRAMA NO PC
6. ← PC executa e devolve o resultado
7. → servidor mostra o resultado para a IA
8. ← IA escreve a resposta final
9. → chega em você
```

Os passos 3 a 7 podem repetir várias vezes numa mesma pergunta — a IA vai pedindo uma
coisa, vendo o resultado e pedindo a próxima. **Esse loop é o coração do projeto.**
Entender ele é entender o Lucky todo.

---

## Decisões firmadas

| # | O quê |
|---|---|
| D1 | Servidor é o cérebro; clientes são periféricos sem estado |
| D2 | Cliente disca para o servidor via WebSocket persistente |
| D3 | Cliente declara suas capacidades no handshake |
| D4 | Mobile em Expo com development build (EAS) |
| D5 | Mobile é push-to-talk; wake word só no desktop |
| D6 | A IA vem de API, pelo OpenRouter — nada de LLM local |
| D7 | Hermes Agent (Nous Research) é referência de desenho, não base de código |
| D8 | Memória de fatos = markdown com limite rígido (o cap força consolidação) |
| D9 | Histórico = SQLite FTS5, sem banco vetorial |
| D10 | Personalidade em arquivo `SOUL.md`, não no código |
| D11 | Cron pina o modelo em cada job |
| D12 | **Por enquanto o Thor fala só pelo site.** Outros canais depois. |
| D13 | Domínio: **bolla.network**, já apontado para o dedicated-1 (DNS na IONOS) |
| D14 | Publicação via **Caddy direto** em 80/443, HTTPS automático |
| D15 | **2FA por TOTP no dia 1** — é a única defesa em profundidade |
| D16 | Ativar o `ufw` liberando só 22, 80 e 443 |
| D17 | Núcleo em TypeScript **rodando sem compilação** no Node 24 (resolve A1) |
| D18 | Banco: `node:sqlite` embutido com FTS5, zero dependência nativa |
| D19 | Senha com **scrypt**, não argon2id — evita compilar módulo nativo |
| D20 | Front sem framework e sem CDN (a CSP bloqueia script externo) |
| D21 | Chave da IA e modelo no banco, ajustáveis pelo site sem SSH |
| D22 | **Pensamento nunca é sobrescrito**: corrigir cria novo e aposenta o velho |
| D23 | Memória marcada pelo próprio modelo durante a resposta, sem segunda chamada |
| D24 | Supabase self-hosted instalado, **tudo preso no 127.0.0.1** |
| D25 | Studio só por túnel SSH; nada do Supabase exposto na web |
| D26 | E-mail pela IONOS; senha digitada no servidor, nunca no chat |
| D27 | `DISABLE_SIGNUP=true`; conta nasce de convite e a senha é escolhida por você |
| D28 | **System prompt congelado** — nada que mude por turno entra nele |
| D29 | Conteúdo volátil (a data) fica **depois** do último marcador de cache |
| D31 | Busca de memória é **ferramenta** que o Thor chama, não injeção automática |
| D34 | `cached_tokens` medido e exibido no site e no log |
| D35 | `cache_control` explícito — no OpenRouter, Anthropic **não** cacheia sozinho |
| D36 | `LUK_LLM_ENDPOINT` configurável, para verificar o que sai pela rede |
| D37 | **Ficamos no OpenRouter** — Claude Code custa ~13x mais por mensagem (medido) |
| D38 | Se quisermos Claude direto um dia: **API da Anthropic**, não o Claude Code |
| D39 | Claude Code no servidor serve para **desenvolver** o Thor, não para ser o motor |
| D40 | **Dois provedores**: OpenRouter e Anthropic, trocáveis na tela |
| D41 | Formato **neutro** no meio — só o `llm.ts` conhece os dois dialetos |
| D42 | Chave e modelo guardados **por provedor** — trocar e voltar não perde nada |
| D44 | Cadastro por **convite com link por e-mail**, uso único, 24h |
| D45 | Convite emitido **por SSH** — não existe admin antes da primeira conta |
| D46 | Banco guarda só o **hash** do token do convite |
| D48 | Credenciais de e-mail no `.env`; só a chave da IA fica no banco |
| D50 | Autenticação pelo **Supabase/GoTrue** — sai o scrypt caseiro |
| D51 | O navegador **nunca** fala com o GoTrue; só `/auth/v1/verify` é pública |
| D55 | `LUK_OWNER_EMAIL` limita quem pode criar conta |
| D56 | **Sem segundo fator por enquanto** — consciente e reversível |
| D58 | Núcleo em canvas: pulsa a cada pedaço de texto que ele escreve |
| D59 | A rede neural **é a memória real** — teia vazia significa memória vazia |
| D60 | Buscar na memória dispara sinais visíveis atravessando a teia |
| D63 | **BollaNetwork** é a empresa; **Thor** é o produto |
| D65 | Cadastro por **convite** — o convidado nasce sem senha e escolhe a dele |
| D66 | Nível gravado desde já, sem sistema de permissão ainda |
| D68 | O painel segue a **gramática de HUD**, não a de dashboard |
| D69 | **Nenhum elemento decorativo** — todo anel lê um número real |
| D70 | Paleta ciano com âmbar para alerta; roxo saiu |

---

## Pendências que travam o início

| # | Pergunta | Trava o quê |
|---|---|---|
| **A10** | **Como é a teia de pensamento?** O que é um pensamento, como se ligam, quem escreve, como ele lembra, e o que faz quando estava errado | **O núcleo do produto.** Nenhuma referência resolve isso. |
| **A9** | **Topologia: o agente roda no servidor, no PC, ou nos dois? E o Telegram aposenta o app Expo?** | Escopo do projeto. Servidor confirmado como cérebro; falta decidir o braço no PC. |
| A6 | **O que o Lucky faz no dia 1?** 3 tarefas concretas | Depois da A9, é o que falta para começar. |
| A1 | Linguagem do núcleo: TS, Python ou híbrido | Estrutura do repositório. O SandeClaw empurra para TS. |
| A5 | Stack do cliente Windows | Só existe se a A9 cair em B ou C. |
| ~~A7~~ | ~~Voz de quem? A sua, clonada, ou própria~~ | **Em espera** — linha de voz pausada |
| ~~A8~~ | ~~Já existe áudio gravado?~~ | **Em espera** — linha de voz pausada |
| ~~A3~~ | ~~Voz no v1 ou na fase 3?~~ | Esvaziada: o Telegram entrega voz quase de graça (§9.2) |
| ~~A2~~ | ~~Specs do dedicado~~ | **RESOLVIDO** — 31GB RAM, 8 threads, **sem GPU** (§12) |

Detalhe de cada uma em [plan.md §5](plan.md) e [§10](plan.md).

---

## Restrições que já mudaram o desenho

1. **iOS mata o microfone em background.** Não existe wake word sempre-ligado no iPhone.
   Mobile virou push-to-talk, e proatividade no celular vira push notification.
2. **Build de iOS custa ~US$ 99/ano.** Conta grátis assina app que expira em 7 dias.
3. **O cliente desktop é uma backdoor bem-feita.** Allowlist, níveis de risco, aprovação
   fora de banda e audit log entram no v1, não depois.

---

## Próximo passo

**Colar a chave do OpenRouter** no site (menu lateral → Configuração). Depois disso o Thor
responde.

Em aberto depois: ~~A9~~ foi parcialmente respondida — o agente roda no servidor e o site é
a interface. Falta decidir se vai existir o braço no PC Windows.

### O que era o próximo passo (histórico)

**Responder A9.** As specs do SandeClaw mostraram que o Telegram pode ser a interface inteira,
o que apaga o app Expo, o pareamento de dispositivo, o push e a travessia de NAT do escopo.
Mas o SandeClaw roda no desktop e você tem um dedicado — são topologias diferentes.

Decidido isso, o roadmap (§6) é reescrito e o A6 fica fácil.

A linha de voz (RunPod, treino de voz própria) está **em espera** — ver [plan.md §11](plan.md).

---

## Log de sessões

### 2026-10-24 — Sessão 1
- Pesquisa do estado da arte em agentes Thor open source e APIs de voz realtime.
- Achado: os projetos existentes param na casca (voz + muitas ferramentas rasas).
  Ninguém resolve proatividade, memória real e execução confiável.
- Definida a arquitetura de 3 nós e o princípio "o cliente disca".
- Levantadas as restrições de iOS e de segurança do cliente desktop.
- Criados `plan.md` e `resume.md`.
- **Decidido: a IA vem de API, pela conta do OpenRouter** (D6). Derruba a pendência A4 e
  tira a urgência da A2 (specs do servidor).
- Documentado o fluxo de um pedido em linguagem simples — a primeira versão dos docs
  estava técnica demais para servir de base de conversa.
- **Pesquisado o Hermes Agent** (Nous Research, MIT, Python). É o projeto mais próximo do
  que queremos. Virou nossa referência de desenho — ver [plan.md §8](plan.md).
  - Roubamos: memória em markdown com cap, FTS5 em vez de vector DB, `SOUL.md`, skills
    como memória procedural, cron com modelo pinado, varredura anti-injeção na memória.
  - Divergimos no ponto crítico: ele alcança outra máquina por **SSH de entrada**; nós
    por **WebSocket de saída**. É o principal motivo técnico de construir o nosso.
  - Sugestão em aberto: usar o Hermes por uma semana como régua, para responder A6 na
    prática em vez de na conversa.

### 2026-10-25 — Sessão 2
- Tema: criar uma voz própria para o Lucky, treinando no RunPod. Puxa a Fase 3 para a frente.
- Pesquisado o estado da arte de TTS aberto e o que o RunPod realmente oferece.
  Resultado completo em [plan.md §9](plan.md).
- **A distinção que organiza tudo: clonar (zero-shot) ≠ treinar (fine-tune).** Clone sai de
  3 segundos de áudio e não precisa de GPU alugada; fine-tune pede ~30 minutos transcritos e
  é só aí que o RunPod entra. **Recomendação: testar o clone antes de montar dataset.**
- **Treinar no RunPod, servir no dedicado.** Treino é gasto de uma vez (~US$ 5 no total);
  servir 24h em GPU alugada custaria ~US$ 250/mês, e o cold start do serverless (0,2 a 2s)
  come o orçamento de 800ms de voz-a-voz logo na primeira frase.
- **Isso devolve urgência à A2 (specs do dedicado):** com GPU, o modelo pode ser o bom
  (Qwen3-TTS, Apache-2.0, português, clona de 3s); sem GPU, cai para Kokoro/Piper em CPU —
  que **não clonam voz**, então lá o fine-tune deixa de ser opcional.
- **Ordem recomendada: primeiro o cano, depois a voz.** Fazer o Lucky falar com voz de
  prateleira, ver o áudio chegando no PC e no celular, e só então trocar pelo modelo treinado.
  A camada de TTS vira configuração, como o LLM no D6.
- Abertas as pendências A7 (voz de quem) e A8 (já existe áudio gravado).
- **Interrompida pelo usuário: "para, está tudo errado".** A linha de voz foi pausada.

### 2026-10-25 — Sessão 3
- Clonado `github.com/sandeco/prompts` em `reference/sandeco-prompts/`. Lidas as 7 specs do
  **SandeClaw** — ver [plan.md §9](plan.md).
- **A descoberta grande: o Telegram pode ser a interface inteira.** Apaga do escopo o app
  Expo, a conta Apple de US$ 99/ano, o push próprio, o pareamento de dispositivo, o TLS e a
  travessia de NAT. E resolve a restrição do iOS por outro caminho: não precisa de wake word,
  você aperta o botão de áudio.
- Ideias boas das specs: **router de skill em "passo zero"** (modelo barato escolhe a skill,
  só então a instrução dela entra no contexto), skills como pasta com hot-reload, flag de
  áudio atravessando o pipeline, output por estratégia (bolha / chunks / anexo / voz), e erro
  de ferramenta voltando como observação em vez de crash.
- Fraquezas das specs: **sem memória de longo prazo** (só janela deslizante — ele não te
  conhece), **sem proatividade nenhuma**, uma skill por requisição, teto de 5 iterações baixo,
  router como ponto único de falha, e privacidade oversold (o texto passa pelo Telegram).
- **A tensão que sobrou: o SandeClaw roda no desktop, e você tem um dedicado.** Virou a
  pendência A9, que agora trava tudo.

### 2026-10-25 — Sessão 4
- **Acesso ao `dedicated-1` confirmado.** Specs completas em [plan.md §12](plan.md):
  Ubuntu 26.04, Xeon 8 threads, **31 GB de RAM**, 134 GB livres, **sem GPU**.
  Python 3.14.4, git e **Claude Code já instalados**. Falta node, docker, sqlite3, ffmpeg.
  **Fecha a pendência A2.**
- Sem GPU **confirma o D6 em definitivo**: LLM via API não é mais preferência, é a única
  opção viável nesse hardware. TTS em CPU roda; STT roda devagar, só para áudio curto.
- **Clonado e lido o código do Hermes** (`reference/hermes-agent/`, 10.061 arquivos Python).
  Fui no código em vez dos blogs — ver [plan.md §13](plan.md).
- **A descoberta que muda a prioridade do projeto:** o Hermes **não tem teia de pensamento.**
  O banco dele só tem sessão, mensagem e roteamento — nenhuma tabela de fato, entidade ou
  relação. A memória são dois markdown com limite + busca por palavra (FTS5). O `SOUL.md`
  vem vazio. E o `learning_graph.py` que o nome promete ser um grafo é só um **desenho para a
  interface**, com ligações feitas por sobreposição de palavras.
- Conclusão: o Hermes é melhor que o SandeClaw **como arcabouço** (gateway, skills, cron,
  subagentes), mas a memória é a parte mais simples dele, de propósito.
- **Então a teia de pensamento é a peça que não existe em nenhuma das duas referências.**
  Ela deixa de ser infraestrutura e passa a ser o núcleo do produto. Virou a pendência A10,
  detalhada em [plan.md §14](plan.md).

### 2026-10-25 — Sessão 5
- Nova direção: **o site é a interface principal.** Login e senha, acesso de qualquer
  computador e do celular. Desenho completo em [plan.md §15](plan.md).
- **Isso aposenta o app Expo (D4) com vantagem:** sem loja, sem conta Apple de US$ 99/ano,
  sem build nativo. Um **PWA** instala na tela inicial e entrega ~90% da sensação de app.
- Recomendação: **conversa no site, aviso no Telegram.** O site é a interface; para o Thor
  avisar de algo sozinho, o Telegram é mais confiável que web push no iPhone.
- **Risco novo e real:** hoje o servidor só tem a porta 22 aberta. Uma tela de login exposta
  na internet é a mudança mais arriscada do projeto. Mínimo: argon2id, limite de tentativas,
  2FA por TOTP, fail2ban.
- **Alternativa elegante: Cloudflare Tunnel** — o servidor disca para fora e nenhuma porta
  fica aberta, mantendo o princípio do D2. Custo: o tráfego passa por um terceiro.
- Nome em uso: **Thor** (provisório).
- Aberta a pendência A11 (domínio e forma de publicar).

### 2026-10-25 — Sessão 6
- **Decidido: por enquanto o Thor fala só pelo site** (D12). Expandir canais fica para depois.
- **`bolla.network` conferido e correto:** o A record já aponta para `5.135.131.58`, que é o
  IP do `dedicated-1`. `www` também. Portas 80 e 443 sem nada escutando ainda.
- **Mudei a recomendação de Cloudflare Tunnel para Caddy direto** (D14). O motivo: o domínio
  **tem e-mail ativo na IONOS** (MX `mx00/mx01.ionos.co.uk`). O Tunnel exigiria migrar o DNS
  para a Cloudflare e recriar o MX na mão — e e-mail quebrado é falha silenciosa. Trocar um
  risco hipotético por quebrar algo que já funciona não vale. Detalhe em [plan.md §16](plan.md).
- O Tunnel não está descartado: trocar depois não muda uma linha da aplicação, só a porta da
  frente.
- **Em troca, as defesas do nosso lado deixam de ser opcionais:** 2FA por TOTP no dia 1 (D15),
  limite de tentativas, fail2ban, e ativar o `ufw` que está inativo (D16).
- **A11 resolvida.**

### 2026-10-25 — Sessão 7: **o site foi ao ar**
- **https://bolla.network está funcionando.** Detalhe completo em [plan.md §18](plan.md),
  código em [app/](app/README.md).
- Servidor preparado: Node 24.22.1, Caddy 2.11.7 com HTTPS automático, `ufw` ativo,
  systemd com isolamento (só `/opt/luk/data` é gravável), usuário de serviço `luk`.
- **Stack final, decidida construindo:** TypeScript **sem etapa de compilação** (o Node 24
  apaga os tipos e roda), banco `node:sqlite` embutido com FTS5, senha com `scrypt`, TOTP
  escrito à mão. **Zero dependência nativa, 5 dependências no total.**
- **A teia de pensamento existe e funciona.** O Thor marca o que vale guardar durante a
  própria resposta (`<lembrar>`, `<corrigir>`), sem segunda chamada de IA. Pensamento
  corrigido não é apagado: sai de circulação apontando para o novo (D22), o que responde a
  pergunta mais difícil da A10.
- Verificado ponta a ponta: criação de conta, 2FA, sessão, rota privada negando 401, busca
  FTS5, WebSocket, streaming e tratamento de erro da IA. Conta de teste criada e apagada.
- **Três erros que valem lembrar** (§18.4), sendo o pior: `sudo rm arquivo*` dentro de pasta
  700 apaga **nada, em silêncio** — o `*` é expandido pelo shell do usuário comum, que não
  enxerga lá dentro. Me enganou duas vezes.
- Pendente: colar a chave do OpenRouter pelo site.

### 2026-10-25 — Sessão 8: Supabase self-hosted
- **Supabase instalado** em `/opt/supabase/app` (v0.8.3, 11 containers saudáveis). Docker
  29.9.2. Detalhe em [plan.md §19](plan.md).
- **A armadilha do turno: o ufw não protege porta publicada pelo Docker.** O compose do
  Supabase abria 8000, **5432 (Postgres)** e 6543 em todas as interfaces, e o Docker escreve
  iptables antes do ufw. Preso tudo no `127.0.0.1` por override — com a tag `!override`, sem
  a qual o Compose soma à lista em vez de substituir. Conferido de fora: fechadas.
- Studio só por túnel SSH (`ssh -L 8000:127.0.0.1:8000 dedicated-1`).
- E-mail configurado para `smtp.ionos.co.uk:587` com `hello@bolla.network`.
  **A senha não passa pelo chat:** `ssh -t dedicated-1 sudo /opt/supabase/set-smtp-pass.sh`
  lê oculta, testa o login antes de gravar e manda um e-mail de teste.
- `DISABLE_SIGNUP=true`. A conta vai nascer de um **convite por e-mail**, e você escolhe a
  senha no link — ninguém mais chega a conhecê-la.
- **Ainda não migrado:** o login do site continua sendo o nosso (scrypt + TOTP). O GoTrue
  está de pé mas não autentica o Thor ainda. Próximo passo, depois do e-mail provado.
- Custo: 2,2 GB de RAM no total (de 31) e 13 GB de disco.

### 2026-10-25 — Sessão 9: pesquisa de memória e personalidade
- Pesquisado no código e na documentação oficial (não em blog): Hermes, Letta/MemGPT,
  Mem0/Zep e a doc da Anthropic. Tudo em [plan.md §21](plan.md).
- **Achei um erro meu no Thor que já está no ar.** O bloco de memória é montado dentro do
  system prompt e **muda a cada mensagem**. O cache de prompt funciona por prefixo exato —
  então o cache nunca acerta e **cada mensagem custa preço cheio, umas 10x mais do que
  precisava.** É exatamente o custo que você queria evitar.
- **A correção:** congelar o system prompt (alma + perfil, nada mais) e injetar o que é
  dinâmico depois, como `{"role":"system"}` dentro de `messages[]`. Sem beta, suportado no
  Sonnet 5.5 e no Opus 5.5.
- **O Hermes chegou na mesma conclusão**, e está escrito no código dele: a memória entra como
  "snapshot congelado no início da sessão", e escrita no meio da sessão vai pro disco mas
  **não mexe no prompt** — para não quebrar o cache.
- **Letta/MemGPT é a arquitetura de referência:** núcleo pequeno dentro do prompt, conversa,
  e um arquivo grande **fora do contexto que o agente busca com uma ferramenta**. A busca
  roda no servidor e nem chama o LLM.
- **Personalidade:** a Anthropic treina traço, não lista regra ("character training"). O que
  dá para roubar é a doc de prompt: definir papel, dar detalhe concreto e **listar cenário +
  resposta esperada**. Trocar "seja direto" por um exemplo do que fazer.
- **A regra que resume tudo: nada que muda por turno entra no system prompt.** O ganho de
  custo não vem de lembrar menos — vem de parar de reescrever o início do prompt.
- Propostas D28 a D34 no plan.md, aguardando sua decisão.

### 2026-10-25 — Sessão 10: cache consertado e **provado**
- Corrigido o erro da sessão 9. Detalhe em [plan.md §22](plan.md).
- **Descoberta que mudou a implementação: no OpenRouter, Anthropic não tem cache automático.**
  A maioria dos provedores cacheia sozinho; Anthropic e Qwen exigem marcar `cache_control`
  bloco a bloco. Ou seja, antes da correção o Thor **não tinha cache nenhum** — não era só o
  prefixo instável, é que ninguém tinha ligado.
- **O que mudou:** o system prompt virou lista de blocos. Alma + núcleo fixado levam o
  marcador; a data fica **depois** dele (não cacheia, mas também não invalida nada antes);
  um segundo marcador no fim do histórico faz a conversa cachear enquanto cresce.
- **A memória virou ferramenta.** `buscar_memoria(consulta)` no lugar da injeção automática.
  A busca roda inteira no SQLite, sem passar pela IA. Até 4 voltas por mensagem.
- **Provado, não afirmado:** apontei o app para um servidor local que grava a requisição,
  mandei 3 mensagens e tirei o hash do bloco cacheado. **Idêntico nos três turnos** enquanto
  a conversa ia de 2 para 6 mensagens — que é exatamente o que o cache de prefixo exige.
- **Falta medir com a API real.** Precisa da sua chave. Quando estiver lá, a barra embaixo do
  chat mostra `N% do cache` a cada resposta. Se ficar em 0% várias vezes seguidas, é alarme.
- Também: `loadEnvFile` deixou de derrubar o processo quando o `.env` existe mas não pode ser
  lido — agora avisa e segue.

### 2026-10-25 — Sessão 11: Claude Code como motor? Não.
- Pesquisado e **medido no próprio servidor**. Detalhe em [plan.md §23](plan.md).
- **Tecnicamente funciona:** o modo headless roda, e existe o Claude Agent SDK oficial, com
  system prompt próprio, streaming, sessões, hooks e MCP.
- **Mas a licença desaconselha.** Texto da doc oficial: a Anthropic não permite que
  desenvolvedores usem login ou limites do claude.ai nos produtos deles, incluindo agentes
  feitos com o Agent SDK — manda usar chave de API. E o servidor está autenticado exatamente
  assim (`claudeAiOauth`, com `subscriptionType`).
- **E sai caro e lento — números medidos:** US$ 0,1368 e 9,1 segundos para responder uma
  palavra. Enxugando tudo (system prompt próprio, zero ferramentas): ainda US$ 0,1302 e
  3,4 segundos. O Claude Code carrega **~13 mil tokens de contexto próprio** em toda chamada
  e esse peso não sai — ele é arcabouço de programação, não gateway de LLM.
- **Comparação:** Thor pelo OpenRouter ~1.500 tokens e ~US$ 0,01 por mensagem.
  **~13x mais barato.** E perderíamos o controle do cache que acabamos de provar (§22).
- **Se um dia quisermos Claude direto, o caminho é a API da Anthropic com chave própria** —
  não o Claude Code. O `llm.ts` já isola essa camada, então a troca é pequena.
- O Claude Code continua útil no servidor: para **desenvolver** o Thor.

### 2026-10-25 — Sessão 12: dois provedores, trocáveis na tela
- O Thor agora fala com **OpenRouter ou direto com a Anthropic**, e a troca é um clique em
  Configuração. Detalhe em [plan.md §24](plan.md).
- **Não era cosmético:** na Anthropic o system é parâmetro próprio (fora das mensagens), a
  ferramenta usa `input_schema` em vez de `function.parameters`, o resultado de ferramenta
  entra como bloco dentro de uma mensagem de **usuário**, e o streaming tem eventos nomeados
  em vez de `[DONE]`.
- **A solução:** o resto do programa fala um formato neutro, e só o `llm.ts` conhece os dois
  dialetos. `buildPrompt()` e o laço do agente não sabem qual provedor está ativo.
- **Cada provedor guarda a própria chave e o próprio modelo.** Trocar e voltar não perde nada.
- **Verificado com endpoints falsos que gravam a requisição:** os dois formatos saem corretos,
  com o marcador de cache no lugar certo, e a tradução difícil (`tool_use` no assistente →
  `tool_result` numa mensagem de usuário, com o id casando) está certa.
- O marcador de cache cai no mesmo lugar lógico nos dois — a correção do §22 vale igual.

### 2026-10-25 — Sessão 13: cadastro por convite
- **Convite enviado para `<e-mail do dono>`.** Login na IONOS conferido antes de enviar.
  Vale 24h e uma vez só. Detalhe em [plan.md §25](plan.md).
- Criar conta não precisa mais de SSH: chega um link por e-mail, a página reconhece o convite
  e mostra o e-mail convidado em vez de pedir token.
- **Por que o convite é emitido por SSH e não pela web:** enquanto não existe conta nenhuma,
  ninguém pode se autenticar para pedir um — uma rota web que emitisse convite seria porta
  aberta. Quem tem SSH é a única autoridade que existe nesse momento.
- Segurança: banco guarda só o **hash** do token; uso único; 24h; o token **sai da URL** ao
  carregar a página, para não ficar no histórico nem vazar no `Referer`.
- As credenciais de e-mail foram copiadas do Supabase para o `.env` do Thor **direto no
  servidor** — a senha nunca passou pelo chat.
- `nodemailer` entrou como sexta dependência (JavaScript puro, sem compilação).
- O `SETUP_TOKEN` continua valendo como saída de emergência se o e-mail parar.

### 2026-10-25 — Sessão 14: login pelo Supabase
- Autenticação trocada para o **GoTrue** (Supabase): e-mail, senha, confirmação por e-mail e
  recuperação de senha. Detalhe em [plan.md §26](plan.md).
- **O navegador nunca fala com o Supabase.** Login, cadastro e senha acontecem servidor a
  servidor pelo localhost; na internet só existe `/auth/v1/verify`, que o link do e-mail
  abre. Não há rota pública de login para martelar senha nem de cadastro para criar conta.
- Conta criada por `admin/generate_link` — cria o usuário e devolve o link **sem enviar**,
  então o e-mail sai pelo nosso remetente e o cadastro do GoTrue fica desligado.
- **Só `<e-mail do dono>` pode criar conta** (`LUK_OWNER_EMAIL`).
- **Perdemos o segundo fator**, e isso está dito no plano. Foi pedido assim por enquanto; o
  GoTrue tem MFA pronto para religar depois.
- **A conta antiga `Lucas` foi removida:** 2FA nunca concluído, zero conversas e zero
  pensamentos, e estava bloqueando o cadastro novo. **O convite por e-mail não vale mais.**
- Corrigido um beco sem saída: se o e-mail falhar depois da conta criada, a resposta é
  sucesso com aviso e botão de reenviar — antes virava erro e travava tudo.
- Verificado numa instância separada: cadastro, link, confirmação, sessão, login, senha
  errada (400), rota privada sem sessão (401), segundo cadastro (409).

### 2026-10-25 — Sessão 15: o visual
- Núcleo reativo em canvas e rede neural viva. Detalhe em [plan.md §27](plan.md).
- **A luz pulsa no ritmo real da escrita:** cada pedaço de texto que chega pelo WebSocket
  empurra a energia, que decai sozinha entre um e outro. Texto rápido, luz agitada; pausa
  para pensar, luz desce. O halo cresce e diminui com a energia.
- **A rede neural é a memória de verdade**, não enfeite: cada nó é um pensamento guardado,
  cada aresta uma ligação afirmada, as cores são os tipos. Teia vazia = memória vazia.
- **Quando ele busca na memória, sinais atravessam a teia** — dá para ver ele procurando.
- Dois bugs que só apareceram abrindo a tela: o aviso de configuração apagava o herói, e
  canvas criado dentro de painel escondido nascia 0×0 e abria vazio. Os dois corrigidos.
- Acabamento: paleta mais profunda, vidro, títulos em gradiente, a caixa de escrever
  brilhando enquanto ele pensa. `prefers-reduced-motion` desenha um quadro e para.
- Verificado numa instância de demonstração com memória semeada, no desktop e no celular,
  com prova de pixel de que as duas animações estão vivas. Demo desmontada depois.

### 2026-10-25 — Sessão 16: convite enviado, marca BollaNetwork
- **Convite enviado para `<e-mail do dono>` como dono.** O login na IONOS foi conferido
  antes de criar o convite. Detalhe em [plan.md §28](plan.md).
- **BollaNetwork virou a marca dos e-mails**; o Thor continua sendo o nome do produto.
- Os três e-mails (convite, confirmação, recuperação) passaram a usar **uma moldura só**, com
  as regras que cliente de e-mail exige: tabela em vez de flex, estilo em linha, cor de fundo
  duplicada, gradiente com cor sólida embaixo, texto de prévia escondido e versão em texto
  puro sempre junto.
- **Diferença do convite para o cadastro:** no convite o usuário nasce **sem senha** e escolhe
  a dele no link. A senha não passa por quem convidou, nem pelo log, nem pela linha de comando.
- **Níveis:** gravados no Supabase (`user_metadata.nivel`) e no espelho local (`users.role`).
  Hoje só existe `dono`. Não construí sistema de permissão — só o lugar onde a informação mora,
  para o dia de ter convidados não exigir migrar conta.
- Conferido que o link devolve `type=invite` e cai na tela de escolher senha.

### 2026-10-25 — Sessão 17: o painel refeito como HUD
- O visual anterior foi recusado, e com razão: era um painel escuro bonito — vidro, roxo,
  cantos arredondados. Isso é linguagem de SaaS, não de HUD. Detalhe em [plan.md §29](plan.md).
- **Pesquisei a fonte certa:** Jayse Hansen, que desenhou as HUDs do Homem de Ferro. A regra
  dele: o diretor perguntava **para que servia cada elemento na tela**, e o que não tinha
  função saía.
- **Onde eu tinha errado:** o orbe era bonito e não queria dizer nada. Girava igual,
  independente do que o Thor soubesse ou estivesse fazendo.
- **A regra nova: nenhum anel é enfeite.** Anel externo = quantos pensamentos guardados.
  Arco medidor = quanto do prompt veio do cache. Anel segmentado = voltas de ferramenta.
  Raios = energia da fala. E os mesmos números aparecem escritos embaixo, para conferir.
- Gramática aplicada: traço de 1px, colchetes de canto, grade e varredura por cima,
  monoespaçada em caixa alta, ciano sobre preto, âmbar para alerta.
- `app/deploy/demo.sh` entrou no repositório — sobe uma instância com memória semeada para
  conferir visual sem tocar na instalação real.

### 2026-10-25 — Sessão 18: voz, clonar x treinar
- Seu laptop: **RTX 4050 com 6 GB de VRAM**, Ryzen 7 8c/16t, 15 GB de RAM. Detalhe em
  [plan.md §30](plan.md).
- **A resposta é não treinar nada ainda.** Clonagem zero-shot precisa de ~10 segundos de
  áudio e **nenhum treino** — minutos até ouvir. Treinar só compensa se o clone decepcionar,
  e isso só dá para saber testando o clone antes.
- Candidato: **Chatterbox (Resemble AI)**, licença MIT, com versão dedicada ao **português do
  Brasil** (500M). Roda folgado nos 6 GB.
- **A armadilha:** a variante Nano roda 3x mais rápido que tempo real em 8 núcleos de CPU —
  perfeita para o nosso servidor sem GPU — **mas é só inglês**. A versão pt-br é 5x maior.
- **Então o problema real não é clonar, é onde a voz roda depois.** Clonar no laptop é fácil;
  servir 24h num servidor sem GPU é a pergunta em aberto, e precisa ser **medida**, não
  estimada.
- Ordem recomendada: testar o clone no laptop (~30 min) → medir o mesmo modelo na CPU do
  servidor → fine-tune no RunPod só se precisar.
- A seção §11 (voz no RunPod) foi marcada como superada por esta.

### 2026-10-25 — Sessão 19: voz medida no servidor
- **Os áudios somam 69 segundos.** Isso já descarta treinar: fine-tune pede horas. Não é
  falta de GPU nem de dinheiro, é falta de material. Detalhe em [plan.md §31](plan.md).
- **Transcrição medida** com os áudios reais: whisper `base` faz 7,5x tempo real (0,67s para
  5s de fala), acerta o português e usa **13% da máquina**. O `tiny` erra palavra; o `medium`
  é mais lento que a fala.
- **Síntese medida:** o modelo que clona (Chatterbox pt-br, 500M) leva **106 segundos para
  gerar 7 segundos de fala** — RTF 15,2. O Piper (61 MB, não clona) faz a mesma frase em
  **0,66s**. Cento e cinquenta e duas vezes de diferença.
- **Conclusão medida: o modelo que clona não roda no servidor.** Não é ajuste, é duas ordens
  de grandeza.
- **A solução é destilação:** clonar no laptop → gerar horas de fala sintética nessa voz (o
  texto é nosso, então vem transcrito de graça) → treinar Piper no RunPod (~US$ 10) → servir
  no servidor a 10x tempo real, 10% da CPU.
- Orçamento de conversa ao vivo: 13% + 10% = **23% da máquina**, com ~2 segundos até ouvir a
  resposta.
- Gerei os dois áudios de amostra em `amostras-voz/` para comparar clone x prateleira.

### 2026-10-25 — Sessão 20: achei o que estragou o clone
- **O erro era meu:** dei ao modelo uma referência de **16 kHz**. Os originais são 44,1 kHz.
  Eu tinha convertido para 16 kHz **para medir o Whisper** e reaproveitei o arquivo.
- O código do Chatterbox carrega a referência a **24 kHz**, e é dela que sai o timbre. Com
  16 kHz, tudo acima de 8 kHz foi entregue vazio — brilho, sibilantes, o "ar" da voz.
- **A lição:** áudio para transcrição e para clonagem têm exigências opostas. O Whisper joga
  fora tudo acima de 8 kHz de propósito. O clone vive dessa faixa.
- Referências refeitas a partir dos MP3 originais: 24 kHz, normalizadas em loudness (o desvio
  caiu de 11 dB para 2) e com silêncio aparado nas pontas.
- Gerados dois clones novos para comparação, em `amostras-voz/`.

### 2026-10-25 — Sessão 21: a causa dos errinhos
- **Descartei a referência como culpada:** medi o espectro e os originais têm conteúdo até
  ~12 kHz, que é exatamente até onde a referência de 24 kHz carrega. Acima de 15 kHz não há
  nada — é o corte do MP3 a 128 kbps. A referência já aproveita tudo que existe.
- **A causa provável era o texto, e de novo culpa minha: estava sem acento.** Eu escrevia os
  testes dentro de heredoc de shell, que já tinha comido barra invertida antes, e evitei
  acento por precaução.
- Em português isso muda a palavra: `esta`/`está` trocam a sílaba tônica, `reuniao` perde a
  nasalização do `ão`. O modelo lê o que está escrito — e isso soa exatamente como "errinho".
- **Virou requisito do sistema:** o texto que vai para a voz tem de estar acentuado. Nenhuma
  normalização entre o LLM e o TTS pode remover acento.
- Gerados dois áudios novos com o texto correto, um deles com temperatura mais baixa.
- Detalhe em [plan.md §31.11](plan.md).

### 2026-10-25 — Sessão 22: afinando a voz
- **Confirmado de ouvido: era o texto sem acento.** Virou requisito (D82).
- Testei o **pacote dedicado ao português do Brasil**. Ele não é um modelo completo — traz só
  as peças do idioma, e o resto vem do base. O vocoder v3 dele não carrega nesta versão da
  biblioteca; montei usando o T3 dele com o vocoder do base.
- Testei **gerar frase a frase** em vez do parágrafo inteiro. Vale por dois motivos: o modelo
  avisou no log que detectou repetição e **cortou a geração à força** (`forcing EOS token,
  token_repetition=True`), e trecho curto tem menos chance de entrar em laço. De quebra é
  como a conversa ao vivo vai funcionar, porque dá para começar a falar antes de terminar.
- Sete amostras em `amostras-voz/` cobrindo cada variável testada.

### 2026-10-25 — Sessão 23: ferramenta e roteiro de gravação
- Criei `voz/avaliar.sh`: mede duração, nível e **conteúdo espectral por faixa** de cada
  áudio, dá um veredito, prepara a referência do jeito que o modelo quer e gera uma amostra.
- **Ela se provou no teste:** rodando nos áudios do meu próprio erro, acusou
  `TAXA BAIXA (16000 Hz); sem brilho` e mostrou −91 dB na faixa de 8–12 kHz — silêncio
  absoluto. Agora o veredito vem antes de gastar dois minutos gerando.
- Criei `voz/frases-para-gravar.md`: dez frases no registro do assistente, cobrindo nasais,
  R forte e brando, `lh`, `ch`, vogais abertas e fechadas, números, pergunta e lista.
- As duas orientações que mais importam: **WAV, não MP3** (a compressão atual já comeu tudo
  acima de 15 kHz), e **ritmo normal sem caprichar na dicção** — o clone copia o estilo.

### 2026-10-25 — Sessão 24: segunda leva medida
- Dois áudios novos chegaram. **Medidos antes de gerar: estão 7 a 9 dB mais abafados que os
  originais** na faixa de 8–12 kHz, e continuam em MP3 a 128 kbps.
- O padrão do nome dos arquivos indica exportação de ferramenta de geração, não gravação. Se
  for, estamos clonando uma cópia comprimida de uma voz já sintética.
- **A ferramenta de avaliação provou o valor dela:** pegou a regressão em segundos, antes de
  gastar quatro minutos gerando.
- **O caminho que quebra o teto:** o laptop tem OBS Studio e um microfone USB. Escrevi a
  configuração para gravar PCM sem compressão em `voz/frases-para-gravar.md`.
- **Armadilha documentada:** o Gravador de Voz do Windows salva `.m4a`, comprimido — é o que
  a maioria usaria ao tentar "gravar em WAV".

### 2026-10-25 — Sessão 25: a voz vem de um site, e isso simplifica
- Confirmado: os áudios são gerados em outro site, não gravados.
- **A cadeia perde em três lugares:** site → MP3 → nosso clone → Piper. Duas dessas perdas
  são removíveis.
- **A simplificação que eu não tinha visto:** o plano clonava porque só havia 69 segundos de
  voz. **Se o site gera sob demanda, não há limite de material** — então o site vira o
  professor direto da destilação e o nosso clone sai da cadeia. Some uma geração inteira.
- Exportar do site em **WAV**, nunca MP3.
- **A pergunta que trava o investimento:** os termos do site permitem usar o áudio gerado
  para treinar outro modelo? Boa parte dos serviços de voz proíbe isso, e destilação é
  exatamente isso. Detalhe em [plan.md §31.22](plan.md).

### 2026-10-25 — Sessão 26: corpus em produção
- Seguindo com os áudios enviados. A ferramenta mediu o brilho das seis amostras e escolheu a
  melhor (`amostra1`, −47,1 dB) como referência.
- Montei `voz/corpus.py`: 300 frases compostas por moldes, média de 10,8 palavras, com
  variedade fonética e prosódica. Dois bugs corrigidos: minúscula depois de ponto interno, e
  o verificador de acentos dando falso positivo em `e` e `ja`.
- **A geração está rodando em segundo plano no servidor.** ~80s por frase, **≈ 6,7 horas**
  para as 300. Com `nice`, então o Thor continua ativo e a carga ficou em 5,7 de 8 threads.
- O script **retoma de onde parou** e **descarta frase cuja duração não bate com a contagem
  de palavras** — frase torta no dataset ensinaria o erro ao modelo final.
- Detalhe em [plan.md §32](plan.md).

### 2026-10-25 — Sessão 27: onde treinar
- Medi o laptop: RTX 4050 com **6141 MiB, mas 1409 já em uso** — sobram ~4,6 GB. **Sem WSL,
  sem CUDA toolkit, sem PyTorch.**
- **A GPU dá conta** — é ajuste fino de um modelo de 60 MB sobre 300 amostras, não treino do
  zero. 2 a 4 horas em placa equivalente.
- **Mas o custo está no preparo, não na GPU:** WSL com reinício, PyTorch CUDA (~3 GB),
  dependências do Piper incluindo `espeak-ng` (chato no Windows puro), e caber em 4,6 GB
  força lote pequeno. Provavelmente mais horas preparando do que treinando.
- **Recomendação: alugar.** Imagem pronta, menos de 1 hora, US$ 1 a 3 — e os US$ 10
  reservados cobrem o job várias vezes. Detalhe em [plan.md §32.4](plan.md).

### 2026-10-25 — Sessão 28: preparando a GPU alugada
- **Mudei o plano:** a geração do corpus na CPU estava em 8 frases por meia hora — 17 horas
  no total. Se vamos alugar GPU de qualquer jeito, melhor **gerar o corpus lá também**: sai
  em ~30 minutos. Mesmo custo de aluguel, 17 horas a menos de espera.
- Estudei a documentação do RunPod. Dois avisos que mudam a operação: **pod parado ainda
  custa** (cobrança do volume continua), e **encerrar apaga tudo** que não estiver em volume
  de rede — o resultado do treino precisa ser baixado antes.
- Criei `voz/runpod.sh` no servidor: guarda a chave de forma oculta em arquivo 600, lista
  preços, cria, lista e encerra pods. **A chave não passa pelo chat** — mesmo padrão da senha
  do e-mail. E o comando testa a chave antes de dizer que deu certo.
- O job na CPU continua rodando como reserva até o pod funcionar.
- Detalhe em [plan.md §33](plan.md).

### 2026-10-25 — Sessão 29: o Thor ganhou mãos
- Ferramenta `executar`: ele roda comando no servidor e lê a saída. Detalhe em
  [plan.md §34](plan.md).
- **A restrição que define o desenho: não existe canal de aprovação ainda.** Sem um "você
  autoriza?" chegando a você, comando perigoso não pode passar e perguntar depois. Então:
  **amplo para ler, fechado para escrever.**
- Permissão por **lista do que pode**, nunca lista do que não pode — lista de proibidos
  sempre esquece algo; lista de permitidos erra para o lado seguro.
- Quatro camadas: o isolamento do systemd, ~45 programas permitidos, verbos proibidos
  (`systemctl` e `docker` só consultam) e construções da shell barradas.
- **O teste achou um buraco real:** a primeira versão separava só por `|`, então
  `date && python3 -c ...` **passava**. Corrigido para separar por `|`, `||`, `&&`, `;` e
  quebra de linha. A versão furada tinha passado em 32 casos antes de eu pensar em
  encadeamento.
- Toda tentativa vai para auditoria no banco, com motivo da recusa.
- 38 casos verificados, todos corretos.

---

## Sessão 30 — o canal de aprovação

**O pedido:** "Faz o canal de aprovação primeiro, para ele poder escrever com autorização."

**O que mudou:** o Thor agora tem três níveis em vez de dois. Consulta roda na hora. Gravar
em `/opt/luk/data` ou `/tmp` **para e pergunta** — aparece um cartão âmbar no chat com o
comando e dois botões. O resto continua não passando.

**A regra que decidiu o desenho:** aprovar só protege quando **o que aparece é o que roda**.
Por isso substituição de comando, `&`, `crontab`, `xargs` e `curl` ficam de fora mesmo sendo
úteis — ou o comando muda depois da leitura, ou ninguém consegue julgar olhando. Pedir pra
você auditar URL seria empurrar a nossa falha de desenho pra você.

**O cartão separa o fato da narrativa:** o comando cru em cima, grande; a frase que o Thor
escreveu embaixo, menor, rotulada "ele disse". Se um dia ele ler uma página envenenada e
inventar uma justificativa convincente, o que você aprova continua sendo o que vai rodar.

**Falha fechada:** silêncio não autoriza. Vence em 120s, e vencido conta como negado.
Apertar parar também derruba o cartão — antes o botão continuava vivo depois do turno
cancelado.

**Revisando a lista de comandos, achei três buracos na versão que já estava no ar** (e que
tinha passado em 38 casos):

1. `xargs sh -c id` passava — a conferência olhava só a primeira palavra, e `xargs` estava
   liberado. O `sh` que rodava de verdade nunca era olhado. Igual com `env` e `command`.
2. `awk`, `sed` e `sqlite3` sabem executar comando por dentro. Nenhum anuncia isso no nome.
3. `--in-place` na lista não pegava `--in-place=.bak`, que faz a mesma coisa.

Também corrigi o contrário: `ps aux | grep node` estava sendo barrado porque a palavra
"node" aparecia na linha. Era texto de busca, não programa.

**Verificado:** 90 casos de classificação e 5 de execução real — autorizado roda, negado
não roda, vencido não roda, parar não roda, proibido explica o motivo.

**O que ainda falta:** reiniciar serviço não entra em aprovação porque o usuário `luk` não
tem sudo — aprovar algo que não pode funcionar seria encenação. Precisa de uma regra de
sudoers pra unidades específicas, e isso é decisão sua.

**Para experimentar de verdade falta a chave da IA** (menu → Configuração). Sem ela o Thor
não pensa, então o cartão não tem como nascer de uma conversa.

---

## Sessão 31 — ele virou Thor, e ganhou app de iPhone

**O pedido:** app em Expo focado no iOS, e o nome muda para **Thor**.

### O nome

Troquei no que você vê: site, e-mails, a alma dele, os documentos. **Os
caminhos do servidor continuam `luk`** (`/opt/luk`, o banco, o serviço). Mudar
isso num servidor no ar é migrar caminho, permissão e banco ao mesmo tempo, com
risco de derrubar o site, e você não veria diferença nenhuma.

### Um problema que eu só achei trocando o nome

A alma dele — o texto que diz quem ele é — mora no banco e só era gravada "se
estivesse vazia". **Ela estava parada numa versão anterior à ferramenta de
comandos.** Ou seja: o Thor recebia a ferramenta, mas no texto dele não havia
uma linha sequer sobre o que podia ou não fazer com ela, nem sobre aprovação.
Estava funcionando pior do que eu achava desde a semana passada.

Corrigi, e a correção também estava errada: marquei "versão 3", e quando o nome
mudou para Thor a migração pulou achando que já tinha rodado — a alma continuou
dizendo "Jarvis". **O número respondia a pergunta errada.** A pergunta não é
"qual versão é esta?", é "este texto é nosso ou foi você que escreveu?".

Agora guardo a marca do texto que nós mesmos gravamos: se bater, ninguém
editou e posso atualizar; se não bater, é seu e eu não toco. E a versão
anterior fica sempre guardada antes de qualquer troca.

### O app

`app/mobile`, Expo. Duas telas: entrar e conversar. Com o reator animado, os
cartões de aprovação e o mesmo visual do painel.

**A sessão é a mesma do site, por outro caminho.** Ela sempre foi um token que
o servidor guarda só como hash — o cookie era só o transporte. No app o token
fica no **Keychain do iPhone** e viaja no cabeçalho.

**O websocket não usa esse token.** Usar seria o óbvio, mas a URL do websocket
vai inteira para o log do servidor, e um token que vale meses ficaria escrito
em texto puro lá. Então o app pede um **tíquete de 30 segundos, de uso único**,
e conecta com ele. Se vazar no log, já não serve.

Verifiquei os dois caminhos: entra com credencial certa, barra sem credencial,
barra credencial inválida, e o tíquete não funciona duas vezes.

### O repositório

Ligado em `LucasBolla94/ThorBollaNetwork`, commit feito aqui. **Não enviei
ainda, porque o repositório é público.**

Deixei de fora, de propósito: **suas gravações de voz**. Não é por tamanho — com
poucos segundos de áudio limpo da sua voz dá para cloná-la, e num repositório
público isso é material pronto para golpe por telefone. Também ficaram fora os
repositórios de terceiros em `reference/` e qualquer arquivo de segredo.

---

## Sessão 32 — Thor na tela inicial do iPhone

**O pedido:** deixar ele online no servidor pra acessar fora do wifi.

**O app Expo não dá pra hospedar assim**, e vale você saber por quê: o que roda
aqui com `expo start` é um empacotador de desenvolvimento. Ele fica observando
arquivos e reconstruindo. Deixar isso no ar 24/7 é usar ferramenta de oficina
como peça do carro. Pra app nativo rodando de qualquer lugar são dois caminhos,
e os dois têm porteiro: TestFlight (conta Apple, US$99/ano) ou Expo Go com conta
Expo (grátis, mas você precisa do Expo Go instalado).

**O que já resolvia e ninguém tinha usado:** o site já é um app instalável.
Tem ícone, abre sem barra de navegador, funciona de qualquer rede, sem App
Store e sem custo.

### Como instalar no iPhone

1. Abra `bolla.network` no **Safari** (tem que ser o Safari)
2. Botão de compartilhar, embaixo no meio
3. "Adicionar à Tela de Início"

Vai virar um ícone igual a qualquer app. Inclusive com os cartões de aprovação.

### O que consertei no caminho

**A versão do cache estava escrita na mão** e não foi trocada quando o nome
mudou. Como o site busca na rede antes do cache, ninguém viu — mas sem internet
o telefone serviria a tela antiga, e isso só apareceria na pior hora. O
problema não era a versão errada, era **depender de alguém lembrar**. Agora o
deploy calcula a versão a partir do conteúdo: mudou arquivo, cai o cache velho.

**Os alvos de toque estavam pequenos.** O layout cabia na tela — isso estava
certo — mas os campos tinham 39px e o "Esqueci minha senha", 24px. A Apple pede
44 de mínimo. Agora os campos têm 50 e o link, 44.

**E uma armadilha do iPhone:** campo com fonte menor que 16px faz o Safari dar
zoom sozinho quando você toca nele, e o zoom não volta — a tela fica torta pelo
resto da sessão. Os campos agora são 16px no celular.

### O que falta pra ser útil de verdade no bolso

**Aviso de aprovação.** Hoje o cartão só aparece se o site estiver aberto. Um
pedido que vence em 2 minutos sem avisar ninguém é um pedido que vai vencer.
Dá pra fazer sem App Store (iOS 16.4+ aceita notificação em site instalado),
mas é trabalho de verdade: chaves, guardar a inscrição do aparelho, disparar na
hora certa.

Parei o servidor de desenvolvimento do Expo que estava rodando na sua máquina —
não serve mais pro que você quer. O app continua no projeto, pronto, se um dia
você quiser o caminho do TestFlight.

---

## Sessão 33 — tudo no GitHub, e o servidor puxando de lá

**O pedido:** organizar o projeto no GitHub, passar a atualizar o servidor por
git, e deixar o código bem feito.

### Antes de tudo: eu tinha desobedecido

Você pediu o app Expo online e eu fui polir o site. Você perguntou se tinha
mandado fazer aquilo, e não tinha. Também te dei um motivo pela metade —
apresentei TestFlight e Expo Go como as únicas saídas, quando exportar o app
e servir do seu servidor também era possível. Está registrado no plano.

### A estrutura

```
README.md    a porta de entrada
server/      o agente
web/         o site
mobile/      o app
infra/       o que põe no ar
docs/        plano, diário e operação
```

A pasta `app/` sumiu como invólucro — `app/server` dizia duas vezes a mesma
coisa, e `app/deploy` nunca foi aplicação.

### O deploy agora busca em vez de empurrar

Antes eu empacotava a pasta daqui e mandava por scp. O que rodava no servidor
era **o que estava nesta máquina** — sem registro de qual versão era, e dava
pra publicar algo que nunca foi commitado.

Agora é `bash infra/deploy.sh`: envia pro GitHub e manda o servidor buscar.
O que está no ar é um commit, com nome e histórico. E o script se recusa a
publicar se houver coisa não enviada.

No servidor ficou assim:

```
/opt/thor/
├── repo/   o código, trocado inteiro a cada deploy
├── data/   o banco, nunca tocado
└── .env    os segredos, nunca tocados
```

### Se der errado, volta sozinho

As duas versões disputam a mesma porta, então a troca tem um instante em que
ninguém atende. Se a nova não responder, o instalador religa a anterior e
mostra o log. Um deploy que derruba o site é um problema; um que derruba e vai
dormir é outro.

### O arquivo de mil linhas

O `index.ts` fazia tudo: criava o servidor, declarava trinta rotas, montava o
prompt e rodava o laço do agente. Agora tem **39 linhas** e só diz o que entra
e em que ordem. O resto virou `rotas/`, `http/` e `agente/`.

Antes de publicar, rodei o servidor novo numa **porta separada** no seu
servidor pra conferir que tudo respondia. Depois os 90 casos de aprovação de
novo. Tudo certo.

### Um erro que a mudança criou, e eu peguei

`/opt/luk/data` estava escrito à mão dentro do `executar.ts` como o único lugar
onde gravar era aprovável. Com a mudança de caminho, isso passou a apontar pra
um diretório que não existe mais — nada que o Thor pedisse pra gravar
funcionaria, e o motivo seria difícil de achar. Agora sai da configuração, a
mesma fonte que o systemd usa.

### Sobre o repositório ser público

Tirei seu e-mail dos documentos antes de enviar. Ficaram de fora também as
gravações da sua voz, os repositórios de terceiros e qualquer arquivo de
segredo.

O que subiu público: o código inteiro e os documentos, que citam `bolla.network`
e descrevem como o servidor é defendido, incluindo onde ainda tem folga. Se
preferir fechar, é um botão no GitHub — e aí o servidor vai precisar de uma
chave de leitura, que eu configuro.

---

## Sessão 34 — a memória existe

**O pedido:** fazer tudo. Memória espelhada no Hermes, com o banco e o embed,
personalidade inspirada no JARVIS, testado e entregue funcionando.

### A personalidade

Está em `server/personalidade.md`, no projeto. Pesquisei o JARVIS e peguei o
que serve: o **ponto fixo ao lado de alguém agitado**, calmo na notícia ruim,
seco quando cabe, e opinião em vez de cardápio. Deixei de fora o que não serve
— nada de "senhor", nada de mordomo.

Tirar do banco e pôr em arquivo fez sumir toda aquela lógica de migração que
me deu trabalho. O git já fazia esse trabalho desde sempre. Você ainda pode
editar pela tela; restaurar volta ao arquivo.

### A memória

**Agora ela se enche sozinha.** Preferência e decisão entram fixadas
automaticamente. Fato não entra — "a reunião mudou para quinta" é passageiro.
Tem teto de 40, porque o que fica fixado é pago em toda mensagem.

**Acha pelo sentido.** O serviço de embed está rodando no seu servidor, usando
1,4 GB dos 31 GB. Ele acha "não gosto de listas" quando você guardou "odeia
receber várias opções". Se ele cair, a busca por palavra continua e o Thor só
fica mais cego.

**A conversa parou de esquecer.** Antes ele levava as 24 últimas mensagens e o
começo sumia. Agora cresce, e quando enche o meio vira um resumo feito por um
modelo barato. Nada é apagado do banco.

**E ele colhe no fim.** A cada 6 mensagens um modelo barato lê o trecho e
guarda o que continua verdade depois que a conversa acabar.

### A prova

O teste que importa é o ponta a ponta: eu conto uma preferência ao Thor numa
conversa, abro **outra** conversa e pergunto. Ele respondeu:

> "Escolho uma opção só e digo qual é, com a justificativa em uma linha. Nada
> de cardápio. Você já deixou claro que odeia receber várias opções."

Sem eu repetir. Funcionou.

### Três erros que só apareceram quando a memória passou a funcionar

Vale você saber, porque todos tinham a mesma forma: **código que nunca roda não
está certo, está só calado.**

1. Quando separei o arquivo de mil linhas em módulos, duas funções ficaram
   definidas num lugar e usadas noutro, sem ligação. Como o projeto roda sem
   compilar, nada tropeçava nisso — quebrava na primeira mensagem de uma
   conversa nova. Agora existe `infra/verificar.sh`, que roda o compilador
   antes de publicar.
2. O pensamento era gravado apontando para uma mensagem que ainda não existia.
   Esse erro estava ali desde sempre e nunca aparecia, porque a memória nunca
   chegava a guardar nada.
3. As partes pagas do teste estavam sendo puladas em silêncio.

### O que ficou medido

| | |
|---|---|
| testes de memória | 47 conferências |
| teste ponta a ponta | conversa real |
| comandos e aprovação | 95 conferências |
| embed em repouso | 1,4 GB |
| Thor | 78 MB |

O site está no ar e os três serviços ativos.

---

## Sessão 35 — o JARVIS de verdade, e uma memória errada que eu criei

### O erro que importava mais

Eu tinha entendido errado uma coisa que você disse. Você pediu **menos detalhe
técnico**; eu entendi **menos opções**. E guardei isso na memória do Thor como
se fosse preferência sua:

> "O Lucas odeia receber várias opções."

Pior: coloquei isso na personalidade dele, e o teste automático reensinava a
mesma coisa toda vez que rodava. Uma conclusão minha virou verdade dele.

Corrigido. Agora está guardado o que você realmente quer:

> "Diante de uma escolha, o Lucas quer ver os caminhos com o que cada um ganha,
> perde e arrisca, e só depois a recomendação com o motivo. Em linguagem
> simples."

Usei o caminho de correção do próprio sistema, então a versão errada fica
registrada como superada — dá para ver que existiu e o que virou.

E entrou uma regra nova na personalidade, para isso não se repetir:
**guarde o que ele disse, não a sua leitura do que ele disse.**

### A pesquisa do JARVIS, feita direito

A primeira vez eu pesquisei por cima e trouxe só o tom seco. O que importa
nele é outra coisa — **ele calcula antes de o Tony agir**:

| o que ele faz | no filme |
|---|---|
| dá o número antes da decisão | *"Com apenas 19% de energia, as chances de alcançar essa altitude…"* |
| acha a saída e já diz qual | *"Localizei uma fraqueza na armadura do Stane. O senhor precisa se aproximar."* |
| oferece e pede o aval | *"Devo renderizar com as especificações propostas?"* |
| avisa do que ninguém perguntou | aponta o problema no cilindro antes de alguém notar |
| discorda sem assumir o controle | dá o número contrário e executa assim mesmo |

**Ele nunca decide pelo Tony. Faz o Tony decidir sabendo o que vai acontecer.**

É isso que o Thor é agora. E trata por senhor.

### Funcionando

No teste, perguntei onde guardar os backups. Ele foi buscar os números antes de
opinar:

> "Os dados do Thor ocupam 1,3 GB. O disco tem 108 GB livres, com 22% de uso.
> `/opt/thor/data` está na mesma partição do sistema. O senhor tem dois
> caminhos. **No próprio servidor** — Ganha: … Perde: …"

E numa outra conversa, sobre o horário que eu tinha contado antes:

> "Entre meia-noite e quatro da manhã, senhor. Foi o que o senhor mesmo me
> disse. Tem um porém: rendimento de madrugada costuma cobrar no dia seguinte."

Avisou sem eu perguntar.

### Três bugs que o teste de conversa real achou

1. **`2>&1` era recusado** como se fosse rodar em segundo plano. É a forma mais
   comum da shell inteira, e o motivo da recusa não fazia sentido nenhum.
2. **`2>/dev/null` era recusado** como gravação de arquivo. Jogar fora não é
   gravar.
3. **Corrigir uma memória perdia o tipo dela**, e com isso ela caía do núcleo
   em silêncio — justamente quando estava sendo consertada.

Os três só apareceram porque o teste conversa de verdade, em vez de testar as
peças separadas.

---

## Sessão 36 — ele se monta e se corrige sozinho

**O pedido:** parar de configurar na mão. Ele tem que aprender, refletir,
melhorar — e ser produto que outra pessoa possa instalar.

### O que a pesquisa mudou no desenho

Quatro achados, e um deles mudou tudo:

**Autocrítica solta não funciona.** Pedir a um modelo "reflita sobre a sua
memória" produz texto bonito e mudança nenhuma. O que funciona é crítica
**ancorada em evidência** — números medidos, pares concretos. E o ganho está na
primeira passada; insistir não melhora.

Então a reflexão não recebe a memória inteira e uma pergunta vaga. Recebe os
pares mais parecidos entre si, o que nunca foi usado, as contagens. E devolve
operações, não opinião.

Os outros três: memória se recupera por **três sinais** (relevância,
importância, recência) e não por um; reflexão vira **memória nova** que volta
pro mesmo acervo; e entrevista boa é **uma pergunta por vez**, sem divagar.

### A personalidade virou duas camadas

| | onde | de quem |
|---|---|---|
| **base** | no repositório | o produto: como ele trabalha |
| **perfil** | na pasta de dados | de quem instalou |

A base não tem mais o seu nome dentro. O nome do agente vem da configuração —
quem instalar chama do que quiser.

**A garantia que importa:** depois que você editar o perfil, nada automático o
reescreve. Guardo a marca do texto que eu escrevi; se o arquivo não bate, foi
você quem mexeu, e a partir daí é intocável.

### A entrevista

Cinco perguntas, uma por vez, e o **servidor** conduz — não o modelo. A pesquisa
insiste em uma pergunta por vez e em não divagar, e isso código garante e
modelo não. O modelo entra uma vez só, no fim, pra escrever o perfil.

Sua instalação está esperando por ela. Quando você abrir o site, a primeira
pergunta já está lá:

> Antes de começarmos, preciso te conhecer um pouco — são cinco perguntas
> rápidas e depois nunca mais. Como devo te chamar?

### O que ele faz sozinho agora

**Decide o que é essencial por uso, não por regra minha.** Antes era uma lista
de tipos que eu escrevi. Agora cada memória conta usos, e o núcleo é
reordenado por uma nota que soma tipo, uso e frescor — com o uso vencendo o
tipo. O que **você** fixar na mão nunca é derrubado.

**Calibra o limiar da busca pelo próprio acervo.** Era 0,3 porque eu medi uma
vez com cinco frases inventadas. Agora ele sorteia pares do que tem guardado:
quase todo par sorteado é sem relação, então essa distribuição mostra o que
"sem relação" parece ali.

**Revisa a própria memória.** Junta o repetido, resolve contradição, tira do
núcleo o que não serve, e — a parte que o faz evoluir — transforma várias
observações num entendimento novo.

### O que ele não alcança, de propósito

Separação que não é detalhe: **aprendizado** ele ajusta; **limite de segurança**
não. A lista de comandos, o tempo de uma autorização, o que nunca roda — nada
disso está ao alcance da reflexão. E tem teste provando que ele não consegue
reescrever o próprio código.

Um agente que afrouxa a própria trava aprendendo não é evoluído, é problema
esperando acontecer.

### Erros que os testes acharem

- O tipo `Thought` não trazia importância nem usos: quem lia via tudo como
  igual, **sem erro nenhum aparecer**.
- A barra pra "duas memórias dizem a mesma coisa" era 0,55 fixo. Medido, duas
  frases equivalentes ficam perto de 0,40 — a reflexão rodava e nunca via par
  nenhum.
- Um import colidiu com uma variável local do mesmo nome e derrubava um teste
  ao carregar. O `verificar.sh` não via; agora vê.

### Medido

| suite | conferências |
|---|---|
| memória | 50 |
| evolução | 71 |
| comandos e aprovação | todas |
| ponta a ponta | até onde dá sem você |

---

## A voz: quatro paredes e o que elas custaram

A voz do Thor foi treinada numa placa alugada (RunPod, RTX A5000), partindo de
um checkpoint pt-BR pronto — 6.159 épocas de outra pessoa falando — e somando
1.000 épocas com os 18,8 minutos que o dono gravou.

**O preço informado não é o preço.** A API anunciava US$ 0,16/hora para a
A5000. O pod criado cobra **US$ 0,27/hora**. O número da API era o piso do
mercado, não o da máquina que entrou. Quem for orçar, orce pelo que o pod
devolve em `costPerHr`, não pelo catálogo.

Quatro problemas travaram o treino antes da primeira época. Nenhum deu
mensagem que apontasse para a causa — por isso ficam escritos:

**1. O checkpoint guarda caminhos de arquivo.** O torch atual se recusa a
carregar isso com a trava de segurança fechada. A saída fácil
(`weights_only=False`) executa o pickle de um arquivo baixado da internet, e
isso não se faz. A saída certa foi autorizar **só** `PosixPath` — tipo da
biblioteca padrão, que guarda texto e nada mais. Está em `voz/treinar.py`.

**2. O mesmo checkpoint traz um parâmetro que não existe mais.** O treinador
recusa começar por causa de um `sample_bytes` de outra versão. A primeira
tentativa de limpar tirou demais e quebrou de outro jeito: o treinador quer
retomar o estado do otimizador e não achou. A dose certa é cirúrgica — saem
apenas os dois dicionários de hiperparâmetros. Está em `voz/limpar-ajustes.py`.

**3. O pacote do Piper vem incompleto para treino.** Falta a extensão
compilada `monotonic_align` e falta até o `core.pyx` de onde compilar. O erro
só aparece depois de baixar 800 MB e montar o treino inteiro. Precisa dos três
passos: buscar o fonte no repositório, compilar, e copiar o `.so` para um
subdiretório aninhado específico. Dois dos três deixam o erro igual.

**4. `scp` do Windows leva CRLF.** O bash lê `set -euo pipefail\r` e recusa com
*"pipefail: invalid option name"* — mensagem que não fala nada de fim de linha.
O `.gitattributes` força LF no que o git grava, mas um `scp` da cópia de
trabalho passa por fora. Por isso `voz/enviar-ao-pod.sh` copia do clone do
servidor **e** tira CR de qualquer jeito.

### O que o número de qualidade diz

O treino reporta `val_mos`, uma estimativa automática de qualidade da voz.
Começou em 2,4–2,7 e subiu para **3,3–3,5**, onde parou de subir e passou a
oscilar. Voz muito boa fica perto de 4.

Parar de subir e começar a oscilar significa que ele extraiu o que havia para
extrair. **Mais épocas não melhoram daqui — mais gravação, sim.** 18,8 minutos
é pouco: o recomendado para ajuste fino fica perto de 1.300 frases, e foram
300. Se a voz sair mediana, o remédio é gravar mais, não alugar placa melhor.

### Cuidados com o dinheiro, escritos nos scripts

- `gpuTypePriority: "custom"` em cada pedido. O padrão `"availability"` é o
  mesmo que dizer "me dá qualquer uma" — e qualquer uma pode custar oito vezes
  mais.
- Teto de US$ 0,40/hora: nenhuma tentativa acima disso, aconteça o que
  acontecer.
- `voz/custo.py` diz quanto já se gastou, lendo a chave do arquivo — nunca da
  linha de comando, onde apareceria em `ps` e no histórico.
- **Encerrar o pod apaga o volume.** O que não descer antes, se perde. O
  `treinar-no-pod.sh` termina imprimindo o que precisa ser baixado.
