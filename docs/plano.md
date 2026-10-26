# Lucky — Plano de Projeto

> Documento vivo. Atualizado conforme as decisões vão sendo tomadas.
> Última atualização: 2026-10-26

---

## 1. Visão

Um agente pessoal estilo "Thor": **um cérebro único, sempre ligado**, que me conhece,
age no meu mundo digital e toma iniciativa — acessível de qualquer lugar.

O que diferencia isso de um chatbot comum:

| | Chatbot | Lucky |
|---|---|---|
| Iniciativa | só responde | **fala primeiro** quando algo importa |
| Memória | contexto da conversa | **persistente**, me conhece ao longo de meses |
| Ação | gera texto | **executa** no servidor, no meu PC, no meu celular |
| Presença | aba do navegador | sempre ligado, em todos os meus dispositivos |

---

## 2. Arquitetura

Três nós, um cérebro.

```
                      ┌──────────────────────────────┐
                      │    SERVIDOR DEDICADO         │
                      │    (o cérebro)               │
                      │                              │
                      │  • Agent loop (LLM)          │
                      │  • Memória persistente       │
                      │  • Scheduler / event bus     │
                      │  • Hub de ferramentas (MCP)  │
                      │  • API: HTTP + WebSocket     │
                      │  • Pareamento de dispositivos│
                      └────────┬────────────┬────────┘
                               │            │
                 ┌─────────────┘            └──────────────┐
                 │  WebSocket persistente                  │
                 │  (o cliente disca; o servidor nunca)    │
      ┌──────────▼───────────┐              ┌──────────────▼─────────┐
      │  DESKTOP (Windows)   │              │   MOBILE (Expo / iOS)  │
      │  as mãos no meu PC   │              │   olhos, voz e bolso   │
      │                      │              │                        │
      │ • rodar comandos     │              │ • push-to-talk         │
      │ • ler/escrever arqs  │              │ • notificações push    │
      │ • screenshot + OCR   │              │ • localização          │
      │ • controlar apps     │              │ • aprovar ações        │
      │ • clipboard          │              │ • câmera / fotos       │
      │ • notificações       │              │                        │
      └──────────────────────┘              └────────────────────────┘
```

### 2.1 Princípio central: o cliente disca, o servidor nunca

O desktop e o mobile **abrem** a conexão com o servidor e a mantêm viva.
O servidor nunca inicia conexão com eles.

Por que isso não é detalhe:

- Nenhuma porta aberta no meu PC pessoal. Nada de port-forward no roteador, nada de
  firewall exposto. Funciona atrás de qualquer NAT — café, 4G, rede corporativa.
- O celular troca de rede toda hora. Conexão de saída é a única que sobrevive a isso.
- A superfície de ataque do PC pessoal cai para perto de zero: para executar algo lá,
  é preciso comprometer o servidor **e** passar pela autorização do dispositivo.

### 2.2 O servidor como hub de ferramentas

Cada cliente, ao conectar, **se registra e declara o que sabe fazer**. O servidor monta
um namespace unificado de ferramentas que o LLM vê como se fossem locais:

```
desktop.run_command      desktop.read_file       desktop.screenshot
desktop.open_app         desktop.clipboard_get   desktop.notify
mobile.get_location      mobile.notify           mobile.take_photo
mobile.ask_approval      mobile.speak
server.search_web        server.remember         server.schedule
```

Quando o agente chama `desktop.screenshot`, o servidor roteia para a sessão WebSocket
daquele dispositivo, espera a resposta e devolve ao loop do LLM. Para o LLM é uma tool
call normal.

Ganho: **dispositivo novo = capacidade nova, sem tocar no cérebro.** Um futuro cliente
Linux, um Raspberry Pi na sala, um segundo PC — todos entram pelo mesmo protocolo.

### 2.3 As três camadas de memória

Memória não vem de graça em nenhum SDK de agente. Precisa ser construída — e são três
coisas diferentes que costumam ser confundidas:

1. **Contexto** — a conversa atual. Resolvido por compaction do SDK.
2. **Fatos sobre mim** — estruturados, pequenos, sempre carregados. Quem eu sou, como
   trabalho, minhas preferências. Poucos KB, injetados em todo turno.
3. **Histórico recuperável** — tudo que já foi conversado e feito, em busca semântica.
   Grande, consultado sob demanda via ferramenta (`server.recall`).

Erro clássico: jogar tudo na camada 2 e estourar o contexto. Ou jogar tudo na 3 e o
agente nunca lembrar de nada espontaneamente.

### 2.4 Proatividade (o que faz ser Thor)

Um agente que só responde a request é Alexa. Para ele falar primeiro, precisa de um
**loop próprio**, independente do usuário:

- **Scheduler** — tarefas por cron ("me lembre", "todo dia às 8h cheque X").
- **Event bus** — gatilhos externos (webhook, e-mail chegou, build quebrou, deploy caiu).
- **Watchers** — o agente decide monitorar algo e acorda quando muda.

Isso precisa estar na arquitetura desde o dia 1: é a diferença entre request-response e
um processo vivo. Retrofittar depois significa reescrever o servidor.

---

## 3. Restrições reais já identificadas

Coisas que vão doer, e é melhor saber agora.

### 3.1 iOS não permite wake word sempre-ligado

Fato de plataforma, não limitação nossa: o iOS corta o acesso ao microfone em background.
**Não existe "Hey Lucky" sempre escutando no iPhone** sem ser a Siri.

Consequência de design:

- **Mobile = push-to-talk.** Abre o app (ou widget / Action Button), fala, solta.
- **Wake word sempre-ligado só no desktop**, que é um PC ligado e sem essas restrições.
- O caminho do Thor-fala-primeiro no celular é **push notification**, não áudio.

### 3.2 Expo: build de iOS tem pedágio

- **Expo Go não serve.** Áudio nativo, background, push — tudo exige *development build*
  via EAS Build.
- **Instalar no meu iPhone:** conta Apple Developer paga (~US$ 99/ano) para provisionamento
  normal. A conta grátis assina apps que **expiram em 7 dias** — inviável para uso diário.
- Boa notícia: o `.ipa` pode ser instalado direto (ad-hoc / TestFlight). Não precisa passar
  por review da App Store.

### 3.3 O cliente desktop é a parte perigosa

Um daemon no meu PC que executa comandos vindos da internet é, por definição, uma backdoor
bem-feita. Se o servidor for comprometido, o atacante tem meu PC.

Mitigações que **precisam** estar no v1, não depois:

- **Allowlist de capacidades**, não denylist. O cliente recusa o que não está na lista.
- **Nível de risco por ferramenta**: leitura livre → escrita confirma → shell arbitrário
  exige aprovação explícita.
- **Aprovação fora de banda**: ação perigosa dispara push no celular; sem o "sim", não roda.
- **Audit log local e append-only** no próprio PC — todo comando recebido, com origem e timestamp.
- **Token por dispositivo**, revogável individualmente.
- **Kill switch**: um atalho que mata o daemon na hora.

---

## 4. Decisões já tomadas

| # | Decisão | Racional |
|---|---|---|
| D1 | Servidor dedicado é o cérebro; clientes são periféricos | Um só lugar com estado. Clientes podem cair ou sumir sem perder nada. |
| D2 | Cliente sempre disca para o servidor via WS persistente | Zero portas abertas, atravessa NAT, sobrevive a troca de rede. |
| D3 | Capacidades declaradas pelo cliente no handshake | Dispositivo novo não exige mudança no servidor. |
| D4 | Mobile em Expo, com development build via EAS | Um código para iOS e Android. |
| D5 | Mobile é push-to-talk; wake word só no desktop | Restrição do iOS (§3.1), não escolha. |
| D6 | O "cérebro pensante" é LLM via API, pela conta do OpenRouter | Já tenho conta. Uma chave serve vários modelos; troco de modelo sem mexer no código. Nada de LLM local. |
| D7 | Hermes Agent é referência de **desenho**, não base de código | MIT e bem documentado, mas o acesso dele ao PC é SSH de entrada — o oposto do nosso D2 (§8.3). |
| D8 | Memória nível 2 = arquivos markdown com limite rígido | Copiado do Hermes: o cap força consolidação em vez de deixar virar lixão (§8.2). |
| D9 | Memória nível 3 = SQLite FTS5, sem banco vetorial | Full-text basta para histórico de uma pessoa. Corta uma dependência inteira. |
| D10 | Personalidade em arquivo (`SOUL.md`), não no código | Mudar o jeito dele sem mexer em código. Barato, muda muito a sensação de uso. |
| D11 | Cron pina o modelo em cada job | Lição da limitação do Hermes: sem pinar, trocar o modelo padrão muda todos os agendamentos em silêncio. |

---

## 5. Decisões abertas

Em ordem de impacto. Cada uma dessas muda código de verdade.

### A1 — Linguagem do servidor e do protocolo

- **TypeScript (monorepo)** — tipos do protocolo compartilhados entre servidor, desktop e
  mobile. Mata uma classe inteira de bugs de integração. Expo já é TS.
- **Python** — ecossistema de voz/ML muito mais rico (faster-whisper, Silero, Piper rodam
  nativo).
- **Híbrido** — núcleo em TS, sidecar Python só para áudio.

*Inclinação atual:* TS no núcleo. A complexidade real do projeto é o protocolo entre 3 nós,
não o ML — e áudio pode começar via API.

### A2 — Specs do dedicado

Perdeu urgência com D6: sem LLM local, o servidor só precisa aguentar o nosso software
(Node/Python + banco), o que qualquer dedicado moderno faz folgado.

Ainda importa na fase de voz: com GPU, Whisper e TTS podem rodar locais e de graça; sem
GPU, viram API paga.

→ *Bom saber em algum momento: CPU, RAM, GPU, OS.* Não trava mais o início.

### A3 — Voz no v1 ou depois?

Voz triplica o esforço: wake word, VAD, STT, TTS, barge-in, e um orçamento de latência de
~800ms voz-a-voz onde o vilão é a detecção de fim de turno (~300ms). Dá para provar a
arquitetura em texto e colar voz na fase 3 — ou a voz **é** o ponto e vem junto.

### ~~A4 — Local vs. nuvem para o LLM~~ → RESOLVIDO (D6)

LLM via API, pelo OpenRouter. Três consequências práticas disso:

1. **Uma chave, muitos modelos.** Dá para trocar Claude por GPT por Gemini mudando uma
   linha de config. Vale desenhar o código para que o modelo seja configuração, não
   hardcode.
2. **Cuidado com modelo barato no cérebro principal.** O Lucky depende de *tool calling*
   — a IA pedir "execute isso no PC dele". Modelos baratos erram muito nisso: inventam
   ferramenta que não existe, mandam parâmetro errado, esquecem de chamar. O cérebro
   principal precisa de modelo bom; modelo barato só para tarefas secundárias
   (resumir, classificar).
3. **OpenRouter é texto (e imagem). Não tem voz.** Quando a fase de voz chegar, STT e TTS
   vêm de provedor separado. Não é problema, só não vem incluso.

Também vale desenhar pensando em **prompt caching**: um agente reenvia o mesmo system
prompt grande a cada turno, e sem cache a conta multiplica. Precisa ser verificado por
modelo/provedor antes de fechar o custo.

### A5 — Desktop client: qual stack?

Precisa de bandeja, autostart, captura de tela e controle de apps no Windows.
Candidatos: Electron ou Tauri (UI + TS compartilhado), Python + pywinauto (automação Windows
forte), serviço .NET (mais nativo, menos portável).

### A6 — O que o Lucky faz no dia 1?

A pergunta mais importante do documento. Arquitetura boa com casos de uso vagos vira projeto
abandonado. Preciso de **3 tarefas concretas** que eu faria na primeira semana.

---

## 6. Roadmap proposto

Cada fase termina em algo que funciona de verdade, não em "camada pronta".

### Fase 0 — Esqueleto que respira

Servidor sobe, cliente desktop conecta, pareamento funciona, agente responde texto e consegue
chamar **uma** ferramenta no meu PC (ex.: `desktop.run_command` com allowlist).

→ *Prova:* digito no servidor, algo acontece no meu PC, vejo no audit log.

### Fase 1 — Cérebro de verdade

Memória nas 3 camadas, histórico recuperável, conjunto real de ferramentas no desktop, audit
log, fluxo de aprovação.

→ *Prova:* ele lembra de algo que eu disse semana passada, sem eu repetir.

### Fase 2 — Mobile

App Expo, dev build no iPhone, push notifications, push-to-talk, tela de aprovação.

→ *Prova:* peço algo do celular, roda no meu PC, recebo o resultado.

### Fase 3 — Voz

Wake word no desktop, STT, TTS, barge-in, orçamento de latência.

→ *Prova:* conversa falada fluida, sem eu pensar na latência.

### Fase 4 — Proatividade

Scheduler, event bus, watchers. Ele começa a falar primeiro.

→ *Prova:* ele me avisa de algo que eu não pedi, e eu fico grato em vez de irritado.

---

## 7. Pilha candidata (referência da pesquisa)

Levantado de projetos open source maduros — todos convergem para a mesma pilha de voz:

- **Wake word:** openWakeWord (MIT, custom wake word, grátis) ou Porcupine (precisa de key)
- **VAD / fim de turno:** Silero VAD
- **STT:** faster-whisper (local) ou Deepgram / AssemblyAI (nuvem, streaming)
- **TTS:** Piper ou Kokoro (local) · Cartesia (~40ms TTFB) ou ElevenLabs (nuvem)
- **LLM:** Claude via API · Ollama para local
- **Ferramentas:** MCP como padrão de plugin

Projetos para roubar ideias (não para usar como base):

- `bigsk1/thor-voice` — 100+ ferramentas, orquestração determinística, roda local
- `fedcal/open-thor` — MIT, Docker Compose, multi-dispositivo
- `bertrandmbanwi/Thor` — automação de browser, overlay de desktop (mac-first)

---

## 8. Hermes Agent — a nossa referência principal

`NousResearch/hermes-agent` · MIT · Python 3.14 · [docs](https://hermes-agent.nousresearch.com/docs)

É o projeto mais próximo do que queremos construir, e por sorte é MIT e bem documentado.
**Decisão: é a nossa referência de desenho, não a nossa base de código.** O que segue é o
que vale copiar e o que vale fazer diferente.

### 8.1 As peças dele

| Peça | O que é |
|---|---|
| **Gateway** | Um processo só, falando com 20+ plataformas (Telegram, Discord, Slack, WhatsApp, Signal, email) |
| **Memória** | `MEMORY.md` + `USER.md` capados, injetados no prompt + busca FTS5 nas sessões antigas |
| **SOUL.md** | A personalidade do agente em arquivo, não no código |
| **Skills** | `SKILL.md` que o próprio agente escreve depois de repetir uma tarefa |
| **Cron** | Agendamento em linguagem natural, entrega o resultado em qualquer plataforma |
| **Subagents** | `delegate_task` roda tarefa longa em contexto isolado |
| **Terminal backends** | local, Docker, SSH, Modal, Daytona, Vercel Sandbox — plugável |
| **Modelos** | Nous Portal, **OpenRouter**, OpenAI, endpoint local. Troca por comando. |

### 8.2 O que vale roubar (e por quê)

**1. Memória como arquivo markdown com limite de tamanho.**
`MEMORY.md` (o ambiente, ~2.200 caracteres) e `USER.md` (o perfil do usuário, ~1.375).
Juntos dão ~1.300 tokens, injetados no system prompt como snapshot congelado no início da
sessão. **Quando a escrita estoura o limite, a ferramenta devolve erro e o agente é obrigado
a consolidar.** Isso é elegante demais: o limite força curadoria em vez de deixar a memória
virar lixão. E resolve a camada 2 (§2.3) sem banco vetorial nenhum.

**2. SQLite FTS5 para o histórico, não banco vetorial.**
Busca full-text nas sessões passadas, com o LLM resumindo o resultado. Muito mais simples
que embeddings e, para histórico de conversa de uma pessoa só, provavelmente igual de bom.
**Isso corta uma dependência inteira do nosso projeto.**

**3. SOUL.md — personalidade em arquivo.**
Trocar o jeito dele de ser sem recompilar nada. Barato de implementar, muda muito a sensação
de uso.

**4. Skills como memória procedural.**
Depois de repetir uma tarefa de vários passos, o agente escreve um `SKILL.md` descrevendo o
procedimento — e corrige esse arquivo quando a realidade divergir. Segue o padrão aberto
agentskills.io. É "aprender" sem treinar modelo: é texto em disco, então sobrevive a troca
de provedor.

**5. Cron com modelo pinado por job.**
Lição aprendida com a limitação deles: job que não fixa o próprio modelo usa o modelo padrão
no momento da execução — então trocar o padrão muda silenciosamente todos os agendamentos.
**Vamos pinar desde o começo.**

**6. Subagente para tarefa longa.**
Contexto isolado, para tarefa comprida não entupir a janela do agente principal. Detalhe
importante: o filho **não** herda a conversa, só as credenciais e ferramentas — então o pai
tem que enunciar o objetivo completo. Delegação com objetivo vago falha.

**7. Varredura anti prompt-injection antes de gravar na memória.**
Eles filtram o que entra na memória procurando padrão de injeção e de vazamento de
credencial. Barato e evita envenenamento permanente do agente.

### 8.3 Onde a gente se afasta de propósito

**O ponto crítico: como alcançar o PC em casa.**

O Hermes resolve acesso a outra máquina com **backend SSH — ele conecta de fora para dentro.**
Isso exige que o PC aceite conexão de entrada. Para um PC doméstico atrás de NAT, com IP que
muda, isso significa port-forward no roteador, ou VPN, ou túnel — e expõe a máquina.

**Nossa inversão (D2): o PC disca para o servidor via WebSocket e mantém a conexão viva.**
Zero porta aberta, atravessa qualquer NAT, funciona em 4G e Wi-Fi de café. É exatamente o
nosso caso de uso, e é o principal motivo técnico de construir em vez de usar o deles.

**O mobile.** O Hermes não tem app próprio: ele te alcança via Telegram, WhatsApp, Signal.
Funciona, mas a experiência é de bot de chat — sem push-to-talk decente, sem tela de aprovação
de ação, sem widget. Nosso app Expo existe para isso.

**O limite de memória.** Os caps deles (~1.300 tokens) são conservadores. A ideia do cap é
certa; o número a gente calibra.

### 8.4 Limitações deles que são aviso para nós

- **Backend local é perigoso sem supervisão** — eles mesmos recomendam trocar antes de uso
  prolongado. Confirma nossa §3.3.
- **Memória pequena por desenho** — não serve para corpus grande. Para uso pessoal, serve.
- **Startup lento, modelo verborrágico, relato de escalada de privilégio** na comunidade.
- **Contagem de ferramentas inconsistente** entre docs e README — sinal de projeto crescendo
  rápido demais.

### 8.5 Sugestão prática

Vale **instalar o Hermes e usar por uma semana** — não como base, como régua. Ele roda nativo
no Windows e aceita OpenRouter, então o custo de experimentar é quase zero. Usar um agente
pessoal de verdade por sete dias vai responder a pendência A6 (o que o Lucky faz no dia 1)
melhor do que qualquer conversa nossa: você vai descobrir na prática o que usa e o que ignora.

---

## 9. SandeClaw — as specs do sandeco

Clonado em `reference/sandeco-prompts/SandeClaw/specs/` (7 arquivos: PRD, architecture,
agent-loop, memory, skill-user, telegram-input, telegram-output).

Observação honesta sobre o material: as specs são geradas por IA (autores declarados
"SandecoClaw Agent" e "Antigravity (IA)", com nota de qualidade auto-atribuída de 94/100).
São um andaime muito bom e cheio de decisões acertadas — mas não são escritura. Algumas
lacunas importantes estão listadas em §9.4.

### 9.1 O que é o SandeClaw

| Aspecto | Escolha |
|---|---|
| **Onde roda** | 100% local, no desktop Windows do usuário |
| **Interface** | **Só Telegram.** Não ter UI web é non-goal explícito (NG-01) |
| **Stack** | Node.js + TypeScript, POO com design patterns obrigatórios |
| **Telegram** | `grammy` em long polling |
| **Memória** | SQLite (`better-sqlite3`), WAL ativo, janela deslizante de N mensagens |
| **Raciocínio** | ReAct (Thought → Action → Observation), teto de 5 iterações |
| **Skills** | Pastas com `SKILL.md` em `.agents/skills`, hot-reload sem reiniciar |
| **Voz entra** | Whisper local (STT) |
| **Voz sai** | Edge-TTS (`pt-BR-ThalitaMultilingualNeural`) |
| **Documentos** | `pdf-parse` para PDF, leitura direta para `.md` |
| **Autorização** | Whitelist de Telegram user ID em `.env` |
| **LLMs** | `ProviderFactory` troca entre Gemini, DeepSeek, Groq |

### 9.2 A ideia que muda o nosso projeto: Telegram é a interface inteira

Essa é a sacada grande, e ela **apaga trabalho nosso de meses**. O Telegram entrega de
graça tudo isso:

| O que a gente ia construir | O Telegram já dá |
|---|---|
| App Expo com build EAS | app nativo pronto, iOS e Android |
| Conta Apple Developer (US$ 99/ano) | zero |
| Notificação push própria | push nativo |
| Pareamento de dispositivo + token | user ID na whitelist |
| TLS, certificado, domínio | o Telegram é o canal |
| Travessia de NAT / porta aberta | long polling disca pra fora |
| Tela de botão-de-falar | botão de áudio do Telegram |
| Upload/download de arquivo | anexo nativo |

**E resolve a restrição do iOS (§3.1) por outro caminho.** A gente tinha concluído que
wake word sempre-ligado no iPhone é impossível. Verdade — mas virou irrelevante: você não
precisa de wake word, você aperta o botão de áudio do Telegram. O caso de uso que o spec
descreve (dirigindo o carro, manda áudio, recebe áudio de volta) funciona hoje, sem app
nosso nenhum.

→ **Consequência: D4 (app Expo) entra em revisão.** Ver A9.

### 9.3 As outras ideias que valem copiar

**1. Router de skill em "passo zero" — a melhor ideia das specs.**
Antes de rodar o loop caro, uma chamada barata a um modelo pequeno recebe **só os nomes e
descrições** das skills + a intenção do usuário, e devolve `{"skillName": "x"}` ou `null`.
Só então o `SKILL.md` daquela skill (6KB de instrução detalhada) entra no contexto.

Por que é esperto: sem isso, as instruções de todas as skills vão no prompt a cada "oi" —
você queima dinheiro e o modelo perde atenção nas diretivas que importam. Com isso, o
contexto só carrega o que a tarefa daquele momento precisa.

**2. Skill é pasta com markdown, hot-reload.**
Joga a pasta em `.agents/skills`, funciona na próxima mensagem. Sem reiniciar, sem código.
Casa exatamente com o `SKILL.md` do Hermes (§8.2) — os dois projetos chegaram na mesma
conclusão por caminhos diferentes, o que é um bom sinal.

**3. A flag de áudio atravessa o pipeline.**
Input de voz marca `requires_audio_reply: true`, e o Output responde em áudio. Simples e
resolve o caso "mão no volante" sem nada sofisticado.

**4. Output por estratégia.**
Telegram corta em 4096 caracteres. Então: texto curto vira bolha; texto longo vira várias
bolhas em ordem; artefato grande vira **anexo `.md`**; erro vira aviso com emoji; áudio vira
voice note. Detalhe que eles acertaram: `for...of` com await, não `Promise.all` — senão os
pedaços chegam fora de ordem.

**5. Erro de ferramenta volta como observação, não como crash.**
JSON malformado, caminho inexistente, qualquer falha: o texto do erro volta pro modelo como
observação, pra ele corrigir sozinho. É o que separa agente de script.

### 9.4 Onde as specs são fracas (e a gente precisa decidir diferente)

**1. Não tem memória de longo prazo — só janela deslizante.**
A memória é as últimas N mensagens (`MEMORY_WINDOW_SIZE`), e busca semântica é non-goal
explícito (memory.md NG-01). Na prática: **ele não te conhece.** Lembra da conversa de
agora e esquece o resto.

Isso briga de frente com o que a gente quer de um Thor. O desenho do Hermes (§8.2) resolve
melhor e dá pouco trabalho a mais: `USER.md` + `MEMORY.md` com limite rígido para os fatos,
e FTS5 do SQLite para o histórico. O SQLite **já está lá** — FTS5 é só criar a tabela.
→ Mantemos D8 e D9.

**2. Não tem proatividade nenhuma.**
Nenhuma das 7 specs agenda nada. O SandeClaw é 100% reativo: só age quando você fala.
Se "ele fala primeiro" importa (§2.4), isso é um módulo inteiro a mais — o Hermes tem, o
SandeClaw não.

**3. Uma skill por requisição** (skill-user NG-01).
O router escolhe exatamente uma. Vai incomodar rápido: "pega o log do servidor e me manda
um resumo em áudio" já são duas.

**4. Teto de 5 iterações é baixo.**
Ler arquivo → rodar comando → ler saída → decidir já são 4. Qualquer tarefa real estoura.
Sugestão: 10 a 15, com corte por tempo e por custo em vez de só por contagem.

**5. O router é ponto único de falha.**
Eles projetam 99% de acerto, o que é otimista. Quando o router devolve `null` por engano,
a capacidade simplesmente **não existe** naquela requisição, em silêncio. Mitigação: o loop
principal também recebe a lista de skills disponíveis (eles preveem isso em RF-03) para
poder pedir a skill por conta própria.

**6. A privacidade é oversold.**
As specs afirmam privacidade total. É verdade para o áudio: o Whisper roda local, a voz não
vai para a nuvem. Mas **o texto de toda conversa passa pelos servidores do Telegram** — chat
de bot não tem ponta-a-ponta. E o prompt vai para a API do LLM de qualquer forma. É um
modelo de privacidade razoável para uso pessoal, só não é o que está escrito.

**7. Whitelist de user ID é todo o modelo de autenticação.**
Defensável para agente pessoal. Mas o **token do bot é a chave do reino**: quem tem o token
fala pelo bot. Ele precisa ser tratado como segredo de verdade, e o `.env` nunca pode ir pro
git.

### 9.5 A tensão real: o SandeClaw não tem servidor

Aqui está o conflito que precisa de decisão sua, não minha.

O SandeClaw roda **no desktop**. Você tem um **dedicado** e queria que ele fosse o cérebro.
São topologias diferentes, e cada uma perde algo:

| | Onde roda o agente | Alcança o PC? | Proatividade / cron | Dedicado |
|---|---|---|---|---|
| **A** | só no servidor | ❌ não | ✅ sempre ligado | ✅ usado |
| **B** | só no PC (SandeClaw puro) | ✅ sim | ⚠️ só se o PC estiver ligado | ❌ sem uso |
| **C** | servidor + cliente magro no PC | ✅ sim | ✅ sempre ligado | ✅ usado |

**A inclinação é C**, porque é um delta pequeno sobre o SandeClaw: todo o desenho dele
(Telegram, skills, router, ReAct, SQLite) vai para o servidor, e a única peça que ele não
tem a gente constrói — o cliente magro no Windows que disca para o servidor (D2).

A diferença em relação ao nosso plano original é enorme: antes o cliente WS era **uma de
três** coisas grandes a construir (servidor + cliente + app). Agora é **a única**.

---

## 10. A decisão que trava tudo agora

### A9 — Topologia: onde o agente roda, e o Telegram substitui o app?

Duas perguntas que na prática são uma:

1. O agente roda no servidor, no PC, ou no servidor com um braço no PC? (A, B ou C acima)
2. O Telegram vira a interface, aposentando o app Expo (D4)?

Se a resposta for **C + Telegram**, o escopo do projeto cai drasticamente e o roadmap (§6)
precisa ser reescrito: a fase 2 (mobile) desaparece e a fase 3 (voz) fica quase de graça,
porque o Telegram já entrega o botão de áudio e o Whisper/Edge-TTS resolvem o resto.

---

## 11. A voz do Lucky — criar e treinar no RunPod

> Entrou na conversa em 2026-10-25. É a Fase 3 do roadmap (§6) sendo puxada para frente.
>
> **STATUS: SUPERADA pela §30.** Esta secao foi escrita antes de eu saber a GPU do laptop e
> antes de conferir o estado atual dos modelos. A conclusao mudou: clonar nao precisa de
> treino nenhum. Mantida como historico.

### 11.1 A pergunta antes da pergunta: clonar ou treinar?

São duas coisas diferentes, e quase todo mundo pede a segunda querendo a primeira.

| | **Clone zero-shot** | **Fine-tune** (treino de verdade) |
|---|---|---|
| O que você entrega | 3 a 15 segundos de áudio | 20 a 40 minutos, transcritos |
| Quanto demora | segundos | 1 a 4 horas de GPU |
| Precisa de GPU alugada? | só para rodar | **sim — é aqui que o RunPod entra** |
| Custo no RunPod | ~US$ 0,50 (só para testar) | ~US$ 2 a 5, uma vez só |
| Resultado | parecido, mas oscila entre frases | estável, pega sotaque e jeito de falar |

**Recomendação: testar o zero-shot primeiro.** Os modelos de 2026 clonam de 3 segundos bem o
bastante para a maior parte dos usos. O fine-tune só se justifica se a voz sair instável — muda
de timbre entre frases, erra prosódia de pt-BR, escorrega para sotaque de Portugal, tropeça em
nome próprio ou número. Gastar meio dólar para descobrir isso é mais barato que gravar e
transcrever 40 minutos de áudio sem precisar.

### 11.2 A decisão que vem antes do modelo: onde a voz vai *rodar*

Treinar é um gasto de uma vez. **Servir é o gasto que não para.** Por isso o modelo se escolhe
pelo lugar onde ele vai viver depois, não pelo lugar onde ele treina.

| Onde serve | Latência | Custo mensal | Quando faz sentido |
|---|---|---|---|
| **Dedicado com GPU** | melhor possível | zero a mais | se o dedicado tiver GPU (pendência A2) |
| **Dedicado só CPU** | ok para modelo pequeno | zero a mais | voz boa, não excelente |
| **RunPod Serverless** | +0,2 a 2s de cold start | ~US$ 0 parado, centavos por fala | uso esporádico |
| **RunPod Pod ligado 24h** | melhor possível | ~US$ 250/mês (4090) | nunca, para uso pessoal |

O orçamento de voz-a-voz do projeto é ~800ms (§5/A3). Um cold start de serverless come esse
orçamento inteiro na primeira frase depois de um tempo parado — e um assistente pessoal fica
parado o tempo todo. **Então: RunPod para treinar, e o dedicado para servir.** Serverless entra
como plano B se o dedicado não tiver GPU e a qualidade em CPU não satisfizer.

→ Isso devolve urgência à pendência **A2 (specs do dedicado)**. Sem saber se há GPU, não dá
para fechar o modelo.

### 11.3 Modelo candidato: Qwen3-TTS

Aberto em janeiro de 2026 e é o encaixe mais limpo para o Lucky hoje.

| | |
|---|---|
| Licença | **Apache-2.0** — sem pegadinha de uso |
| Tamanhos | **0,6B** e **1,7B** (variantes Base, CustomVoice, VoiceDesign) |
| Idiomas | 10, **incluindo português** |
| Clone | de ~3 segundos de referência |
| Streaming | sim, latência de síntese declarada a partir de **97ms** |
| Fine-tune | repositório tem pasta própria (`Qwen3-TTS-Finetuning`) |
| VRAM para treinar | ~16GB pelas receitas da comunidade (cabe numa 4090) |

Por que ele e não os outros:

- **XTTS-v2** tem o melhor pt-BR de fábrica, mas a licença é CPML (pesquisa, não comercial) e o
  projeto está órfão desde o fim da Coqui. Serve de régua de qualidade, não de base.
- **Chatterbox** é MIT e clona de 5s, mas é mais fraco fora do inglês.
- **Kokoro / Piper** rodam em CPU e são a saída se o dedicado não tiver GPU — mas **nenhum dos
  dois clona voz**. Lá, voz nova = fine-tune obrigatório. Kokoro soa melhor, Piper é mais leve.
- **Dots.TTS** (Apache-2.0) ganhou teste cego em inglês; sem dado nenhum de pt-BR.

Nada disso está cravado: a escolha final é um teste de 1 hora com a nossa frase e a nossa voz.

### 11.4 O dataset (só se o fine-tune se confirmar)

A qualidade do fine-tune é decidida aqui, não no treino. Áudio ruim não se conserta com GPU.

- **20 a 40 minutos** de fala limpa. 30 minutos é o número de referência: um estudo da NVIDIA
  mostrou fine-tune com 30 min empatando com treino do zero com 27 horas.
- **Um microfone, um ambiente, uma sessão.** Mistura de fontes é o erro mais caro.
- Cortado em pedaços de **5 a 15 segundos**, WAV mono 24kHz, sem música, sem eco, sem clipping.
- **Transcrito.** Não transcreva à mão: roda Whisper large-v3 no mesmo pod do RunPod e revisa.
- O script tem que **parecer com o uso real**: se o Lucky vai falar número, hora, nome de arquivo
  e termo técnico, isso precisa estar nas gravações.
- Formato típico: pasta de áudios + JSONL com `{caminho, texto}` — o script de preparação do
  próprio modelo gera o resto.

Observação prática: clonar a voz de outra pessoa exige autorização dela. Voz própria, sem assunto.

### 11.5 O passo a passo no RunPod

1. **Network volume** primeiro (US$ 0,07/GB/mês, montado em `/runpod-volume`). Sem ele, o pod
   morre e leva modelo, dataset e checkpoint junto. 50GB resolve.
2. **Pod** com template PyTorch, GPU de 24GB. Na Community Cloud a RTX 4090 sai ~US$ 0,34/h e a
   A40 ~US$ 0,35/h; na Secure Cloud é cerca do dobro. Spot é mais barato e pode ser interrompido —
   para treino com checkpoint salvo no volume, dá para arriscar.
3. **Sobe o dataset** para o volume (`runpodctl` ou S3-compatível; evitar arrastar por navegador).
4. **Transcreve** com Whisper no próprio pod e revisa o JSONL.
5. **Teste zero-shot antes de treinar** — 20 minutos. Se já estiver bom, para aqui e desliga o pod.
6. **Fine-tune.** Treina, ouve amostra a cada checkpoint, para no ponto em que soa certo —
   treinar demais faz a voz ficar monótona e grudada nas frases do dataset.
7. **Guarda o checkpoint** no volume e, se for usar serverless depois, sobe para o Hugging Face
   (modelo em cache corta custo e cold start).
8. **DESLIGA O POD.** Pod parado continua cobrando disco; pod esquecido ligado é o único jeito
   de essa conta passar de uns poucos dólares.

### 11.6 Como isso entra no Lucky

A voz é uma ferramenta do servidor, exatamente como o LLM é (D6):

```
server.speak(texto) → camada TTS → áudio → cliente que pediu (desktop ou mobile)
```

A regra do D6 vale igual aqui: **o provedor de voz é configuração, não código.** A camada TTS
expõe uma função só e atrás dela pode estar o nosso modelo treinado, o Piper local ou uma API
paga (ElevenLabs, Cartesia). Isso deixa começar com API e trocar pelo modelo próprio sem mexer
em nada acima.

Ordem que não desperdiça trabalho: **primeiro o cano, depois a voz.** Fazer o Lucky falar com
qualquer voz de prateleira, ver o áudio chegando no celular e no PC, e só então trocar o modelo
por um treinado. Treinar primeiro e descobrir que o cano não existe é o jeito caro de aprender.

### 11.7 A conta final

| Item | Custo |
|---|---|
| Testar clone zero-shot | ~US$ 0,50 |
| Fine-tune completo (2 a 4h de 4090) | ~US$ 1 a 2 |
| Tentativas e erros (3 rodadas) | ~US$ 5 |
| Volume de 50GB enquanto durar | ~US$ 3,50/mês |
| Servir no dedicado com GPU | US$ 0 |
| **Total para ter a voz pronta** | **menos de US$ 10** |

O RunPod é barato demais para ser o risco deste projeto. O custo real aqui é o tempo de gravar
e limpar o dataset.

### 11.8 Pendências que isso abre

| # | Pergunta | Trava o quê |
|---|---|---|
| A7 | **Voz de quem?** A sua, clonada, ou uma voz própria do Lucky? | Formato do dataset |
| A8 | Já existe áudio gravado, ou vai gravar do zero? | Se o próximo passo é gravar ou treinar |
| A2 | **O dedicado tem GPU?** | Escolha do modelo (§9.2) — voltou a ser urgente |
| A3 | Voz sobe para antes da Fase 2? | Tamanho do v1 |

---

## 12. O servidor: `dedicated-1`

Acesso confirmado em 2026-10-25 (`ssh dedicated-1`, user `ubuntu`, chave ed25519).
**Isso fecha a pendência A2.**

| Item | O que tem |
|---|---|
| OS | Ubuntu 26.04.1 LTS |
| CPU | Xeon E5-1620 v2 — 4 núcleos / 8 threads @ 3.70GHz |
| RAM | **31 GB** (29 livres) |
| Disco | 145 GB, 134 livres |
| GPU | **nenhuma** (Matrox G200 é só saída de vídeo de servidor) |
| Já instalado | Python 3.14.4, git 2.53, **Claude Code** (`~/.local/bin/claude`) |
| Falta instalar | node, npm, docker, sqlite3, ffmpeg, ripgrep |
| Rede | só a porta 22 aberta |
| Uptime | 2 dias |

### 12.1 O que as specs decidem

**Sem GPU — confirma o D6 em definitivo.** Nada de LLM local. A IA vem de API, pelo
OpenRouter, e isso não é mais uma escolha de gosto: é a única opção viável nesse hardware.

**A CPU é de 2013, mas não atrapalha.** Xeon E5-1620 v2 tem single-thread ainda decente, e
o nosso agente passa 95% do tempo esperando resposta de API. O gargalo vai ser rede, não CPU.

**31 GB de RAM é folga enorme.** Não é um VPS apertado. Dá para rodar o agente, o banco, e
ainda sobra muito.

**Voz em CPU é viável, com ressalvas.** TTS (Piper, Kokoro) roda tranquilo. STT
(faster-whisper `small`) roda, mas devagar — serve para áudio curto, não para transcrever
uma hora de reunião.

**Python 3.14.4 já está lá — exatamente a versão que o Hermes exige.** Se um dia quisermos
instalar o Hermes de verdade para comparar, roda sem preparar nada.

**Claude Code está instalado.** Facilita muito: a gente pode construir direto lá.

---

## 13. Como a memória do Hermes funciona de verdade (olhando o código)

Repo clonado em `reference/hermes-agent/` — 363 MB, 10.061 arquivos Python. Fui no código
em vez de confiar nos blogs, e o resultado contraria a expectativa.

### 13.1 O banco não tem memória

As tabelas do SQLite do Hermes são estas:

```
sessions                 messages                system_prompts
conversation_generations session_admissions      session_model_usage
session_turn_leases      gateway_routing         gateway_heartbeats
gateway_hygiene_state    async_delegations       worker_executions
worker_receipts          compression_locks       runtime_epoch
schema_version           state_meta
```

Repara no que **não** está aí: nenhuma tabela de fato, de entidade, de relação, de conceito.
Tudo é sessão, mensagem, roteamento e controle de concorrência. **O banco do Hermes é um
log de conversa com infraestrutura em volta, não uma base de conhecimento.**

### 13.2 A memória dele são três coisas simples

**1. Dois arquivos markdown.** `MEMORY.md` (o ambiente) e `USER.md` (o perfil do usuário),
com limite de tamanho, injetados no prompt no começo da sessão. É isso.

**2. Busca full-text nas mensagens.** Três índices FTS5: `messages_fts` (padrão),
`messages_fts_trigram` (para busca parcial) e `messages_fts_cjk` (para chinês/japonês/coreano).
Busca por palavra, não por significado.

**3. `SOUL.md`, que vem vazio.** Zero linhas no repo. A personalidade é 100% escrita por você.

### 13.3 O "learning graph" não é o que o nome promete

Existe `agent/learning_graph.py`, 255 linhas, e eu fui ler porque o nome sugere exatamente a
teia de pensamento. Não é.

O próprio docstring diz: *"Assemble the 'learning made visible' graph for desktop"* — é um
**desenho para a interface**. E as ligações são montadas assim:

- skill → skill: pelo campo `related_skills` que **você escreveu** no frontmatter
- memória → skill: por **sobreposição de palavras** (`_tokenize`, contagem de tokens em comum)

Ou seja: é um grafo bonito gerado por coincidência de palavras, para o usuário olhar. Não há
extração de entidade, não há relação semântica, nada é persistido como grafo, e o agente não
raciocina sobre ele.

### 13.4 A conclusão que importa para o Lucky

O Hermes é mais moderno que o SandeClaw **como arcabouço** — gateway para 20+ plataformas,
skills com padrão aberto, cron, subagentes, seis backends de terminal. Nisso ele está muito à
frente.

Mas a **memória é a parte mais simples dele**, e de propósito: dois markdown e busca por
palavra. Eles mesmos documentam que a memória é pequena por desenho e inadequada para corpus
grande.

**Então a "teia de pensamento" que você quer é justamente a peça que não existe em nenhuma das
duas referências.** Nem no Hermes, nem no SandeClaw. É a parte que a gente teria que projetar
de verdade — e é exatamente onde o Lucky seria diferente de tudo que já existe, em vez de ser
mais um harness.

Isso muda a prioridade do projeto: a memória deixa de ser "infraestrutura que vem junto" e
passa a ser **o núcleo do produto**.

---

## 14. A decisão aberta mais interessante

### A10 — Como é a teia de pensamento do Lucky?

É a pergunta central agora, e depende da sua ideia, não da minha pesquisa. As referências não
resolvem: o Hermes guarda markdown e busca por palavra; o SandeClaw guarda só a janela da
conversa.

O que precisa ser definido, em ordem:

1. **O que é um "pensamento" guardado?** Uma frase? Um fato com sujeito e objeto? Um documento?
   Um evento com data?
2. **Como dois pensamentos se ligam?** Você declara? Ele deduz? Por palavra, por significado,
   por tempo, por causa?
3. **Quem escreve na teia?** Só ele, sozinho? Você revisa? Ele pede permissão?
4. **Como ele lembra na hora certa?** Puxa sozinho antes de responder, ou só quando precisa e
   pede?
5. **O que acontece quando ele descobre que estava errado?** Sobrescreve, versiona, ou guarda
   as duas versões com data?

A pergunta 5 é a que a maioria dos projetos ignora e é a que mais estraga memória de agente a
longo prazo.

---

## 15. O site — a interface principal do Thor

> Nome em uso: **Thor** (provisório, pode mudar).

Pedido: entrar com login e senha, de qualquer computador e do celular, e conversar com o Thor.

**Isso substitui o app Expo (D4) com vantagem** — sem loja, sem conta Apple de US$ 99/ano,
sem build nativo, e funciona em tudo que tem navegador no mesmo dia.

### 15.1 O desenho recomendado

| Peça | Escolha | Por quê |
|---|---|---|
| Onde roda | no `dedicated-1`, atrás de Caddy | já está ligado 24/7, e é onde o agente mora |
| HTTPS | Let's Encrypt (o Caddy faz sozinho) | obrigatório: senha em HTTP é inaceitável, e o microfone do navegador **só funciona em HTTPS** |
| Login | 1 usuário, senha com hash **argon2id**, cookie de sessão | é sistema de uma pessoa: sem cadastro, sem recuperação por e-mail, sem OAuth |
| Sessão | cookie `httpOnly` + `Secure` + `SameSite=Lax`, com expiração | não dá para ler por JavaScript nem vazar por outro site |
| Chat ao vivo | WebSocket | a resposta chega em pedaços, e o progresso das ferramentas também |
| Celular | **PWA** | instala na tela inicial, abre em tela cheia, sem loja |
| Voz | botão de falar (`getUserMedia`) | funciona em HTTPS. Wake word no navegador não existe. |

### 15.2 PWA entrega quase tudo — e o que não entrega

O PWA dá ~90% da sensação de app nativo: ícone na tela inicial, tela cheia, sem barra de
navegador. E dá isso **hoje**, sem loja e sem conta de desenvolvedor.

O que ele perde no iPhone:

- **Push notification funciona** (iOS 16.4+), mas só se o site estiver instalado na tela
  inicial — e é menos confiável que push nativo.
- **Não roda em background.** Nada de escutar com o app fechado, nada de wake word.

### 15.3 A sugestão: site como interface, Telegram como sino

O site é a interface principal: é nossa, mostra o raciocínio do agente, os arquivos gerados,
a teia de pensamento. É onde a conversa acontece.

Mas para **proatividade** (§2.4) — o Thor te avisar de algo sem você perguntar — o Telegram
ganha do web push com folga: chega no celular bloqueado, é confiável, e já funciona. Custa
pouquíssimo código adicionar.

→ **Conversa no site. Aviso no Telegram.**

### 15.4 O risco: essa vira a única porta de entrada

Hoje o `dedicated-1` só tem a porta 22 aberta (§12). Expor uma tela de login na internet é a
mudança mais arriscada do projeto até agora — é uma porta que qualquer um no mundo pode bater.

Mínimo obrigatório:

- senha forte com **argon2id** (não SHA, não bcrypt com custo baixo)
- **limite de tentativas** com atraso progressivo (ex.: 5 por 15 min por IP)
- **2FA por TOTP** — recomendado. É a única porta; vale os 10 minutos de implementação.
- `fail2ban` no proxy
- nunca registrar a senha em log, nem em mensagem de erro
- a sessão expira, e dá para revogar de dentro do site

### 15.5 A opção elegante: Cloudflare Tunnel

Vale considerar em vez de abrir porta: o servidor faz uma **conexão de saída** para a
Cloudflare, e o site fica acessível por um domínio com HTTPS pronto. Resultado:

- **nenhuma porta aberta no servidor** — mantém o princípio do D2
- HTTPS e certificado resolvidos, sem Let's Encrypt
- proteção contra ataque de volume vem de graça
- dá para somar o login da Cloudflare **antes** do nosso, virando duas portas em série

Custo: dependência de um terceiro no caminho da conversa, e o tráfego passa por eles.

---

### A11 — Domínio e forma de publicar

1. Já existe um domínio para apontar para o `dedicated-1`?
2. Abrimos 80/443 com Caddy, ou usamos Cloudflare Tunnel sem abrir nada?

Sem domínio, sobra certificado autoassinado — o navegador reclama e o celular pode recusar
instalar o PWA. Então isso precisa ser resolvido antes do site existir.

---

## 16. O domínio: `bolla.network` — conferido

Verificado em 2026-10-25, do próprio servidor:

| Registro | Valor | Situação |
|---|---|---|
| `bolla.network` → A | `5.135.131.58` | ✅ **aponta certo** para o `dedicated-1` |
| `www.bolla.network` → A | `5.135.131.58` | ✅ também |
| Nameservers | `ns1100.ui-dns.com` e irmãos | **IONOS** (1&1), não Cloudflare |
| MX (e-mail) | `mx00/mx01.ionos.co.uk` | ⚠️ **tem e-mail ativo no domínio** |
| Portas 80 / 443 | sem resposta | nada escutando ainda — esperado |

### 16.1 Mudei de recomendação: Caddy direto, não Cloudflare Tunnel

Na mensagem anterior eu recomendei Cloudflare Tunnel. **Com o DNS conferido, recomendo Caddy
direto** — e o motivo é o MX.

O Tunnel exige mover o DNS do domínio para a Cloudflare. Isso significa **recriar os registros
de e-mail da IONOS na mão**. Se algum passar batido, o e-mail do `bolla.network` para de
funcionar, e esse tipo de falha é silenciosa: você não descobre que não está recebendo, você
descobre semanas depois que alguém reclama.

Trocar um risco de segurança hipotético por um risco de quebrar e-mail que já funciona não vale
a pena agora. E o DNS **já aponta certo** — dá para subir o site hoje, sem tocar em nada.

| | Caddy direto | Cloudflare Tunnel |
|---|---|---|
| Mexe no DNS | ❌ nada | ✅ precisa migrar tudo, MX incluso |
| Funciona hoje | ✅ sim | depois da migração |
| Portas abertas | 80 e 443 | nenhuma |
| Segunda porta antes do nosso login | ❌ não | ✅ Cloudflare Access |
| Tráfego passa por terceiro | ❌ não | ✅ sim |

**O Tunnel continua sendo uma boa ideia — só não agora.** Trocar de Caddy para Tunnel depois
não muda uma linha da aplicação: é só a porta da frente. Então não é decisão irreversível.

### 16.2 O que o Caddy exige em troca

Sem a segunda porta da Cloudflare, as defesas do nosso lado deixam de ser opcionais:

- **2FA por TOTP no dia 1**, não "depois". Era recomendado; passa a ser obrigatório.
- **Limite de tentativas** de login com atraso progressivo.
- `fail2ban` observando o log do Caddy.
- O firewall do servidor está **inativo** (§12) — ativar o `ufw` liberando só 22, 80 e 443.

---

## 17. Decisões novas

| # | Decisão | Racional |
|---|---|---|
| D12 | **Por enquanto o Thor fala só pelo site.** Outros canais ficam para depois. | Foco. Um canal bem feito vale mais que três pela metade. A arquitetura não impede expandir (§15.3). |
| D13 | Domínio: **`bolla.network`**, já apontado para o `dedicated-1` | Conferido. DNS na IONOS, com e-mail ativo. |
| D14 | Publicação via **Caddy direto** em 80/443, com HTTPS automático | Funciona hoje sem mexer no DNS. Cloudflare Tunnel exigiria migrar o MX e arriscar o e-mail (§16.1). |
| D15 | **2FA por TOTP entra no dia 1** | Sem a segunda porta da Cloudflare, é a nossa única defesa em profundidade. |
| D16 | Ativar o `ufw` liberando só 22, 80 e 443 | O firewall está inativo hoje. |

→ **A11 está resolvida.** O nome do projeto na interface continua **Thor** (provisório).

---

## 18. O site esta no ar — 2026-10-25

**https://bolla.network** · HTTPS valido · rodando 24/7 no `dedicated-1`.

### 18.1 O que foi construido

| Camada | Escolha | Observacao |
|---|---|---|
| Runtime | **Node 24.22.1** | instalado do tarball oficial, em `/usr/local` |
| Linguagem | **TypeScript sem compilacao** | o Node 24 apaga os tipos e roda. Sem `tsc`, sem `dist`, sem build no deploy |
| Banco | **`node:sqlite` embutido**, com FTS5 | zero dependencia nativa. Sem `better-sqlite3`, sem `node-gyp` |
| Senha | **scrypt** do `node:crypto` | trocado do argon2id planejado: argon2 exige compilar modulo nativo, e scrypt resolve o mesmo problema sem dependencia que quebra em upgrade |
| 2FA | **TOTP escrito a mao** (RFC 6238) | 30 linhas, evita mais uma dependencia |
| Web | **Fastify 5** + 3 plugins + `qrcode` | 5 dependencias no total, todas JavaScript puro |
| Front | **HTML/CSS/JS a mao** | sem framework, sem build, sem CDN (a CSP bloqueia script externo) |
| Proxy | **Caddy 2.11.7** | certificado Let's Encrypt automatico, renovacao inclusa |
| Processo | **systemd** com isolamento | `ProtectSystem=strict`, so `/opt/luk/data` e gravavel |

### 18.2 O que o site faz hoje

- **Primeiro acesso com token** lido do servidor — ninguem reivindica a conta pela internet.
- **Login com senha + TOTP**, limite de 6 tentativas por IP em 15 minutos e atraso progressivo.
- **Chat em streaming** por WebSocket, com o texto aparecendo palavra a palavra.
- **Teia de pensamento**: o Thor marca o que vale guardar durante a resposta, e o servidor
  extrai, grava e desenha em grafo.
- **Alma editavel** pelo site — a personalidade e um texto, nao codigo.
- **Configuracao pelo site**: chave do OpenRouter e modelo, sem precisar de SSH.
- **Busca** em toda a memoria e em todas as conversas (FTS5).
- **PWA**: instala na tela inicial do celular, com icone proprio.

### 18.3 A teia de pensamento, na pratica

Em vez de uma segunda chamada de IA para "resumir o que aprendeu" — que dobraria o custo de
cada turno — **o proprio Thor marca o que importa enquanto responde**:

```
<lembrar tipo="projeto">O servidor dele e um Xeon sem GPU</lembrar>
<corrigir id="abc-123">na verdade sao 31 GB de RAM, nao 16</corrigir>
```

O servidor extrai as marcas, grava, liga os pensamentos nascidos no mesmo turno, e limpa o
texto antes de mostrar. Custo zero de API, e visivel para depuracao.

**A resposta a pergunta 5 da A10** (o que fazer quando ele estava errado): pensamento nunca
e sobrescrito. O antigo recebe `superseded_by` apontando para o novo, sai de circulacao e
continua no banco. Da para reconstruir o que o Thor acreditava em qualquer data, e a teia
mostra a evolucao de uma ideia — nao so o estado atual.

**As ligacoes sao explicitas**, com tipo e peso. Nada de deduzir aresta por coincidencia de
palavra, que e exatamente o que o `learning_graph.py` do Hermes faz (§13.3).

### 18.4 Tres erros encontrados durante a construcao

Vale registrar, porque os tres sao o tipo de coisa que volta:

1. **`parameter property` nao existe no modo sem compilacao.** `constructor(readonly x: T)`
   gera codigo, e o Node so apaga tipos. Virou campo declarado no corpo da classe.
2. **O Caddy nao escreve em `/var/log`.** A unit dele roda com `ProtectSystem`, entao a
   pasta e somente leitura. O log foi para o journal (`journalctl -u caddy`).
3. **`sudo rm /opt/luk/data/luk.db*` apagava nada, em silencio.** O `*` e expandido pelo
   shell do usuario `ubuntu`, que nao enxerga dentro de `data/` (permissao 700). Sem
   correspondencia, o `rm -f` recebe o literal e sai com sucesso. Resolvido com
   `sudo sh -c "rm -f ..."`, que expande ja como root. **Este e o mais perigoso dos tres:
   falhou sem erro e me fez acreditar que o banco estava limpo duas vezes.**

### 18.5 O que falta

**A chave do OpenRouter.** O site sobe, entra, navega e guarda memoria sem ela — mas o chat
avisa que falta. Cola em Configuracao, no menu lateral.

Verificado ponta a ponta com chave falsa: a requisicao chega formada no OpenRouter e volta
401, tratado e exibido como aviso legivel. O unico passo nao testado e uma resposta de
verdade, que depende da chave.

### 18.6 Decisoes consolidadas

| # | Decisao |
|---|---|
| D17 | Nucleo em **TypeScript rodando sem compilacao** no Node 24 (resolve A1) |
| D18 | Banco: **`node:sqlite` embutido**, sem dependencia nativa |
| D19 | Senha com **scrypt**, nao argon2id — evita modulo nativo (revisa D-anterior) |
| D20 | Front **sem framework e sem CDN**, por causa da CSP |
| D21 | Chave da IA e modelo **no banco**, ajustaveis pelo site sem SSH |
| D22 | Pensamento **nunca e sobrescrito**: corrigir cria novo e aposenta o velho |
| D23 | Memoria e marcada **pelo proprio modelo durante a resposta**, sem segunda chamada |

---

## 19. Supabase self-hosted — instalado em 2026-10-25

Em `/opt/supabase/app`, versao `self-hosted/v0.8.3`, 11 containers, todos saudaveis.
Instalado pelo `setup.sh` oficial, que gera os segredos e as chaves assimetricas sozinho.

| Peca | Container | Para que serve aqui |
|---|---|---|
| Postgres 17 | `supabase-db` | o banco de verdade; futura casa da teia de pensamento |
| GoTrue v2.197 | `supabase-auth` | **login com e-mail, recuperacao de senha, MFA** |
| PostgREST | `supabase-rest` | API REST automatica sobre as tabelas |
| Realtime | `supabase-realtime` | mudanca no banco empurrada ao vivo |
| Storage + imgproxy | `supabase-storage` | arquivos e miniaturas |
| Studio | `supabase-studio` | painel visual do banco |
| Envoy | `supabase-envoy` | porta de entrada da API |
| Supavisor | `supabase-pooler` | pool de conexoes |
| Edge Functions | `supabase-edge-functions` | funcoes em Deno |

Custo de recursos: **2,2 GB de RAM** com o Thor junto (de 31 GB) e 13 GB de disco.

### 19.1 A armadilha que quase custou o servidor

O compose do Supabase publica tres portas **em todas as interfaces**: 8000 (API e Studio),
5432 (Postgres) e 6543 (pooler).

**E o ufw nao protege nenhuma delas.** O Docker escreve as proprias regras de iptables na
cadeia `DOCKER`, avaliada **antes** das regras do ufw. Uma porta publicada pelo Docker fica
acessivel pela internet mesmo com o firewall ativo e negando tudo. Postgres aberto no mundo
e a forma classica de perder uma maquina, e o ufw ativo da uma falsa sensacao de que esta
tudo certo.

Resolvido com `docker-compose.override.yml`, prendendo as tres no `127.0.0.1`:

```yaml
services:
  api-gw:
    ports: !override
      - "127.0.0.1:${API_GW_HTTP_PORT:-8000}:8000/tcp"
```

**A tag `!override` nao e detalhe.** Sem ela o Compose *concatena* listas em vez de
substituir, e a porta aberta continuaria la, agora acompanhada da fechada.

Conferido de fora: as portas 8000, 5432 e 6543 nao respondem pela internet. So 22, 80 e 443.

### 19.2 Como o Studio e acessado

Nada de Supabase exposto na web. Para abrir o Studio, um tunel SSH:

```bash
ssh -L 8000:127.0.0.1:8000 dedicated-1
```

E entao `http://localhost:8000` no navegador. Usuario e senha estao em
`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` no `/opt/supabase/app/.env`.

Expor o Studio num subdominio seria somar uma porta de entrada na internet para ganhar
conveniencia que o tunel ja da. Nao compensa.

### 19.3 E-mail pela IONOS

Os tres servidores da IONOS respondem na 587. Escolhido `smtp.ionos.co.uk`, que casa com a
regiao do MX do `bolla.network` (`mx00.ionos.co.uk`).

```
SMTP_HOST=smtp.ionos.co.uk      SMTP_USER=hello@bolla.network
SMTP_PORT=587                   SMTP_SENDER_NAME=Thor
```

A senha **nao passa pelo chat nem por mim**. Ela e digitada direto no servidor:

```bash
ssh -t dedicated-1 sudo /opt/supabase/set-smtp-pass.sh
```

O script le a senha de forma oculta (nao entra no historico do shell, nem em `ps`, nem em
log), **testa o login no servidor de e-mail antes de gravar**, manda um e-mail de teste e so
entao grava e reinicia o `auth`. Se a senha estiver errada, nada e gravado.

### 19.4 Como a conta vai ser criada — e por que assim

`DISABLE_SIGNUP=true`. Ninguem na internet consegue se cadastrar, mesmo achando a URL.

O fluxo para criar a conta do Lucas:

1. Eu chamo a API de administracao do GoTrue para **convidar** `hello@bolla.network`.
2. O GoTrue manda um e-mail com um link de uso unico.
3. Ele abre o link e **escolhe a propria senha**.

Assim ninguem alem dele conhece a senha em momento algum — nem eu, nem o historico desta
conversa. E a razao de a instalacao do e-mail vir antes da criacao da conta.

### 19.5 O que ainda nao foi feito

O login do site **continua sendo o nosso** (scrypt + TOTP, §18.1). O GoTrue esta no ar mas
ainda nao e quem autentica o Thor. Migrar significa trocar `auth.ts` por validacao de JWT do
Supabase, e e o proximo passo — depois que o e-mail estiver provado funcionando.

Vantagem da migracao: recuperacao de senha por e-mail, que hoje nao existe. Se a senha for
perdida, a unica saida e SSH no banco.

### 19.6 Decisoes

| # | Decisao |
|---|---|
| D24 | Supabase self-hosted em `/opt/supabase/app`, **tudo preso no `127.0.0.1`** |
| D25 | Studio so por tunel SSH; nada do Supabase exposto na web |
| D26 | E-mail pela IONOS (`smtp.ionos.co.uk:587`), senha digitada no servidor, nunca no chat |
| D27 | `DISABLE_SIGNUP=true`; a conta nasce de um convite, e a senha e escolhida pelo Lucas |

### 19.7 Operacao

```bash
cd /opt/supabase/app
sudo docker compose ps                    # estado dos 11 containers
sudo docker compose logs -f auth          # log do login
sudo docker compose restart auth          # reiniciar um servico
sudo sh run.sh stop                       # parar tudo
sudo cat .env                             # segredos (chaves, senhas)
```

---

## 20. Memoria e personalidade — a discussao de desenho

### 20.1 O furo da memoria que esta no ar hoje

A recuperacao e por **palavra** (FTS5). O `memoryBlock()` pega a pergunta, procura essas
palavras nos pensamentos e injeta o que casar, mais os fixados.

Isso funciona em "como esta o servidor" — casa "servidor". E **falha exatamente quando mais
importa**: em "e ai, o que eu faco hoje?" nenhuma palavra casa, nada e recuperado, e o Thor
responde como um chatbot qualquer. Pergunta vaga e o caso mais comum numa conversa, e e
justamente onde a memoria por palavra nao alcanca.

**A correcao ficou barata com o Supabase (§19):** o Postgres traz `pgvector`. Busca por
significado faz "o que eu faco hoje" alcancar "o Lucas esta construindo o Thor e travou na
migracao do login", sem compartilhar nenhuma palavra.

O desenho certo e somar tres fontes, nao trocar uma pela outra:

| Fonte | O que traz | Quando salva o dia |
|---|---|---|
| Fixados | sempre presentes | o nucleo de quem ele e e quem voce e |
| Semantica (pgvector) | por significado | pergunta vaga, assunto sem palavra-chave |
| Palavra (FTS5) | exata | nome proprio, codigo, caminho de arquivo |

### 20.2 A pergunta aberta: qual e a forma de um pensamento?

Hoje todo pensamento tem a mesma forma: uma frase com um rotulo. Para o sistema,
`O servidor tem 31 GB de RAM` e `O Lucas prefere resposta curta` sao a mesma coisa.

Nao deveriam ser. Eles se comportam diferente:

| Tipo | Muda com que frequencia | O que importa nele |
|---|---|---|
| **Fato sobre coisa** | raro, mas muda (upgrade de RAM) | o valor atual |
| **Preferencia sua** | quase nunca | deve estar sempre carregado |
| **Projeto** | toda semana | o estado agora, e o historico importa |
| **Decisao** | nunca (vira historico) | **o porque pesa mais que o conteudo** |
| **Evento** | nao muda | a data e o que define |

Uma decisao sem o motivo e inutil seis meses depois — e hoje a gente nao guarda motivo.

### 20.3 A tese sobre personalidade

**Personalidade e memoria nao sao dois assuntos. Sao o mesmo.**

O que faz alguem parecer que te conhece nao e o tom de voz: e lembrar que voce odeia resposta
longa, e encurtar. O texto da Alma deveria ser **pequeno e estavel**; a sensacao de
personalidade vem da memoria sendo bem usada.

Consequencia pratica: investir na recuperacao da memoria rende muito mais que escrever uma
alma elaborada. Uma alma de 20 linhas com memoria boa parece mais viva que uma alma de 200
linhas sem memoria nenhuma.

### 20.4 O que vem do SandeClaw

As **skills** dele (§9.3) sao a terceira perna: alma = como ele e, memoria = o que ele sabe,
skill = o que ele sabe *fazer*. O router de passo zero continua sendo a melhor ideia das
specs, e entra quando houver skills suficientes para o contexto pesar.

---

## 21. Pesquisa: como os que funcionam fazem memoria e personalidade

Pesquisado em 2026-10-25, indo ao codigo e a documentacao oficial em vez de blog.

### 21.1 O erro que eu cometi no Thor que ja esta no ar

Comecando pelo que importa, porque e exatamente o custo que voce quer evitar.

Hoje o `buildPrompt()` monta o system prompt assim:

```
alma + "Hoje e 2026-10-25" + bloco de memoria montado a partir da pergunta
```

**O bloco de memoria muda a cada mensagem.** E a documentacao da Anthropic e explicita: o
cache de prompt funciona por **prefixo exato** — qualquer byte diferente invalida tudo que
vem depois. A ordem de renderizacao e `tools` → `system` → `messages`.

Resultado: o system prompt muda todo turno, **o cache nunca acerta, e voce paga preco cheio
em cada mensagem.** Com leitura de cache custando ~0,1x do preco de entrada (0,05x no Opus
5.5: US$ 0,20 contra US$ 4,00 por milhao), isso e **cerca de 10x mais caro do que precisava
ser**, para sempre.

A propria doc lista isso como anti-padrao, com o nosso caso no exemplo: *nao interpole
"data de hoje", "modo", "nome do usuario" no system prompt*.

**A correcao** tem duas partes, e as duas sao baratas:

1. **Congelar o system prompt.** Alma + perfil estavel, e mais nada. Nunca a data, nunca o
   resultado de busca.
2. **Contexto dinamico entra depois**, como mensagem `{"role": "system"}` dentro de
   `messages[]` — suportado no Opus 5.5 e no Sonnet 5.5, sem beta header. Uma mensagem no
   turno 5 nao invalida nada antes do turno 5.

Verificacao: `usage.cache_read_input_tokens`. Se vier zero em requisicoes repetidas, tem
invalidador silencioso no caminho.

### 21.2 O Hermes chegou na mesma conclusao

A docstring do `tools/memory_tool.py` dele, palavra por palavra:

> *"Both enter the system prompt as a **FROZEN snapshot at session start**; mid-session
> writes hit disk but never change the prompt (**prefix cache intact**)."*

Ou seja: o Hermes **escreve na memoria durante a sessao, mas nao mexe no prompt.** A memoria
so e relida na sessao seguinte. Ele abre mao de usar o que acabou de aprender imediatamente
para nao quebrar o cache — e, pelos numeros acima, essa troca compensa com folga.

Limites confirmados no codigo: `memory_char_limit=2200`, `user_char_limit=1375`.

### 21.3 Letta / MemGPT — a arquitetura de referencia

E o sistema que mais diretamente responde ao "sem ficar lembrando toda hora". Tres camadas:

| Camada | Onde fica | Como e acessada | Tamanho |
|---|---|---|---|
| **Core** | **dentro do prompt** | sempre presente | pequena, limitada |
| **Recall** | fora | o historico da conversa | medio |
| **Archival** | banco vetorial | **o agente busca com uma ferramenta** | ilimitada |

O ponto central: **a camada grande nao entra no contexto. O agente chama uma ferramenta
quando precisa.** A busca roda no servidor por similaridade vetorial e **nao invoca o LLM**.

A core memory e dividida em blocos `persona` (quem o agente e) e `human` (quem o usuario e),
e o proprio agente os edita por chamada de funcao.

**A critica honesta que a literatura faz:** memoria auto-editada depende do julgamento do
modelo, e erros se acumulam ao longo de muitos ciclos de edicao sem verificacao externa.
E o custo do nosso `<lembrar>` atual.

### 21.4 Quanto isso economiza, pelos numeros publicados

| Abordagem | Tokens por consulta |
|---|---|
| Contexto cheio (jogar tudo no prompt) | 25.000+ |
| Mem0 (recuperacao) | < 7.000 |
| Zep | ~1.600 |

Numeros auto-reportados pelos fornecedores; uma comparacao independente poe a precisao dos
dois bem abaixo do que cada um publica sobre si. Servem como ordem de grandeza, nao como
promessa.

### 21.5 Personalidade: o que a Anthropic faz

O termo deles e **"character training"**, uma variante de Constitutional AI: o modelo gera
respostas alinhadas a um traco, **ordena as proprias respostas** por alinhamento, e um modelo
de preferencia treina em cima disso. Nao e lista de regra — e traco internalizado.

O principio que da para roubar, esse sim: **julgamento em vez de regra.** A constituicao
treina tracos (curiosidade, honestidade, humildade intelectual) em vez de dar lista de
proibicoes. E ela tem **ordem de prioridade**, que so entra em acao quando dois valores
conflitam.

Da documentacao de prompt deles, o que e acionavel para a nossa Alma:

- definir **papel e personalidade** no system prompt
- dar **detalhe concreto**: historico, tracos, manias
- **listar cenarios comuns e a resposta esperada** — exemplo vale mais que adjetivo

Traduzindo para o Thor: trocar *"seja direto"* por *"quando ele pedir uma escolha entre tres
opcoes, escolha uma e justifique em uma linha — nao devolva a lista"*.

### 21.6 A arquitetura que eu proponho para o Thor

Juntando tudo, em tres camadas e uma regra:

```
┌─ NUCLEO  (congelado no system prompt, ~1.500 tokens, CACHEADO) ─┐
│   alma (quem ele e)  +  perfil do Lucas (quem voce e)           │
└──────────────────────────────────────────────────────────────────┘
┌─ CONVERSA  (messages[], cresce, cacheada por prefixo) ───────────┐
│   historico + contexto dinamico como {"role":"system"}           │
└──────────────────────────────────────────────────────────────────┘
┌─ ARQUIVO  (Postgres + pgvector, FORA do contexto) ───────────────┐
│   toda a teia + todas as conversas                               │
│   o Thor chama `buscar_memoria(...)` quando precisa               │
└──────────────────────────────────────────────────────────────────┘
```

**A regra, em uma frase: nada que muda por turno entra no system prompt.**

O que isso muda na pratica:

| Hoje | Proposto |
|---|---|
| memoria injetada todo turno, por palavra-chave | nucleo fixo + o Thor **busca** quando precisa |
| system prompt muda sempre → cache nunca acerta | system prompt congelado → ~90% mais barato no prefixo |
| recupera so o que casa por palavra | pgvector alcanca por significado |
| `<lembrar>` grava direto, sem revisao | grava igual, mas com revisao periodica do nucleo |

**O ganho de custo nao vem de lembrar menos. Vem de parar de reescrever o inicio do prompt.**

### 21.7 Decisoes propostas

| # | Proposta |
|---|---|
| D28 | **System prompt congelado.** Nada de data, nada de resultado de busca dentro dele. |
| D29 | Contexto dinamico entra como `{"role":"system"}` em `messages[]`, nao no topo |
| D30 | Memoria em 3 camadas: nucleo no prompt, conversa, arquivo fora do contexto |
| D31 | **Busca de memoria vira ferramenta** que o Thor chama, nao injecao automatica |
| D32 | pgvector para significado, FTS5 para termo exato — os dois, nao um ou outro |
| D33 | Alma escrita com **cenario e resposta esperada**, nao com adjetivo |
| D34 | Medir `cache_read_input_tokens` — se vier zero, tem invalidador no caminho |

---

## 22. Correcao do cache — feita e verificada em 2026-10-25

O erro da secao 21.1 esta corrigido no ar. O que mudou, e como ficou provado.

### 22.1 O que mudou no codigo

**1. O system prompt virou lista de blocos, com marcador de cache.**

Descoberta que mudou a implementacao: **no OpenRouter, modelos da Anthropic nao tem cache
automatico.** A maioria dos provedores (OpenAI, Groq, DeepSeek, Gemini) cacheia sozinho;
Anthropic e Qwen exigem marcar bloco a bloco com `cache_control`. Ou seja: antes da correcao
o Thor **nao tinha cache nenhum**, nem parcial — nao era so o prefixo instavel, era que
ninguem tinha ligado o cache.

A ordem ficou assim, e cada posicao tem motivo:

| Posicao | Conteudo | Por que ali |
|---|---|---|
| system, bloco 0 | alma + nucleo fixado | estavel entre turnos → **leva o marcador** |
| system, bloco 1 | `Hoje e 2026-10-25` | muda todo dia → fica **depois** do marcador |
| ultima mensagem | o turno atual | **segundo marcador**: a conversa tambem cacheia enquanto cresce |

O truque do bloco 1: conteudo **depois** do ultimo marcador nao e cacheado, mas tambem **nao
invalida** o que vem antes. A data custa ~10 tokens por requisicao e deixa de derrubar o
prefixo inteiro uma vez por dia.

**2. A memoria virou ferramenta.** `buscar_memoria(consulta)` substitui a injecao automatica.
O Thor chama quando precisa; a busca roda inteira no SQLite, sem passar pelo LLM. O laco do
agente aceita ate 4 voltas por mensagem.

**3. O nucleo deixou de depender da pergunta.** `coreBlock()` entrega so os pensamentos
fixados, em ordem deterministica por data de criacao. Nao muda entre turnos — que era o
requisito.

**4. O uso de tokens passou a ser medido.** `stream_options: {include_usage: true}` faz o
OpenRouter devolver `prompt_tokens_details.cached_tokens`. Vai para o log do servidor e para
a barra de status do site.

### 22.2 Como ficou provado, e nao so afirmado

Nao da para confiar em "deve estar funcionando" num detalhe que custa 10x. Entao:

1. `LUK_LLM_ENDPOINT` virou configuravel. Apontei para um servidor local que **grava o corpo
   da requisicao** e devolve um SSE valido.
2. Subi uma instancia de teste com banco proprio apontada para ele.
3. Mandei tres mensagens diferentes na mesma conversa e tirei o SHA-256 do bloco cacheado.

```
turno 1:  6da4c808478142c3  (1056 chars, 2 mensagens no prompt)
turno 2:  6da4c808478142c3  (1056 chars, 4 mensagens no prompt)
turno 3:  6da4c808478142c3  (1056 chars, 6 mensagens no prompt)
```

**Hash identico nos tres** enquanto a conversa cresce de 2 para 6 mensagens. E o que o cache
de prefixo exige. A estrutura capturada confirmou os dois marcadores no lugar certo e a
ferramenta `buscar_memoria` sendo oferecida.

### 22.3 Tres tropecos do caminho

- **Node nao aceita `parameter property`** — ja sabido (§18.4), e eu repeti. Corrigido.
- **`set -e` aborta no `pkill` que nao acha nada.** O script parava sem executar nada e o log
  antigo continuava no lugar, me fazendo depurar um erro que ja nao existia.
- **`pkill -f` nao enxerga variavel de ambiente.** A instancia de teste so se distinguia pelo
  `PORT=8788`, que nao aparece na linha de comando — o processo velho sobrevivia e a sonda
  conversava com ele. Passei a matar pelo PID que escuta a porta.

### 22.4 O que ainda nao foi medido

**O cache acertando de verdade, com a API real.** Isso precisa da sua chave do OpenRouter.
Quando ela estiver no site, a barra embaixo do chat mostra `N% do cache` a cada resposta —
e o log do servidor registra a mesma coisa.

Se ficar em 0% por varias mensagens seguidas, alguma coisa voltou a mexer no inicio do
prompt. Esse numero e o alarme.

### 22.5 Decisoes aplicadas

| # | Aplicada |
|---|---|
| D28 | System prompt congelado — alma + nucleo fixado, nada que mude por turno |
| D29 | Conteudo volatil (a data) **depois** do ultimo marcador de cache |
| D31 | Busca de memoria e **ferramenta**, nao injecao automatica |
| D34 | `cached_tokens` medido, exibido no site e no log |
| D35 | `cache_control` explicito: no OpenRouter, Anthropic nao cacheia sozinho |
| D36 | `LUK_LLM_ENDPOINT` configuravel, para poder verificar o que sai pela rede |

---

## 23. Usar o Claude Code em vez do OpenRouter? — pesquisado e medido

Pergunta levantada em 2026-10-25. Resposta curta: **da para fazer, mas nao devemos.**
Tres motivos independentes, e qualquer um deles ja bastaria.

### 23.1 Tecnicamente funciona

O modo headless existe e roda hoje no `dedicated-1` (Claude Code 2.1.310):

```bash
claude -p "pergunta" --output-format json
```

E existe o **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), biblioteca oficial que
embute o Claude Code num programa TypeScript. Ele entrega `systemPrompt` proprio,
`disallowedTools`, streaming com `includePartialMessages`, sessoes com `resume`, hooks,
subagentes e MCP.

Ou seja: a pergunta nao e "e possivel". E.

### 23.2 A licenca desaconselha — texto da doc oficial

> *"Unless previously approved, Anthropic does not allow third party developers to offer
> claude.ai login or rate limits for their products, including agents built on the Claude
> Agent SDK. Use the API key authentication methods described in the Quickstart instead."*

E o `dedicated-1` esta autenticado **exatamente do jeito desaconselhado**. O
`~/.claude/.credentials.json` tem `claudeAiOauth`, com `subscriptionType` e `rateLimitTier`
— e login de assinatura, nao chave de API.

O Thor e pessoal, de um usuario so, entao nao e "oferecer para clientes". Mas e uma aplicacao
separada consumindo os limites da assinatura de forma programatica, que e o que a frase
desaconselha. Nao vale arriscar a conta por isso.

### 23.3 E caro e lento — medido, nao estimado

Rodei no proprio servidor.

**Chamada normal**, perguntando so "Responda apenas: funcionou":

| | |
|---|---|
| custo | **US$ 0,1368** |
| latencia | **9.134 ms** |
| cache escrito | 13.096 tokens |
| cache lido | 11.334 tokens |
| saida | 6 tokens |

**Chamada enxuta** — system prompt proprio, todas as ferramentas desligadas, secoes
dinamicas excluidas:

| | |
|---|---|
| custo | **US$ 0,1302** |
| latencia | 3.398 ms |
| cache escrito | 13.006 tokens |
| saida | 6 tokens |

**Enxugar quase nao mudou nada.** Mesmo sem ferramenta nenhuma, o Claude Code carrega
**~13 mil tokens de contexto proprio** em toda chamada. Ele e um arcabouco de programacao,
nao um gateway de LLM — e esse peso nao sai.

Comparando com o que o Thor gasta hoje:

| | Tokens de prompt | Custo por mensagem |
|---|---:|---:|
| Thor pelo OpenRouter (Sonnet 5.5) | ~1.500 | ~US$ 0,01 |
| Claude Code headless | ~13.000 + | **US$ 0,13** |

**Cerca de 13x mais caro, medido**, para responder uma palavra. A conversa de um dia inteiro
no Thor custaria menos que cinco mensagens pelo Claude Code.

E tem a ironia: a gente acabou de passar uma sessao inteira consertando o cache (§22). Pelo
Claude Code, o cache e gerido por ele — perdemos justamente o controle que acabamos de
construir e provar.

### 23.4 Para ser justo: o que o Claude Code traria de bom

Nao e so desvantagem. De graca viriam:

- o laco do agente, ja maduro
- compactacao de contexto automatica
- sessoes com `resume` e `fork`
- subagentes, hooks, MCP
- **skills carregadas de `.claude/`** — o sistema de skills do SandeClaw (§9.3), pronto
- **ferramentas de arquivo e bash** — literalmente o "maos no PC" que a gente projetou

Se o Thor virasse "Claude Code com interface web", muita coisa do roadmap sairia de graca.

Mas ai e outro projeto. O Thor deixaria de ser nosso e viraria uma casca em volta do Claude
Code: preso a um modelo so, sem controle do cache, sem controle do prompt, a 13x o custo, e
com a licenca dizendo para nao fazer assim.

### 23.5 Se voce quiser Claude de verdade, o caminho certo e outro

Nao e Claude Code nem OpenRouter: e a **API da Anthropic com chave propria**.

| Caminho | Suportado? | Controle do cache | Custo | Troca de modelo |
|---|---|---|---|---|
| OpenRouter (hoje) | sim | **nosso** (§22) | ~US$ 0,01/msg | uma linha de config |
| API Anthropic direta | sim | **nosso**, com recursos a mais | parecido | so Claude |
| Claude Code / Agent SDK | so com chave de API | **do harness** | ~US$ 0,13/msg | so Claude |

A API direta da Anthropic tem coisas que o OpenRouter nao expoe — compactacao no servidor,
edicao de contexto, mensagem de sistema no meio da conversa. Se um dia o Thor precisar disso,
a troca e pequena: o nosso `llm.ts` ja isola essa camada inteira.

### 23.6 Decisao

| # | Decisao |
|---|---|
| D37 | **Ficamos no OpenRouter.** Claude Code headless custa ~13x mais por mensagem (medido) e a doc oficial desaconselha usar a assinatura assim. |
| D38 | Se um dia quisermos Claude direto, o caminho e a **API da Anthropic com chave propria**, nao o Claude Code. O `llm.ts` ja isola essa troca. |
| D39 | O Claude Code continua util no servidor para **desenvolver** o Thor — so nao para ser o motor dele. |

---

## 24. Dois provedores, trocaveis na tela — feito em 2026-10-25

O Thor fala com **OpenRouter** ou **direto com a Anthropic**, e a troca e um clique.

### 24.1 Por que isso deu trabalho de verdade

Os dois formatos nao sao variacoes do mesmo tema. Sao diferentes em pontos estruturais:

| | OpenRouter (formato OpenAI) | Anthropic (nativo) |
|---|---|---|
| system | **mensagem** dentro do array | **parametro proprio**, fora das mensagens |
| ferramentas | `tools[].function.parameters` | `tools[].input_schema` |
| resultado de ferramenta | mensagem de papel `tool` | bloco `tool_result` **dentro de uma mensagem do usuario** |
| chamada de ferramenta | `delta.tool_calls[]`, fatiada por indice | `content_block_start` + `input_json_delta` |
| streaming | `choices[0].delta`, termina em `[DONE]` | eventos nomeados, termina em `message_stop` |
| autenticacao | `Authorization: Bearer` | `x-api-key` + `anthropic-version` |
| id do modelo | `anthropic/claude-sonnet-5.5` | `claude-sonnet-5-5` |

Traduzir isso no meio do codigo da aplicacao seria um `if` em cada ponto.

### 24.2 A solucao: formato neutro no meio

O resto do programa nao fala nenhum dos dois. Fala isto:

```ts
type Prompt = {
  systemStable: string;    // alma + nucleo — leva o marcador de cache
  systemVolatile: string;  // a data — vai depois do marcador
  turns: Turn[];           // user | assistant (com toolCalls) | tool
};
```

Cada adaptador traduz na saida. **O `buildPrompt()` nao sabe qual provedor esta ativo**, e o
laco do agente tambem nao. Trocar de provedor nao toca em nenhuma linha fora do `llm.ts`.

A divisao `systemStable` / `systemVolatile` sobrevive a traducao: nos dois formatos o marcador
de cache cai no primeiro bloco e a data fica depois dele. A regra do §22 vale igual nos dois.

### 24.3 Como ficou na tela

Em Configuracao: um seletor **OpenRouter | Anthropic**, um campo de chave para cada um, e o
modelo. **Cada provedor guarda a propria chave e o proprio modelo** — trocar de um para o
outro e voltar nao perde nada.

A validacao que vale a pena: a chave do OpenRouter comeca com `sk-or-` e a da Anthropic com
`sk-ant-`. E a unica checagem barata possivel, e pega o engano mais comum, que e colar a
chave de um no campo do outro.

### 24.4 Verificado, nao presumido

Mesmo metodo do §22: endpoints falsos que gravam o corpo da requisicao.

**Estrutura de cada formato:**

```
OPENROUTER                           ANTHROPIC
modelo: anthropic/claude-sonnet-5.5  modelo: claude-sonnet-5-5
system: MENSAGEM no array            system: PARAMETRO PROPRIO
  bloco 0 << MARCADOR                  bloco 0 << MARCADOR
  bloco 1 (a data, sem marcador)       bloco 1 (a data, sem marcador)
ferramenta: function.parameters      ferramenta: input_schema
ultima mensagem << MARCADOR          ultima mensagem << MARCADOR
```

**E a traducao mais dificil — o resultado de ferramenta no formato Anthropic:**

```
[0] user:      texto            (a pergunta)
[1] assistant: tool_use         id=toolu_abc  name=buscar_memoria  input={"consulta":"servidor"}
[2] user:      tool_result      para=toolu_abc  >> Trechos de conversas antigas: ...
```

Exatamente o que a API da Anthropic espera: a chamada no assistente, o resultado numa
mensagem de usuario, com o id casando.

### 24.5 Tres armadilhas do caminho

- **`pkill -f` mata o proprio comando.** O padrao que eu procurava (`echo2.mjs`) aparecia na
  linha de comando do bash que eu mesmo estava rodando por SSH, entao ele se matava e o
  resultado vinha vazio. Passei a matar pelo PID que escuta a porta.
- **A geracao de titulo chega antes do chat.** `improveTitle()` dispara sem `await`, entao a
  primeira requisicao que o provedor recebe pode ser a do titulo. Meu teste assumia que a
  primeira era o chat e media a coisa errada. O servidor falso passou a decidir pelo conteudo
  (se oferece ferramentas, e o chat).
- **Aspas escapadas dentro de heredoc nao sobrevivem.** Mesma causa do `{NL}` do §22: montei
  as strings com `String.fromCharCode(34)` em vez de escapar.

### 24.6 Decisoes

| # | Decisao |
|---|---|
| D40 | **Dois provedores**: OpenRouter e Anthropic, escolhidos na tela, sem mexer em codigo |
| D41 | Formato **neutro** no meio (`Prompt`/`Turn`); so o `llm.ts` conhece os dois dialetos |
| D42 | Chave e modelo **guardados por provedor** — trocar e voltar nao perde configuracao |
| D43 | O marcador de cache cai no mesmo lugar logico nos dois formatos (§22 vale igual) |

---

## 25. Cadastro por convite — feito em 2026-10-25

Antes, criar a conta exigia copiar um token do servidor por SSH. Agora chega um link por
e-mail. Convite emitido e entregue para `<e-mail do dono>`.

### 25.1 Como funciona

```
  servidor                     caixa postal              navegador
     |                              |                        |
  invite.ts <email>                 |                        |
     |-- confere login no SMTP      |                        |
     |-- grava o HASH do token      |                        |
     |-------- e-mail com o link -->|                        |
     |                              |--- clique no link ---->|
     |<------ /api/invite/check ----------------------------|
     |-------- e-mail do convidado ------------------------>|
     |<------ /api/setup { token, usuario, senha } ---------|
     |-- marca o convite como usado |                        |
```

### 25.2 Decisoes de seguranca

**O convite e emitido por SSH, nao pela web.** Enquanto nao existe conta nenhuma, nao ha
quem possa se autenticar para pedir um convite — qualquer rota web que emitisse convite
seria uma porta aberta. Quem tem SSH e a unica autoridade que existe nesse momento, e e ela
que decide para qual endereco a conta pode nascer.

**O banco guarda so o hash do token**, igual as sessoes. Se o banco vazar, os convites em
aberto nao servem para criar conta.

**Uso unico e 24 horas.** Um convite valido e a chave da casa: enquanto esta de pe, quem
tiver o link cria a conta do dono. Emitir um novo para o mesmo e-mail invalida os anteriores.

**O token sai da URL assim que a pagina carrega** (`history.replaceState`). Sem isso ele
ficaria no historico do navegador e vazaria no cabecalho `Referer` de qualquer link clicado
depois.

**As credenciais de e-mail ficam no `.env`, nunca no banco.** Senha de caixa postal nao e
configuracao de aplicacao: quem conseguir ler o banco nao deveria ganhar a conta de e-mail
junto. (A chave da IA, essa sim, fica no banco — e ajustavel pela tela e tem escopo menor.)

**As duas portas continuam valendo.** O link do e-mail ou o `SETUP_TOKEN` do disco: as duas
provam autoridade sobre a maquina ou sobre a caixa postal. A segunda fica como saida de
emergencia se o e-mail parar.

### 25.3 Uso

```bash
cd /opt/luk/server
sudo -u luk LUK_ROOT=/opt/luk /usr/local/bin/node src/invite.ts <email>
```

Ele confere o login no servidor de e-mail **antes** de gravar o convite, entao senha errada
nao gera convite orfao. Se o envio falhar depois de criado, o link e impresso na tela como
plano B.

Para emitir quando ja existe conta (trocar de e-mail, por exemplo), acrescente
`--mesmo-assim`.

### 25.4 Detalhe de implementacao

`nodemailer` entrou como sexta dependencia — ainda JavaScript puro, sem compilacao. Escrever
SMTP com STARTTLS e AUTH na mao seriam ~100 linhas de protocolo com varias formas de falhar
em silencio; nao vale.

A porta define o modo de TLS e errar isso trava a conexao sem mensagem util: **465 e TLS
desde o primeiro byte; 587 comeca em claro e sobe com STARTTLS.** A IONOS usa 587.

### 25.5 Decisoes

| # | Decisao |
|---|---|
| D44 | Cadastro por **convite com link por e-mail**, uso unico, validade de 24h |
| D45 | Convite emitido **por SSH**, nunca por rota web — nao existe admin antes da primeira conta |
| D46 | Banco guarda **so o hash** do token do convite |
| D47 | Token sai da URL ao carregar a pagina (historico e `Referer`) |
| D48 | Credenciais de e-mail no `.env`; so a chave da IA fica no banco |
| D49 | `SETUP_TOKEN` continua valendo como saida de emergencia |

---

## 26. Autenticacao pelo Supabase — feito em 2026-10-25

O login do Thor agora e o **GoTrue**, o servico de autenticacao do Supabase. Sai o scrypt
caseiro com TOTP; entra e-mail e senha com confirmacao por e-mail e recuperacao de senha.

### 26.1 O desenho: o navegador nunca fala com o Supabase

Essa e a decisao central, e ela e deliberada.

```
  navegador  ──HTTPS──>  Thor  ──localhost──>  GoTrue
      |                                          |
      +--- so /auth/v1/verify passa pelo Caddy --+
           (a rota que o link do e-mail abre)
```

Tudo que e login, cadastro, senha e administracao acontece **servidor a servidor pelo
localhost**. Na internet existe uma unica rota do Supabase: `/auth/v1/verify`, que o link do
e-mail precisa abrir.

O que isso compra:

- **Nao ha rota publica de login do GoTrue** para martelar senha. Quem tenta forca bruta bate
  no nosso `/api/auth/login`, que tem limite por IP e atraso progressivo.
- **Nao ha rota publica de cadastro.** `DISABLE_SIGNUP=true` no GoTrue, e a conta e criada
  pela API de administracao, so pelo nosso servidor.
- **O navegador nunca guarda um JWT do Supabase.** Ele tem um cookie opaco nosso. Cookie
  roubado nao vira acesso a API do Supabase.

### 26.2 Como a conta nasce

Usamos `admin/generate_link` com `type: signup` em vez de `/signup`. Essa chamada cria o
usuario **e devolve** o link de confirmacao sem enviar nada — entao o e-mail sai pelo nosso
remetente, com a cara do Thor, e o cadastro do GoTrue continua desligado.

**So um endereco pode criar a conta:** `LUK_OWNER_EMAIL` no `.env`. Outro e-mail recebe uma
recusa generica e lenta, que nao revela qual e o endereco certo.

Fluxo completo:

```
cadastro  ->  GoTrue cria o usuario  ->  link por e-mail
   ->  /auth/v1/verify  ->  redireciona para bolla.network#access_token=...
   ->  a pagina troca o token por sessao nossa  ->  ja entra logado
```

O token volta no **fragmento** da URL (depois do `#`), que o navegador nao envia ao servidor
em requisicao nenhuma — e por isso que esse e o formato certo para um token. Ainda assim a
pagina limpa a barra de endereco, para nao sobrar no historico.

### 26.3 Recuperacao de senha

Mesma mecanica com `type: recovery`. O link volta com `type=recovery` no fragmento, a pagina
mostra "escolha uma senha nova", e salvar **derruba todas as outras sessoes** — que e o
ponto de trocar a senha.

### 26.4 A falha que eu quase deixei passar

Na primeira versao, se o e-mail falhasse depois da conta criada, a resposta era erro. Isso
deixaria a pessoa num beco: conta existe (entao cadastrar de novo da 409), e-mail nao chegou
(entao nao da para confirmar), e nenhuma tela oferecendo saida.

Corrigido: **depois que a conta existe, falha de e-mail nao e erro de cadastro.** A resposta
e sucesso com aviso, e a tela seguinte tem o botao de reenviar. E o link vai para o log do
servico como ultimo recurso.

### 26.5 O que piorou, dito com todas as letras

**Perdemos o segundo fator.** O desenho anterior exigia senha **e** um codigo do aplicativo
autenticador. Agora e so e-mail e senha, num site publico na internet.

Isso foi pedido explicitamente ("por enquanto... a seguranca vai ser e-mail e senha"), e o
risco esta contido pelo limite de tentativas, pela senha minima de 12 caracteres e por so um
endereco poder ter conta. Mas e um passo atras, e o GoTrue tem MFA pronto — quando quiser,
religar e trabalho pequeno.

### 26.6 A conta antiga foi removida

Havia uma conta local `Lucas`, criada as 11:42 pelo convite, com o **2FA nunca concluido** —
zero sessoes, zero conversas, zero pensamentos. Ela nao conseguia mais entrar (a rota antiga
deixou de existir) e, pior, fazia o site achar que ja tinha dono, bloqueando o cadastro novo.

Removida. Nenhum dado foi perdido porque nao havia dado nenhum. **O convite que eu tinha
mandado por e-mail nao vale mais** — o cadastro agora e pelo site.

### 26.7 Decisoes

| # | Decisao |
|---|---|
| D50 | Autenticacao pelo **Supabase/GoTrue**; sai o scrypt caseiro |
| D51 | O navegador **nunca** fala com o GoTrue; so `/auth/v1/verify` e publica |
| D52 | Sessao do navegador continua sendo **nossa**, em cookie opaco |
| D53 | Conta criada por `admin/generate_link`; cadastro do GoTrue fica desligado |
| D54 | E-mail sai pelo **nosso** remetente, com a cara do Thor |
| D55 | `LUK_OWNER_EMAIL` limita quem pode criar conta |
| D56 | **Sem segundo fator por enquanto** — decisao consciente, reversivel (§26.5) |
| D57 | Falha de e-mail apos a conta criada nao e erro de cadastro |

### 26.8 Verificado

Instancia de teste separada, com SMTP apontado para host invalido de proposito (o link sai
pelo log):

```
1) estado inicial              setup: true
2) cadastro                    conta criada
3) link de confirmacao         gerado, apontando para bolla.network
4) abrindo o link              Caddy deixou passar, redirecionou com access_token
5) trocar token por sessao     ok
6) sessao vale                 authed: true
7) login com e-mail e senha    ok
8) senha errada                HTTP 400
9) rota privada sem sessao     HTTP 401
10) segundo cadastro           HTTP 409
```

Usuario de teste apagado do Supabase ao fim.

---

## 27. O visual — nucleo reativo e rede neural (2026-10-25)

Pedido: "estilo Thor, desenhar a rede neural dele, a luz piscar quando fala, aumentar e
diminuir". Feito, e com uma regra que eu me impus: **nada de enfeite que minta.**

### 27.1 O nucleo (`core.js`)

Uma esfera em canvas que reage ao que o Thor esta fazendo de verdade. Dois valores mandam
no desenho:

| | O que e |
|---|---|
| **energia** (0 a 1) | sobe a cada pulso e **cai sozinha** |
| **estado** | define cor, velocidade dos aneis e o **piso** da energia |

Estados: `dormindo`, `ouvindo`, `pensando`, `falando`, `erro`.

**O piscar enquanto fala nao e um laco decorativo.** Cada pedaco de texto que chega pelo
WebSocket chama `pulsar(0.085)`. A energia sobe no pedaco e decai entre eles — entao a luz
pulsa **no ritmo real da escrita dele**. Texto rapido, luz agitada; pausa para pensar, luz
desce. O halo externo tem raio proporcional a energia, e e isso que faz ela "crescer e
diminuir".

O piso por estado garante que o pulso apareca como salto acima de uma base viva, em vez de
piscar do zero.

Detalhes que fazem parecer esfera e nao circulo: gradiente radial descentrado, brilho
especular no canto superior esquerdo, tres aneis com achatamento que oscila (dao a sensacao
de orbita em 3D) e 14 particulas em orbita — poucas de proposito, porque o efeito vem do
brilho e isto tambem roda em celular.

Um laco de animacao so atende todas as instancias da pagina: o nucleo da barra lateral, o da
tela de login e o do heroi sao **o mesmo ser** reagindo junto.

### 27.2 A rede neural (`neural.js`)

Aqui esta a parte que eu nao quis que fosse enfeite.

**Cada no e um pensamento que ele guardou de verdade. Cada aresta e uma ligacao que ele
afirmou.** As cores sao os tipos (fato, preferencia, projeto, pessoa, decisao). Os fixados
sao maiores e pulsam. Pensamento corrigido some da teia — mas continua no banco (§22).

**Rede vazia significa memoria vazia.** Quando nao ha nada guardado, ela desenha uma
constelacao fantasma, apagada, so para o painel nao parecer quebrado — e isso e visivelmente
diferente de uma teia com conteudo.

**Quando ele busca na memoria, sinais viajam pelas arestas.** O evento `tool` do WebSocket
dispara seis sinais: da para ver o pensamento atravessando a teia enquanto ele procura.

Posicao deterministica a partir do id do pensamento: a mesma memoria desenha no mesmo lugar
toda vez, entao a forma da teia vira algo reconhecivel com o tempo.

### 27.3 Dois bugs que o teste pegou

**1. O aviso de configuracao matava o heroi.** `addSystem()` chamava `clearEmpty()`, entao a
mensagem "falta a chave da IA" apagava o nucleo grande e a rede — justo na primeira tela, que
e a cara do produto. Agora o aviso entra **acima** do heroi, sem apagar nada.

**2. Canvas criado dentro de painel escondido nasce com 0x0.** O painel da teia comeca
`hidden`, entao as posicoes dos nos eram calculadas num espaco de 1x1 pixel e depois
grampeadas no canto. O painel abria **vazio**. Corrigido: a rede guarda se ja teve uma medida
util e **re-semeia as posicoes** na primeira vez que ganha tamanho de verdade.

O segundo e o tipo de bug que so aparece abrindo a tela — nenhum teste de API pegaria.

### 27.4 Acabamento

Paleta mais profunda (`#06060c`), superficies em vidro com `backdrop-filter`, titulos com
gradiente no texto, barra de rolagem fina combinando, e a caixa de escrever ganhando brilho
roxo enquanto ele pensa.

`prefers-reduced-motion` desenha **um quadro bonito e para**: quem pediu menos movimento nao
perde o visual, so a animacao. Aba escondida nao anima, para nao comer bateria no celular.

### 27.5 Verificado

Instancia de demonstracao com 10 pensamentos semeados, acessada por tunel SSH, conferida em
1150x720 e em 375x812.

Prova de que esta vivo e nao e imagem parada — amostragem dos pixels dos dois canvas com 900ms
de intervalo:

```
nucleo:  26756 -> 25555   mudou
rede:    29702 -> 30894   mudou
```

A demo foi desmontada e o usuario dela apagado do Supabase ao fim.

### 27.6 Decisoes

| # | Decisao |
|---|---|
| D58 | Nucleo em canvas, com energia que decai — pulso por pedaco de texto recebido |
| D59 | A rede neural **e a memoria real**; teia vazia significa memoria vazia |
| D60 | Busca na memoria dispara sinais visiveis atravessando a teia |
| D61 | Posicao do no e deterministica pelo id: a teia tem forma reconhecivel |
| D62 | `prefers-reduced-motion` desenha um quadro e para, sem perder o visual |

---

## 28. BollaNetwork, e-mails padronizados e convite por nivel (2026-10-25)

**BollaNetwork e o nome da empresa. Thor e o produto.** Os e-mails assinam BollaNetwork; a
interface continua sendo o Thor.

### 28.1 Um molde so para todos os e-mails

`emails.ts` passou a ter **uma moldura** que os tres e-mails (convite, confirmacao,
recuperacao) preenchem. Dois ganhos: a marca fica igual em qualquer mensagem, e um problema
de renderizacao conserta todas de uma vez.

Estrutura: marca BOLLANETWORK no topo, cartao escuro com o nucleo, titulo, corpo, botao,
rodape com o link em texto, e assinatura da empresa com o ano.

### 28.2 As regras de e-mail que o HTML respeita

Cliente de e-mail nao e navegador. O que esta no codigo e por isso:

| Regra | Por que |
|---|---|
| Layout em **tabela** | flexbox e grid nao existem no Outlook |
| Todo estilo **em linha** | `<style>` no topo e descartado por varios clientes |
| Cor de fundo na tabela **e** na celula | o Outlook ignora uma das duas |
| Gradiente sempre com **cor solida embaixo** | quem nao suporta gradiente mostra a cor |
| Largura em **pixel**, nunca em porcentagem solta | porcentagem quebra no Gmail |
| **Texto de previa escondido** no topo | e o que aparece na lista da caixa de entrada |
| Versao em **texto puro** sempre junto | cliente sem HTML, leitor de tela, e filtro de spam |

### 28.3 Convite em vez de cadastro

Antes: a pessoa ia ao site e criava a conta com e-mail e senha. Agora existe o convite, e a
diferenca importa:

**No convite, o usuario nasce SEM senha.** Ele escolhe a dele no link. A senha nao passa por
quem convidou, nem pelo log, nem pela linha de comando. Quem convida nunca tem como saber a
senha de quem foi convidado — e isso continua valendo quando houver mais gente.

```bash
sudo -u luk LUK_ROOT=/opt/luk /usr/local/bin/node src/convidar.ts <email> [nivel]
```

O comando **confere o login no servidor de e-mail antes de criar o convite**, entao senha de
SMTP errada nao deixa convite orfao no banco.

### 28.4 Niveis de acesso — a fundacao, nao o predio

Hoje so existe `dono`. Mas o nivel ja e gravado em dois lugares:

- no **Supabase**, como metadado do usuario (`user_metadata.nivel`)
- no **espelho local**, na coluna `users.role`

A coluna entrou agora com uma migracao tolerante (`PRAGMA table_info` antes do `ALTER`,
porque o SQLite nao tem `ADD COLUMN IF NOT EXISTS` e o esquema roda inteiro a cada arranque).

**Nao construi sistema de permissao nenhum** — seria inventar regra sem caso de uso. O que
existe e o lugar onde a informacao mora, para que o dia de ter convidados nao exija migrar
conta nenhuma. O `convidar.ts` ja recusa um segundo "dono".

### 28.5 Como o link de convite se comporta

Conferido na pratica: o `/auth/v1/verify` devolve o fragmento com `type=invite` (alem de
`token_type=bearer`, que e outra coisa — ler o primeiro `type=` que aparecer na string da a
resposta errada; o cliente usa `URLSearchParams`, que separa certo).

Convite e recuperacao caem na **mesma tela** no site, porque nos dois casos a pessoa chega
sem senha valida. Muda so o texto: "Escolha sua senha" contra "Escolha uma senha nova".

### 28.6 Decisoes

| # | Decisao |
|---|---|
| D63 | **BollaNetwork** e a empresa; **Thor** e o produto. Os e-mails assinam BollaNetwork. |
| D64 | Uma moldura unica para todos os e-mails, com as regras de cliente de e-mail respeitadas |
| D65 | Cadastro por **convite**: o convidado nasce sem senha e escolhe a dele no link |
| D66 | Nivel gravado no Supabase e no espelho local desde ja; **sem** sistema de permissao ainda |
| D67 | `convidar.ts` confere o SMTP antes de criar o convite — nada de convite orfao |

---

## 29. O painel refeito como HUD (2026-10-25)

O visual anterior foi recusado, e com razao. Ele era um **painel escuro bonito** — vidro,
gradiente roxo, cantos arredondados. Isso e linguagem de produto SaaS. Nao e HUD.

### 29.1 O que a pesquisa ensinou

**Jayse Hansen**, que desenhou as HUDs do Homem de Ferro e dos Vingadores, conta que a
producao recusava enfeite: *o supervisor de efeitos e o diretor perguntavam para que servia
cada elemento na tela.* O filme em 3D tambem obrigava: com tudo em foco e legivel, nada podia
ser so decoracao.

E a gramatica do genero e especifica, nao generica:

| Elemento | Regra |
|---|---|
| Traco | **0,5 a 1px**. Linha grossa mata o efeito. |
| Geometria | aneis concentricos, arcos, coordenadas polares |
| Colchetes de canto | *"assinatura barata, legibilidade alta"* |
| Marcacoes | precisam de **hierarquia** — sem diferenca entre as marcas, nao da para medir nada |
| Paleta | monocromatica com brilho; **ciano sobre preto** |
| Tipografia | monoespacada, caixa alta, espacada |
| Movimento | aneis giram **enquanto numeros mudam** |

Um alerta util: anel, pizza e menu radial *parecem* parentes mas afirmam coisas diferentes.
A forma tem de combinar com a funcao.

### 29.2 Onde eu tinha errado

O orbe anterior era bonito e **nao queria dizer nada**. Girava sempre igual, independente do
que o Thor soubesse ou estivesse fazendo. Era exatamente o enfeite que o diretor cortaria.

A paleta tambem: roxo e vidro puxam para outro genero. HUD e ciano, traco fino e preto.

### 29.3 A regra que eu me impus

**Nenhum anel e enfeite. Cada um le um numero de verdade:**

| Elemento | O que representa |
|---|---|
| anel externo com marcacoes | **quantos pensamentos** ele tem guardados (acesas de 60) |
| arco medidor | **quanto do prompt veio do cache** — a economia do §22, visivel |
| anel segmentado | gira pelo estado; segmentos acesos = **voltas de ferramenta** do turno |
| raios internos | **energia** — pulsam no ritmo da fala |
| nucleo | o **estado**, pela cor |
| linha de varredura | aparece so quando ele esta **processando ou ouvindo** |

E os mesmos numeros aparecem **escritos embaixo do reator**: memoria, cache, conversas,
buscas. Quem olhar o anel e depois o numero confere que batem. Nada ali e enfeite que mente.

### 29.4 A casca

- **Colchetes de canto** nos cartoes e no campo de escrever
- **Grade** fina de 44px e **varredura** horizontal por cima de tudo, bem apagadas — a
  textura que diz "isto e um painel, nao uma pagina"
- Tudo que e rotulo virou **monoespacada, caixa alta, com espacamento**
- Cantos de 2px: quase reto, que e o que HUD usa
- Erro virou **ambar**, que e a cor de alerta do genero, nao vermelho de formulario
- A rede neural trocou roxo por ciano e ambar, para ficar na mesma familia

### 29.5 Verificado

Instancia de demonstracao com 12 pensamentos semeados, acessada por tunel SSH:

- entrada, tela de instrumento, leituras batendo com a memoria semeada (12)
- mensagem enviada: titulo vira o texto, estado muda, erro aparece em ambar
- conferido em 800x500 e em 375x812

A demo foi desmontada e o usuario dela apagado do Supabase.

### 29.6 Decisoes

| # | Decisao |
|---|---|
| D68 | O painel segue a **gramatica de HUD**: traco fino, anel concentrico, colchete de canto, monoespacada, ciano sobre preto |
| D69 | **Nenhum elemento decorativo.** Todo anel le um numero real, e o numero aparece escrito ao lado |
| D70 | Paleta ciano com ambar para alerta; roxo saiu |
| D71 | Grade e varredura por cima de tudo, bem apagadas, como textura de painel |
| D72 | `app/deploy/demo.sh` fica no repositorio: sobe uma instancia com memoria semeada para conferir visual sem tocar na real |

---

## 30. Voz: clonar ou treinar? (2026-10-25)

Pergunta: tem audios de modelo, usa RunPod ou treina na GPU do laptop, quanto demora?

**Resposta curta: nao treine nada ainda.** Clonar nao precisa de treino, e provavelmente
resolve.

### 30.1 O hardware

| | |
|---|---|
| Laptop | **RTX 4050 Laptop, 6 GB de VRAM** (Ada, compute 8.9), Ryzen 7 7735HS 8c/16t, 15 GB de RAM |
| Servidor | Xeon 8 threads, 31 GB de RAM, **sem GPU** (§12) |

Os 6 GB sao o numero que manda. Dao e sobram para **rodar** modelo de voz; sao apertados para
**treinar** modelo grande.

### 30.2 A distincao que muda tudo

| | Clonar (zero-shot) | Treinar (fine-tune) |
|---|---|---|
| Audio necessario | **~10 segundos** | horas, **transcritas** |
| Treino | **nenhum** | horas a dias de GPU |
| Tempo ate ouvir | **minutos** | dias, contando preparar o dataset |
| RunPod? | desnecessario | aqui sim faria sentido |

Modelo moderno de voz ja chega sabendo imitar: voce da dez segundos de referencia e ele fala
com aquela voz. **Treinar so compensa se o clone nao ficar bom o bastante** — e isso so da
para saber testando o clone primeiro.

### 30.3 O candidato

**Chatterbox, da Resemble AI** — licenca MIT, e tem uma versao dedicada ao **portugues do
Brasil** (`ResembleAI/Chatterbox-Multilingual-pt-br`, 500M parametros), alem da multilingue
de 23 idiomas.

Descartados e por que:

| Modelo | Problema |
|---|---|
| XTTS v2 (Coqui) | licenca **nao comercial** |
| Fish Speech | pede 12 GB+ de VRAM; licenca restritiva |
| Voxtral (Mistral) | 16 GB de VRAM; CC BY-NC |
| Qwen3-TTS | ~8 GB de VRAM — apertado nos 6 GB |
| Kokoro, Piper | rapidos em CPU, mas **nao clonam voz** |

### 30.4 A armadilha que eu quase recomendei errado

O Chatterbox tem uma variante **Nano (110M)** que roda **3x mais rapido que tempo real em 8
nucleos de CPU** — exatamente o que o nosso servidor sem GPU precisaria.

**Mas a Nano e so ingles.** A versao pt-br e a de 500M, quase cinco vezes maior.

Entao o problema real nao e clonar a voz. **E onde ela vai rodar depois.** Clonar no laptop e
facil; servir 24 horas num servidor sem GPU e a pergunta em aberto, e nao da para responder
por estimativa: tem de medir o modelo de 500M nos 8 threads do Xeon e ver se da tempo real.

### 30.5 O caminho recomendado, em ordem

1. **Testar o clone no laptop** — meia hora, quase tudo download. Responde a pergunta que
   importa: a voz ficou boa?
2. **Medir o mesmo modelo na CPU do servidor.** Esse numero decide a arquitetura: se der
   tempo real, o Thor fala 24h sem GPU. Se nao der, as opcoes sao API paga, GPU alugada
   servindo (~US$ 250/mes, §11) ou voz de prateleira mais simples.
3. **Fine-tune so se o clone decepcionar.** E ai no RunPod, nao no laptop: 6 GB da para
   treinar com aperto, e os relatos da comunidade vao de 2-3 horas (dataset pequeno) a mais
   de um dia (8h de audio em RTX 4080). O custo maior normalmente nao e o treino — e
   **transcrever o audio**.

### 30.6 O que eu preciso saber dos audios

- **quanto tempo** tem no total
- **de quem e a voz** — sua, de outra pessoa, de algum personagem
- **qualidade**: gravado em ambiente silencioso ou com ruido e musica de fundo
- se ja existe **transcricao** (so importa se formos treinar)

Dez segundos limpos valem mais que dez minutos com ruido. Para o clone, a qualidade da
referencia importa mais que a quantidade.

### 30.7 Decisoes

| # | Decisao |
|---|---|
| D73 | **Clonar antes de treinar.** Zero-shot primeiro; fine-tune so se decepcionar |
| D74 | Candidato: **Chatterbox pt-br** (MIT, 500M) — roda folgado nos 6 GB do laptop |
| D75 | A pergunta em aberto nao e clonar, e **onde a voz roda 24h** sem GPU no servidor |
| D76 | Medir o modelo na CPU do Xeon antes de decidir arquitetura de voz |

---

## 31. Voz: medicoes reais (2026-10-25)

### 31.1 Os audios enviados

| arquivo | duracao | volume medio |
|---|---:|---:|
| amostra 1 | 16,8s | -23,3 dB |
| amostra 2 | 18,9s | -29,0 dB |
| amostra 3 | 12,6s | -34,6 dB |
| amostra 4 | 21,0s | -26,6 dB |
| **total** | **69,3s** | |

Todos mono, 44,1 kHz, MP3 a 128 kbps.

**Isso ja responde "clonar ou treinar": clonar, sem escolha.** Sessenta e nove segundos sao
de sobra para clonagem (precisa de ~10s) e **longe do minimo para treinar** — fine-tune de
voz pede horas de audio transcrito. Nao e questao de GPU nem de dinheiro: nao ha material.

Observacao de qualidade: os niveis variam 11 dB entre a amostra mais alta e a mais baixa.
Normalizar antes de usar como referencia ajuda o clone a ficar consistente.

### 31.2 Transcricao no servidor — medido

`faster-whisper`, int8, 8 threads do Xeon, nos audios de verdade (69,3s):

| modelo | RTF | 5s de fala em | portugues |
|---|---:|---:|---|
| tiny | **0,071** (14x) | 0,35s | erra: escreveu *"estomico"* no lugar de *"topicos"* |
| **base** | **0,133** (7,5x) | **0,67s** | **correto** |
| small | 0,410 (2,4x) | 2,05s | correto, sem ganho visivel sobre o base |
| medium | 1,189 (0,8x) | 5,95s | correto, mas **mais lento que tempo real** |

**O `base` e o ponto certo.** O `tiny` economiza pouco e erra palavra. O `small` custa tres
vezes mais pelo mesmo texto. O `medium` nao serve para conversa ao vivo nessa CPU.

Com RTF 0,133, a transcricao consome cerca de **13% da capacidade** da maquina em tempo real.
Sobra folga — o gargalo nao vai ser a transcricao.

### 31.3 Sintese no servidor — medido

Mesma maquina, mesmos 8 threads, mesma frase ("Bom dia, Lucas. O servidor esta estavel...").

| modelo | tamanho | clona voz? | RTF | 7s de fala em |
|---|---|---|---:|---:|
| **Chatterbox pt-br** | 500M | **sim** | **15,21** | **106 segundos** |
| **Piper pt-BR** | 61 MB | nao | **0,100** | **0,66 segundo** |

**Cento e cinquenta e duas vezes de diferenca.** O modelo que clona e 15x **mais lento** que
tempo real; o Piper e 10x mais rapido.

Isso encerra a discussao: **o modelo que clona nao roda no servidor.** Nao e questao de
ajuste nem de quantizacao — 106 segundos para 7 de fala esta a duas ordens de grandeza do
necessario.

### 31.4 O orcamento de CPU para conversa ao vivo

| etapa | RTF | % da maquina |
|---|---:|---:|
| transcricao (whisper base) | 0,133 | 13% |
| sintese (Piper) | 0,100 | 10% |
| **total** | | **~23%** |

Sobra mais de tres quartos da maquina. Com o Chatterbox no lugar do Piper, a mesma conta da
**1.521%** — quinze maquinas.

Latencia estimada de um turno (fala de 5s):

```
fim de turno (VAD)        ~0,30s
transcricao               ~0,67s
LLM, primeira resposta    ~0,5 a 1,5s   (rede, nao CPU)
primeira frase falada     ~0,20s
--------------------------------------
ate ouvir a resposta      ~1,7 a 2,7s
```

### 31.5 A solucao: destilacao

Juntando tudo — 69 segundos de audio, laptop com GPU, servidor sem GPU, US$ 10 de orcamento:

```
  1. CLONAR          no laptop (RTX 4050)
     Chatterbox + 10s de referencia -> a voz dele, sem treino
                    |
  2. GERAR          no laptop, algumas horas
     milhares de frases em portugues, faladas na voz clonada
     o texto e NOSSO -> ja vem transcrito, de graca
                    |
  3. TREINAR        no RunPod, ~US$ 10
     Piper aprende a voz a partir do corpus sintetico
                    |
  4. SERVIR         no servidor, para sempre
     61 MB, 10x tempo real, 10% da CPU, sem GPU
```

**Por que isso resolve o que parecia impossivel:** os 69 segundos nao davam para treinar. Mas
eles dao para *clonar*, e o clone gera material ilimitado. O passo que normalmente custa caro
— transcrever horas de audio — sai de graca, porque nos escrevemos o texto.

Ingles depois: mesmo processo, o Chatterbox faz clonagem entre idiomas. Dois modelos Piper,
um por idioma, ~60 MB cada.

**O preco:** a voz final fica congelada. Perde expressividade e controle de emocao, e a
qualidade fica limitada a do clone. Em troca, roda 24h de graca.

### 31.6 A alternativa honesta

Se a voz nao precisar ser a dele: **uma voz Piper de prateleira funciona hoje**, de graca,
sem treinar nada, a 10x tempo real. Foi a que eu usei na medicao. A escolha e entre
identidade e esforco, nao entre funcionar e nao funcionar.

### 31.7 Decisoes

| # | Decisao |
|---|---|
| D77 | **Treinar com os audios atuais e impossivel** — 69s contra as horas necessarias |
| D78 | Transcricao: **whisper base**, 7,5x tempo real, 13% da CPU |
| D79 | **O modelo que clona nao roda no servidor**: RTF 15,2, medido |
| D80 | Caminho: **clonar no laptop, destilar para Piper, servir na CPU** |
| D81 | Os US$ 10 do RunPod vao para o **passo 3** (treinar o Piper), nao para clonar |

### 31.8 O erro que estragou o primeiro clone

O primeiro clone saiu ruim, e a causa era minha.

**Eu dei ao modelo uma referencia de 16 kHz.** Os originais sao 44,1 kHz. Eu tinha convertido
para 16 kHz **para medir o Whisper** — que trabalha nessa taxa — e reaproveitei o mesmo
arquivo como referencia de voz.

O codigo do Chatterbox nao deixa duvida:

```python
S3GEN_SR = 24000
...
s3gen_ref_wav, _sr = librosa.load(wav_fpath, sr=S3GEN_SR)   # carrega a 24 kHz
ref_16k_wav = librosa.resample(..., target_sr=S3_SR)        # e deriva a de 16 kHz
```

Ele carrega a referencia a **24 kHz** — e e dela que sai o timbre. Dando 16 kHz, o `librosa`
so interpolou de volta para 24: nao inventou nada. **Tudo acima de 8 kHz foi entregue vazio**
— o brilho, as sibilantes, o "ar" da voz. O modelo clonou uma voz abafada porque foi uma voz
abafada que eu mostrei a ele.

**A licao:** audio para transcricao e audio para clonagem tem exigencias opostas. O Whisper
joga fora tudo acima de 8 kHz de proposito, porque nao precisa. O clone vive justamente
dessa faixa. Reaproveitar o arquivo de um no outro destroi exatamente o que importa.

### 31.9 Como as referencias foram refeitas

Dos MP3 originais, nao dos WAV do teste:

| passo | por que |
|---|---|
| **24 kHz** mono | e a taxa que o modelo carrega; preserva ate 12 kHz |
| **`loudnorm` I=-18 LUFS** | as amostras variavam 11 dB entre si; agora variam 2 |
| **silencio aparado** nas pontas | silencio na referencia vira pausa e respiracao estranha no clone |

### 31.10 Pendente

Comparar de ouvido os tres: referencia de 16 kHz, de 24 kHz, e de 24 kHz mais longa (21s).
Se ainda nao estiver bom, os proximos passos sao, em ordem de impacto:

1. **Gravacao nova e limpa** — 30 a 60 segundos, ambiente silencioso, sem compressao de MP3.
   E o que mais muda o resultado; nenhum ajuste compensa referencia ruim.
2. **Ajustar `exaggeration` e `cfg_weight`** (padrao 0,5 cada) e `temperature` (0,8).
3. **Testar o pacote pt-br dedicado** em vez do multilingue.

### 31.11 Por que ainda sobravam erros pequenos

Investigadas duas hipoteses.

**Hipotese 1: a referencia ainda estava pobre. DESCARTADA.**

Medi o espectro dos originais por faixa:

| faixa | amostra 1 | amostra 4 |
|---|---:|---:|
| 300 Hz – 3 kHz (fala) | -27,4 dB | -31,2 dB |
| 8 – 12 kHz (brilho) | -47,1 dB | -47,2 dB |
| 15 – 20 kHz | **-60,2 dB** | **-60,5 dB** |

Acima de 15 kHz nao ha nada — e o corte do MP3 a 128 kbps. Mas a referencia de 24 kHz so
carrega ate 12 kHz (Nyquist), e ate la o audio tem conteudo. **A referencia ja esta
aproveitando tudo que o MP3 guardou.** Melhorar isso exige gravacao nova, nao conversao.

**Hipotese 2: o texto estava sem acento. CONFIRMADA de ouvido pelo Lucas.**

O texto que eu usei em todas as medicoes era:

> "O servidor **esta estavel** (...) **Voce** tem uma **reuniao**"

O correto:

> "O servidor **está estável** (...) **Você** tem uma **reunião**"

Em portugues isso nao e cosmetico — muda a palavra:

| escrito | o modelo le | deveria ler |
|---|---|---|
| `esta` | **ES**-ta (demonstrativo) | es-**TÁ** (verbo) — **tonica trocada** |
| `estavel` | tonica na silaba errada | es-**TÁ**-vel |
| `Voce` | vogal final aberta | vogal fechada |
| `reuniao` | **sem nasalizacao** | reuni-**ÃO** — ditongo nasal |

O modelo le o que esta escrito. Sem acento ele acentua a silaba errada e perde a
nasalizacao — e e exatamente isso que soa como "errinho".

**A causa raiz de eu ter escrito assim:** eu vinha montando os testes dentro de heredoc de
shell, que ja tinha comido barra invertida e aspas antes (§22.3, §24.5), e evitei acento por
precaucao. A precaucao estragou o teste. A solucao foi escrever o script como arquivo e
enviar por `scp`, que preserva UTF-8.

### 31.12 Regra para o Thor

**O texto que vai para a voz precisa estar ortograficamente correto, com acento.** Isso vira
requisito do sistema, nao detalhe de teste: se o LLM devolver texto sem acento, a fala sai
com tonica errada. Como o modelo escreve portugues correto por padrao, basta nao estragar o
texto no caminho — nenhuma normalizacao que remova acento entre o LLM e o TTS.

### 31.13 O que ainda da para melhorar, em ordem

1. **Gravacao nova, sem MP3** — 30 a 60s em WAV, ambiente silencioso. E o unico caminho para
   recuperar o que a compressao a 128 kbps ja jogou fora.
2. **`temperature` e `cfg_weight`** — padrao 0,8 e 0,5. Baixar a temperatura para 0,6 deixa a
   leitura mais firme e menos variada; subir o `cfg_weight` prende mais a referencia.
3. **Pacote pt-br dedicado** (`Chatterbox-Multilingual-pt-br`) em vez do multilingue.
4. **Frases curtas** — modelo autorregressivo acumula erro ao longo da geracao. Dividir por
   frase e concatenar costuma sair mais limpo que gerar um paragrafo inteiro. E tambem e o
   que a conversa ao vivo quer, porque permite comecar a falar antes de terminar de gerar.

### 31.14 Montando o pacote pt-BR dedicado

O `ResembleAI/Chatterbox-Multilingual-pt-br` nao e um modelo completo: traz so as pecas do
idioma. O resto vem do modelo base. E `from_local` espera **nomes de arquivo fixos**, entao e
preciso montar um diretorio juntando as duas origens:

| arquivo esperado | de onde veio |
|---|---|
| `t3_mtl23ls_v2.safetensors` | pacote pt-br (`t3_pt_br.safetensors`, renomeado) |
| `s3gen.pt` | **modelo base** — ver abaixo |
| `grapheme_mtl_merged_expanded_v1.json` | pacote pt-br |
| `ve.pt`, `conds.pt` | modelo base |

**O tropeco:** usar o `s3gen_v3.pt` do pacote pt-br quebra com
`RuntimeError: Error(s) in loading state_dict for S3Token2Wav`. A versao instalada da
biblioteca constroi a classe do vocoder v2, e o pacote traz o v3. Pegando o vocoder do modelo
base e usando do pacote so o T3 — que e a parte especifica do idioma — carrega e gera.

### 31.15 Um aviso do proprio modelo que explica errinho

Durante a geracao apareceu, do analisador interno do Chatterbox:

```
forcing EOS token, long_tail=False, alignment_repetition=False, token_repetition=True
```

Ele **detectou repeticao de token e cortou a geracao a forca**. Ou seja: o modelo as vezes
entra em laco e o proprio codigo o interrompe. Isso sai como uma silaba arrastada ou um fim
de frase abrupto — mais um motivo pelo qual **gerar frase a frase sai mais limpo**: quanto
menor o trecho, menos chance de entrar em laco, e um trecho ruim nao contamina o resto.

### 31.16 Decisoes

| # | Decisao |
|---|---|
| D82 | **Texto para a voz tem de estar acentuado.** Nenhuma etapa entre o LLM e o TTS pode normalizar removendo acento. Confirmado de ouvido. |
| D83 | Gerar **frase a frase**, nao o paragrafo inteiro: menos chance de laco, e permite comecar a falar antes de terminar |
| D84 | Pacote pt-br monta com o T3 dele e o vocoder do modelo base; o vocoder v3 dele nao carrega nesta versao |

### 31.17 Ferramenta de avaliacao de referencia

`voz/avaliar.sh` + `voz/gerar-amostras.py`, instalados no servidor.

```bash
bash voz/avaliar.sh <pasta-com-audios>
```

Para cada arquivo: mede duracao, nivel e **conteudo espectral por faixa**, da um veredito,
prepara a referencia como o modelo quer (24 kHz, loudness igual, silencio aparado) e gera uma
amostra clonada.

Ela existe por causa do §31.8: eu perdi uma rodada inteira de testes por mandar ao modelo um
arquivo de 16 kHz que era sobra do teste de transcricao. Rodando a ferramenta nos proprios
audios daquele erro, ela acusa:

```
amostra1.wav   -23.3dB   8-12kHz: -91.0dB   ->  TAXA BAIXA (16000 Hz); sem brilho;
amostra1.mp3   -23.3dB   8-12kHz: -47.1dB   ->  ok
```

**-91 dB na faixa de 8 a 12 kHz e silencio absoluto.** O veredito agora aparece antes de
gastar dois minutos gerando.

A frase de teste e fixa e acentuada, e a geracao e frase a frase — as duas coisas que a §31
mostrou que importam.

### 31.18 Roteiro de gravacao

`voz/frases-para-gravar.md`: dez frases no registro do assistente, escolhidas para cobrir os
sons do portugues que o clone precisa ouvir — nasais (`ão`, `õe`, `ã`, `nh`), R forte e
brando, `lh`, `ch`/`x`, vogais abertas e fechadas, numeros falados, uma pergunta e uma lista
com pausas.

Duas orientacoes que valem mais que o resto:

- **WAV, nao MP3.** A compressao a 128 kbps dos audios atuais ja comeu tudo acima de 15 kHz,
  e isso nao volta por conversao.
- **Ritmo normal, sem caprichar na diccao.** O clone copia o estilo junto com o timbre;
  gravar declamando faz o Thor soar artificial.

| # | Decisao |
|---|---|
| D85 | `voz/avaliar.sh` da o veredito da referencia **antes** de gerar — o erro do §31.8 nao se repete em silencio |
| D86 | Roteiro de gravacao com cobertura fonetica, no registro do assistente |

### 31.19 Segunda leva de audios: medida, e pior

Dois arquivos novos, medidos antes de gerar:

| | taxa | duracao | 8–12 kHz | compressao |
|---|---|---:|---:|---|
| novo 1 | 44,1 kHz | 23,4s | **-54,6 dB** | 128 kbps |
| novo 2 | 44,1 kHz | 24,0s | **-56,5 dB** | 128 kbps |
| *originais* | *44,1 kHz* | — | *-47 dB* | *128 kbps* |

**Os novos tem 7 a 9 dB menos brilho que os antigos.** Mais abafados, nao melhores — e ainda
em MP3 a 128 kbps.

O padrao do nome dos arquivos (`thor-PT-BR-2-<data>-<n>-<texto da frase>`) indica exportacao
de uma ferramenta de geracao, nao gravacao. Se for isso, estamos clonando **uma copia
comprimida de uma voz ja sintetica** — perda em dois lugares, as duas irreversiveis.

### 31.20 O caminho que quebra o teto

O laptop tem **OBS Studio** instalado e um **Light Up USB Streaming Mic**. Essa dupla grava
PCM sem compressao.

Importante: **o Gravador de Voz do Windows nao serve** — salva em `.m4a`, comprimido. E a
armadilha obvia para quem vai "gravar em WAV" e usa o que ja esta no sistema.

Configuracao escrita em `voz/frases-para-gravar.md`: formato WAV, codificador PCM, 48 kHz
mono, so o Mic/Aux ativo no mixer (silenciar o audio do desktop), picos perto de -6 dB.

| # | Decisao |
|---|---|
| D87 | Medir a referencia **antes** de gerar virou rotina — pegou a regressao da segunda leva em segundos |
| D88 | Gravar com OBS em PCM; o Gravador de Voz do Windows esta explicitamente descartado |

### 31.21 A voz vem de um site de geracao — o plano muda

Confirmado: os audios nao sao gravacao, sao gerados em outro site. Isso muda o desenho.

**A cadeia atual perde em tres lugares:**

```
  site gera a voz  ->  MP3 128 kbps  ->  nosso clone  ->  destilacao em Piper
       (1)                 (2)              (3)              (4)
```

Cada seta joga fora um pouco. Hoje estamos no passo 3 clonando o que sobrou do passo 2.

**Duas dessas perdas sao removiveis:**

| perda | como sumir com ela |
|---|---|
| MP3 a 128 kbps | exportar do site em **WAV**, se ele oferecer |
| nosso clone | **pular o passo 3**: se o site gera quanto a gente quiser, ele mesmo pode gerar o corpus de treino |

A segunda e a mais importante e eu nao tinha visto antes. O plano original clonava a voz
porque so havia 69 segundos dela. **Se o site gera sob demanda, nao ha limite de material** —
entao o professor da destilacao passa a ser o site, nao o nosso clone do site.

```
  ANTES:  69s de audio -> clonar -> gerar corpus -> treinar Piper
  AGORA:  site gera o corpus direto -> treinar Piper
```

Some uma geracao inteira da cadeia, e com ela todo o erro que ela introduzia. O Chatterbox
deixa de ser necessario no caminho de producao.

### 31.22 A pergunta que precisa ser respondida antes de investir

**Os termos de uso do site permitem usar o audio gerado para treinar outro modelo?**

Boa parte dos servicos de voz proibe isso explicitamente — e a destilacao e exatamente
"treinar um modelo a partir da saida deles". Nao e detalhe juridico distante: se o Thor vier a
ser usado fora de um contexto pessoal, isso vira exposicao real.

Tres caminhos, em ordem de seguranca:

| caminho | voz | risco | esforco |
|---|---|---|---|
| **Gravar a propria voz** | do Lucas | nenhum | 10 minutos de gravacao |
| **Voz de licenca aberta** como professor | generica | nenhum | zero |
| **Voz do site** | a escolhida | **depende dos termos** | medio |

| # | Decisao |
|---|---|
| D89 | Se o site gera sob demanda, ele vira o **professor direto** da destilacao — o clone sai da cadeia de producao |
| D90 | Exportar do site em **WAV**, nunca MP3 |
| D91 | **Conferir os termos do site** sobre treinar modelo com a saida, antes de gastar tempo ou credito |

---

## 32. Corpus de treino em producao (2026-10-25)

Decisao do Lucas: seguir com os audios que ele mandou. Executado.

### 32.1 A referencia escolhida

Das seis amostras, a ferramenta mediu o brilho de cada uma e escolheu a melhor:

```
amostra1.mp3   -47.1dB   <- escolhida
amostra4.mp3   -47.2dB
amostra2.mp3   -50.4dB
amostra3.mp3   -54.5dB
novo1.mp3      -54.6dB
novo2.mp3      -56.5dB
```

Preparada como `refs/professor.wav`: 24 kHz, loudness normalizado, silencio aparado.

### 32.2 O corpus de texto

`voz/corpus.py` compoe 300 frases a partir de moldes com lacunas, mais 20 fixas. Sai
variedade real de vocabulario e ritmo com pouco texto fonte.

O que o texto precisa ter, e por que:

| exigencia | motivo |
|---|---|
| variedade fonetica | todo som do portugues tem de aparecer muitas vezes, em posicoes diferentes |
| variedade prosodica | afirmacao, pergunta, lista, numero e nome proprio tem entonacao diferente |
| frases curtas (4 a 15 palavras) | frase longa faz o modelo entrar em laco |
| **texto acentuado** | sem acento a tonica sai errada (§31.11) |

Media final: 10,8 palavras por frase.

**Dois bugs corrigidos no caminho:**

- Frase saia como *"ontem. a campanha"* — minuscula depois de ponto interno. O modelo le isso
  como continuacao, com a entonacao errada. Agora capitaliza apos `.`, `!` e `?`.
- O verificador de acentos dava falso positivo em um terco das frases, porque checava `e` e
  `ja` — que existem **sem** acento (a conjuncao, e "ja era"). Restrito a palavras que sempre
  levam acento neste corpus.

### 32.3 A geracao

`voz/gerar-corpus.py`, em segundo plano no servidor, com `nice` para nao disputar CPU com o
Thor. Saida no formato LJSpeech, que e o que o treino do Piper espera.

Dois cuidados que vem do que ja deu errado:

- **Retoma de onde parou.** Na CPU cada frase leva ~80s; sao quase sete horas. Queda nao
  recomeca do zero.
- **Descarta frase torta.** O modelo as vezes entra em repeticao e o proprio codigo dele
  corta a geracao a forca — isso aparece como audio curto ou longo demais para o texto.
  Frase ruim no dataset **ensina o erro** ao modelo final.

Medido no arranque: 4 frases em 5,5 minutos. **300 frases ≈ 6,7 horas.** Carga em 5,7 de 8
threads, Thor continua ativo.

| # | Decisao |
|---|---|
| D92 | Seguir com os audios enviados; referencia escolhida por medicao de brilho |
| D93 | Corpus composto por moldes, nao escrito a mao — variedade com pouco texto fonte |
| D94 | Descartar automaticamente frase cuja duracao nao bate com a contagem de palavras |
| D95 | Geracao retomavel: sete horas de CPU nao podem depender de nada dar certo de primeira |

### 32.4 Treinar no laptop ou alugar GPU?

Medido no laptop:

| | |
|---|---|
| GPU | RTX 4050, 6141 MiB — **1409 MiB ja em uso**, sobram ~4,6 GB |
| WSL | **nao instalado** |
| CUDA toolkit | **nao instalado** (so o driver) |
| PyTorch | **nao instalado** |
| disco | 246 GB livres |
| temperatura em repouso | 48 °C |

**A GPU da conta.** O trabalho e um ajuste fino num modelo de 60 MB sobre ~300 amostras —
nao e treino do zero. Relatos da comunidade em placas equivalentes dao 2 a 4 horas.

**Mas o custo nao esta na GPU, esta no preparo.** Para treinar no laptop seria preciso:
instalar o WSL (com reinicio), instalar o PyTorch com CUDA (~3 GB), instalar as dependencias
do treino do Piper — incluindo `espeak-ng`, que no Windows puro da trabalho — e ainda caber
em 4,6 GB de VRAM, o que obriga lote pequeno e deixa o treino mais lento.

Soma: provavelmente **mais horas preparando do que treinando**. E com o laptop ocupado e
esquentando o tempo todo.

| | laptop 4050 | GPU alugada |
|---|---|---|
| capaz | **sim** | sim |
| VRAM util | 4,6 GB (lote pequeno) | 24 a 48 GB |
| preparo | WSL + CUDA + deps: horas | imagem pronta |
| treino | 2 a 4 horas | menos de 1 hora |
| custo | energia | ~US$ 1 a 3 |
| efeito colateral | laptop ocupado e quente | nenhum |

**Recomendacao: alugar.** Nao porque a 4050 seja fraca — ela nao e para esse tamanho de
trabalho —, mas porque o preparo no Windows custa mais que o treino, e os US$ 10 reservados
cobrem o job varias vezes.

O laptop volta a ser util depois, se a gente quiser iterar rapido em parametros: com o
ambiente ja montado, repetir um treino ali sai de graca.

| # | Decisao |
|---|---|
| D96 | Treinar em GPU alugada, nao no laptop — o gargalo e o preparo do ambiente, nao a placa |
| D97 | A 4050 fica como opcao para iterar depois, se valer montar o ambiente uma vez |

---

## 33. GPU alugada: fazer tudo la, nao so o treino (2026-10-25)

### 33.1 A mudanca de plano

A geracao do corpus na CPU do servidor estava em **8 frases em meia hora** — 17 horas para
as 300. Se vamos alugar GPU de qualquer forma, gerar na CPU e desperdicio: na GPU o mesmo
corpus sai em meia hora.

```
  ANTES:  corpus na CPU (17h)  ->  alugar GPU so para treinar (1h)
  AGORA:  alugar GPU  ->  gerar corpus (30min) + treinar (1h)  ->  encerrar
```

Mesmo custo de aluguel, 17 horas a menos de espera. O job na CPU fica rodando como reserva
ate o pod estar funcionando.

### 33.2 O que a documentacao do RunPod diz

| | |
|---|---|
| criar pod | `POST https://rest.runpod.io/v1/pods` |
| autenticacao | `Authorization: Bearer <chave>` |
| campos | `name`, `imageName`, `gpuTypeIds[]`, `gpuCount`, `containerDiskInGb`, `volumeInGb` |
| parar | `POST /v1/pods/{id}/stop` |
| encerrar | `DELETE /v1/pods/{id}` |
| CLI | `runpodctl pod create/stop/delete` |

**Dois avisos que mudam como a gente opera:**

- **Pod parado ainda custa** — a cobranca do volume continua. "Parar" nao e "nao pagar".
  Terminado o trabalho, **encerrar**, nao parar.
- **Encerrar apaga tudo** que nao estiver em volume de rede. O resultado do treino tem de ser
  baixado antes.

### 33.3 Como a chave e manuseada

`voz/runpod.sh`, instalado no servidor. A chave e lida de forma oculta e guardada em
`~/.runpod-key` com permissao 600.

Ela **nao passa pelo chat, nao entra na linha de comando, nao aparece em `ps` nem em log** —
mesmo padrao da senha do e-mail (§25.2). O script le o arquivo na hora de cada chamada.

```bash
ssh -t dedicated-1 'bash ~/runpod.sh guardar-chave'   # pede a chave, confere o acesso
bash ~/runpod.sh precos                               # GPUs e preco/hora
bash ~/runpod.sh listar                               # o que esta ligado e custando
bash ~/runpod.sh encerrar <id>                         # termina
```

O `guardar-chave` **testa a chave antes de dizer que deu certo**, para nao descobrir que ela
e invalida so na hora de criar o pod.

| # | Decisao |
|---|---|
| D98 | Gerar o corpus **na GPU alugada**, nao na CPU do servidor — mesmo custo, 17h a menos |
| D99 | Chave da API guardada no servidor em arquivo 600; nunca pelo chat |
| D100 | Ao terminar, **encerrar** o pod, nao parar — parado continua cobrando |

---

## 34. As maos do Thor no servidor (2026-10-25)

Ele deixou de ser so conversa: agora tem a ferramenta `executar`, que roda comando no
`dedicated-1` e le a saida.

### 34.1 A restricao que define o desenho

**Nao existe canal de aprovacao ainda.** Sem um "voce autoriza?" chegando ao Lucas, nao da
para deixar comando perigoso passar e perguntar depois. Entao a primeira versao e:

> amplo para LER, fechado para ESCREVER.

**Lista do que pode, nunca lista do que nao pode.** Lista de proibidos sempre esquece alguma
coisa; lista de permitidos erra para o lado seguro — o pior caso e o Thor dizer que nao sabe
fazer, nao que apagou algo.

### 34.2 As quatro camadas

| camada | o que barra |
|---|---|
| **systemd** | a unit ja roda como `luk`, sem sudo, com `ProtectSystem=strict` — so `/opt/luk/data` e gravavel |
| **programas permitidos** | ~45 comandos de consulta. O que nao esta na lista nao roda |
| **verbos proibidos** | `systemctl` e `docker` so consultam: `restart`, `stop`, `run`, `rm` sao recusados |
| **construcoes da shell** | redirecionamento, `$()`, crase, `&`, `sudo`, `curl`/`wget`, `rm`, `kill`, `reboot` |

Mais uma lista de **caminhos proibidos**: `.env`, `.ssh/`, chaves, `SETUP.txt`, `.runpod-key`.
Comando permitido lendo arquivo proibido e recusado.

### 34.3 O buraco que o teste achou

A primeira versao separava o comando **so por `|`**. Resultado:

```
date && python3 -c print(1)      ->  PASSAVA
```

Porque o unico programa conferido era o `date`; o que vinha depois do `&&` nunca era olhado.
O caso com `;` so era barrado **por acidente**, porque o ponto e virgula colava na palavra
(`uptime;` nao esta na lista) — com espaco antes, passaria tambem.

Corrigido separando por **todos** os separadores: `|`, `||`, `&&`, `;` e quebra de linha.

**A licao:** quem escreve lista de permissoes tem de pensar **como a shell le**, nao como a
frase parece. E so um teste adversarial encontra isso — a versao furada passou em 32 casos
antes de eu pensar em encadeamento.

### 34.4 Auditoria

Tabela `comandos` guarda **toda tentativa**, autorizada ou nao, com o motivo da recusa e a
saida. Auditoria e o que torna defensavel dar shell a um modelo: da para responder depois
"o que ele tentou fazer?".

Exposta em `GET /api/comandos`.

### 34.5 Verificado

38 casos, todos corretos. Passam: `uptime`, `df -h /`, `systemctl status luk`,
`journalctl -u luk -n 5 --no-pager`, `ps aux | grep node`, `docker compose ps`,
`free -h && df -h`.

Barrados, com o motivo: `rm -rf`, `systemctl restart`, `docker run`, `curl`, `cat` do `.env`,
`cat` da chave SSH, redirecionamento, `sudo`, `$(whoami)`, `sed -i`, `find -delete`, `chmod`,
`kill`, `reboot`, `nc`, `&` em segundo plano, e os encadeamentos acima.

| # | Decisao |
|---|---|
| D101 | Ferramenta `executar`: ampla para ler, fechada para escrever — porque nao ha canal de aprovacao |
| D102 | Permissao por **lista do que pode**, nunca lista do que nao pode |
| D103 | A separacao de trechos considera `\|`, `\|\|`, `&&`, `;` e nova linha — encadeamento era brecha |
| D104 | Toda tentativa vai para a tabela `comandos`, autorizada ou nao |
| D105 | Quando existir aprovacao (push no celular), escrever passa a ser possivel **mediante autorizacao** — nao antes |

---

## 35. O canal de aprovacao

A §34 terminava com uma restricao assumida: ler era amplo, escrever era fechado, **porque
nao havia a quem perguntar**. Esta secao remove essa restricao.

### 35.1 Tres niveis, nao dois

| Nivel | O que e | O que acontece |
|---|---|---|
| **livre** | consulta | roda na hora |
| **aprovar** | grava em `/opt/luk/data` ou `/tmp` | para, pergunta, roda so com o sim |
| **nunca** | o resto | nao roda nem com autorizacao |

### 35.2 O principio que define o nivel "nunca"

> **Aprovar so protege quando o que aparece e o que roda.**

Um cartao de aprovacao mostra um texto. Se o comando puder virar outra coisa na hora da
execucao, o sim foi dado para uma frase e cobrado em outra. Entao tudo que quebra essa
correspondencia cai em "nunca", **mesmo sendo util**:

- substituicao de comando e crase — o que roda se decide depois da leitura
- `&` — solta processo que sobrevive ao tempo limite e a decisao
- `crontab`, `at` — um sim de hoje passaria a valer todo dia
- `pkill` por padrao — o que morre depende do que estiver vivo
- `find -exec`, `xargs`, `env`, `timeout` — o comando real nao esta na linha
- `curl`, `wget`, `nc` — o cartao mostraria uma URL, e **ninguem distingue endereco
  legitimo de endereco de vazamento batendo o olho**. Pedir isso ao Lucas seria transferir
  a nossa falha de desenho para ele.

### 35.3 O cartao separa o fato da narrativa

O comando cru vem **em cima, grande, em monoespacada**. A justificativa que o modelo
escreveu vem **embaixo, menor, rotulada "ele disse"**, inserida como texto puro — nunca
como marcacao.

A razao e concreta: se um dia o Thor ler uma pagina envenenada, o pedido chega com uma
justificativa convincente. O que decide a aprovacao tem de ser **o que vai rodar**, nao a
historia contada em volta.

Ambar, nao ciano: no resto da tela ciano quer dizer "esta funcionando". Uma decisao parada
esperando o Lucas precisa destoar.

### 35.4 Falha fechada, sempre

Silencio nunca autoriza. Pedido vence em 120s e **vencido conta como negado**. Os estados
`negado` e `expirado` ficam separados no banco porque sao a mesma barreira mas significados
diferentes: so um deles quer dizer que o Lucas olhou.

Apertar **parar** tambem derruba o cartao. Sem isso, a volta do agente era abandonada mas o
botao continuava vivo, e um "autorizar" clicado depois rodaria o comando de um turno
cancelado.

### 35.5 Tres buracos encontrados na lista da §34

A revisao para escrever esta secao achou falhas na lista que ja estava **em producao e
aprovada em 38 casos**:

1. **Invocadores.** `xargs sh -c id` passava: a conferencia olhava so a primeira palavra do
   trecho, e `xargs` estava liberado. O `sh` que de fato rodava nunca era olhado. Mesma
   forma em `env sh -c id` e `command sh -c id`. **Removidos da lista.**
2. **Fuga interna de utilitario.** Todo utilitario de texto antigo e uma maquina virtual
   pequena, e tres sabiam executar: a funcao `system()` do `awk`, o modificador `e` do
   `sed`, e os comandos de ponto `.shell` e `.system` do `sqlite3`. Nenhum anuncia isso no
   nome.
3. **Opcao na forma com sinal de igual.** `--in-place` na lista nao pegava
   `--in-place=.bak`, que faz exatamente a mesma coisa. A conferencia passou a casar token
   exato **ou** prefixo.

### 35.6 Nome de programa e conferido em posicao de programa

As regras eram expressoes soltas sobre a linha inteira, e erravam dos dois lados:

- a palavra `env` casava dentro de `/opt/luk/.env`. O veredito saia certo — era caminho
  proibido de qualquer jeito — mas **pela regra errada**, e a mensagem e o que o Thor repete
  ao Lucas. "cat /opt/luk/.env" recusado com "esse programa executa outro" nao explica nada
  e manda quem for investigar para o lugar errado.
- `ps aux | grep node` era recusado como "interpretador". A palavra estava ali como **texto
  de busca**, nao como programa. Consulta legitima barrada.

Conferir na posicao de programa resolve os dois sem abrir brecha: um programa perigoso so
faz mal quando e ele que roda, e todo caminho indireto ate ele — invocador, interpretador,
substituicao de comando, `find -exec`, fuga interna — ja esta barrado por conta propria.

### 35.7 O que ainda nao da para fazer, e por que

**Reiniciar servico nao esta no nivel de aprovacao.** Como `luk` nao tem sudo,
`systemctl restart` seria recusado pelo sistema de qualquer jeito — pedir autorizacao para
algo que nao pode funcionar seria encenacao. Para isso falta uma regra de sudoers para
unidades especificas. **Decisao separada, nao tomada aqui.**

### 35.8 Verificado

90 casos de classificacao, todos corretos. E cinco de execucao real, que sao os que importam:

| Situacao | Resultado |
|---|---|
| autorizado | rodou, pasta criada |
| negado | nao rodou |
| sem resposta (venceu) | nao rodou |
| parar apertado | nao rodou |
| proibido | nao rodou, motivo em texto para o modelo explicar |

| # | Decisao |
|---|---|
| D106 | Tres niveis: livre, aprovar, nunca |
| D107 | "Nunca" e definido pelo principio **o que aparece tem de ser o que roda** |
| D108 | `curl`/`wget` ficam em "nunca" mesmo sendo uteis: auditar URL e falha de desenho nossa, nao tarefa do Lucas |
| D109 | O cartao separa comando cru (destaque) de justificativa do modelo (rotulada "ele disse") |
| D110 | Falha fechada: silencio e parar contam como negado |
| D111 | Escrever e permitido so em `/opt/luk/data` e `/tmp` — a mesma fronteira que o systemd ja impoe |
| D112 | Nome de programa e conferido em posicao de programa, nao na linha inteira |
| D113 | Reiniciar servico fica de fora ate existir regra de sudoers — aprovar o impossivel e encenacao |

---

## 36. O nome, o app e o repositorio

### 36.1 Ele se chama Thor

O agente foi Lucky, depois Luk, depois Jarvis, agora **Thor**. O que muda com o
nome e so o que aparece: interface, e-mails, a alma, os documentos.

**A infraestrutura continua `luk`** — `/opt/luk`, `luk.db`, a unit do systemd,
o usuario do sistema, o cookie de sessao. Renomear isso num servidor no ar
significa migrar caminho, permissao, unit e banco ao mesmo tempo, com risco
real de deixar o site fora do ar, em troca de nada que o Lucas veja. O nome que
importa e o que ele le.

### 36.2 A migracao da alma, e o erro de versiona-la por numero

A alma (o texto que define quem o agente e) mora no banco, e era semeada com
`if (!getSetting('soul'))`. Semear uma vez **nao e migrar**: o texto ficou
parado na versao anterior a ferramenta de comandos. O agente recebia a
ferramenta na chamada da API e **nao tinha no texto regra nenhuma sobre ela** —
nem o que podia, nem que existe autorizacao.

A primeira correcao foi marcar `soul_versao = 3`. Ela durou um deploy: quando o
nome mudou para Thor, a migracao pulou achando que ja tinha rodado, e a alma
continuou dizendo "Voce e o Jarvis".

**O numero respondia a pergunta errada.** A pergunta nao e "qual versao e
esta?", e sim **"este texto e nosso ou foi o Lucas que escreveu?"**. Guardar a
marca (hash) do texto que nos mesmos gravamos responde direto: se a alma
guardada bate com a nossa ultima semente, ninguem editou e da para atualizar;
se nao bate, e dele e nao se toca. A anterior fica sempre em `soul_anterior`.

### 36.3 O app de iPhone

`app/mobile`, Expo SDK 58. Duas telas: entrar e conversar. Sem biblioteca de
navegacao — para duas telas seria peso sem troco.

**A sessao e a mesma do site, por outro transporte.** Ela sempre foi um token
aleatorio guardado so como hash no banco; o cookie era apenas o veiculo. Entao
atender o app nao exigiu um segundo sistema de login:

| | site | app |
|---|---|---|
| onde fica | cookie `httpOnly` | Keychain do iPhone |
| como viaja | cookie automatico | `Authorization: Bearer` |
| quem le | ninguem, nem o JS da pagina | o app |

O token so volta no corpo da resposta quando o cliente manda `app: true`. No
site ele nunca passa por JavaScript.

### 36.4 O tiquete do websocket

WebSocket no iOS nao deixa pendurar cabecalho de forma confiavel, e a saida
obvia — token na URL — e ruim: **a URL vai inteira para o log do Caddy**, e um
token que vale meses ficaria escrito em texto puro no disco do servidor.

Entao o app troca a sessao por um **tiquete de 30 segundos, de uso unico**
(`GET /api/ws-ticket`) e conecta com ele. Se vazar no log, ja nao serve.

Verificado: Bearer entra, Bearer invalido nao, websocket sem credencial nao
abre, tiquete nao funciona duas vezes, sessao de teste removida no fim.

### 36.5 O cartao de aprovacao no celular

E aqui que o canal da §35 fica util de verdade: autorizar de onde voce estiver.
A hierarquia e a mesma — comando cru grande em cima, frase do Thor pequena e
rotulada embaixo — e no celular ela importa **mais**, nao menos: tela pequena,
pessoa na rua, e a tentacao de so bater o olho no texto amigavel e maior.

### 36.6 O repositorio

`https://github.com/LucasBolla94/ThorBollaNetwork.git`, **publico**.

Fora do versionamento de proposito:

- `amostras-voz/` e os audios em `voz/` — **nao e tamanho, e risco**. Com poucos
  segundos de audio limpo da voz de alguem da para clonar essa voz; num
  repositorio publico seria material pronto para golpe por telefone.
- `reference/` — repositorios de terceiros guardados para consulta (389 MB).
- `node_modules/` e todo arquivo de segredo.

`.gitattributes` forca LF em `.sh`, `.service`, `.py` e no `Caddyfile`: escrito
no Windows, executado no Linux, e script com CRLF falha no servidor com
"bad interpreter" — erro que aponta para o interpretador quando o problema e um
caractere invisivel no fim da primeira linha.

| # | Decisao |
|---|---|
| D114 | O agente se chama **Thor**; a infraestrutura continua `luk`, porque renomear servidor no ar e risco sem ganho |
| D115 | A alma e migrada por **marca do texto**, nao por numero de versao: a pergunta e "este texto e nosso ou dele?" |
| D116 | Alma anterior sempre guardada em `soul_anterior` antes de qualquer troca |
| D117 | O app usa a mesma sessao do site: `Bearer` + Keychain; o token so sai no corpo quando o cliente pede |
| D118 | Websocket do app abre com **tiquete de uso unico de 30s**, nunca com o token, porque URL vai para o log |
| D119 | Gravacoes de voz ficam fora do git: audio limpo da voz de alguem e material de clonagem |

---

## 37. Chegar nele de qualquer lugar

### 37.1 Por que o app Expo nao "fica no servidor"

O pedido foi deixar o app online no servidor para acessar fora do wifi. Nao da,
e vale registrar o motivo para nao se tentar de novo:

O que roda na maquina do Lucas com `expo start` e o **Metro**, um empacotador de
desenvolvimento. Ele observa arquivos, reconstroi a cada mudanca e serve pacote
de debug. Hospedar isso 24/7 seria usar ferramenta de oficina como peca de
carro: pesado, fragil, e exige o codigo-fonte no servidor.

Para um app nativo que abre de qualquer lugar existem dois caminhos, e os dois
tem porteiro:

| caminho | o que da | o que exige |
|---|---|---|
| EAS Build + TestFlight | icone de verdade, sem Expo Go | conta Apple Developer, US$99/ano |
| EAS Update + Expo Go | abre de qualquer rede | conta Expo (gratis), e o Expo Go instalado |

### 37.2 O que ja resolvia, e ninguem tinha usado

O site **ja era um app instalavel** e ninguem tinha instalado. Ele tem
`manifest.webmanifest` com `display: standalone`, `apple-touch-icon`,
`apple-mobile-web-app-capable`, service worker, HTTPS e dominio proprio. No
iPhone, "Adicionar a Tela de Inicio" poe um icone que abre sem barra de
navegador, de qualquer rede, sem App Store e sem custo.

Os PNGs do icone nao estao no repositorio de proposito: o `install.sh` gera os
tres tamanhos a partir do `icon.svg` com `rsvg-convert` a cada deploy. Uma fonte
de verdade, nao quatro arquivos para manter em sincronia.

### 37.3 A versao do cache deixou de ser escrita na mao

O service worker tinha `VERSION = 'luk-v3'` fixo no codigo, e na troca de nome
do agente ela **nao foi trocada junto**. Como a estrategia e rede-primeiro,
ninguem viu — mas offline o telefone serviria a casca antiga, e isso so
apareceria no pior momento possivel.

O problema nao e a versao errada, e **depender de alguem lembrar**. Agora o
`install.sh` deriva a versao do conteudo:

```sh
MARCA=$(cat web/app.js web/app.css web/index.html | sha256sum | cut -c1-12)
sed -i "s/^const VERSION = .*/const VERSION = 'thor-$MARCA';/" web/sw.js
```

Mudou arquivo, muda a marca, cai o cache velho. Ninguem precisa lembrar de nada.

### 37.4 Caber na tela nao e o mesmo que dar para usar

Medindo a pagina em 375px, o layout estava correto: sem rolagem horizontal,
nada vazando, cartao ocupando 327 de 375px. Mas os alvos de toque estavam
pequenos demais:

| elemento | antes | agora |
|---|---|---|
| campo de e-mail | 39px | 50px |
| campo de senha | 39px | 50px |
| "Esqueci minha senha" | 24px | 44px |

A Apple pede 44pt de minimo. Abaixo disso o dedo erra — e errar justamente no
link de senha, que a pessoa procura quando ja esta irritada, e o pior lugar
para economizar pixel.

Junto veio uma armadilha especifica do iPhone: **campo com fonte menor que 16px
faz o Safari dar zoom sozinho ao receber o foco, e o zoom nao volta**. A tela
fica torta pelo resto da sessao. Os campos agora sao 16px no celular.

A regra vale por `pointer: coarse` tambem, nao so por largura: tablet e telefone
deitado sao largos e continuam sendo tocados com o dedo.

### 37.5 O que falta para ser util de verdade no bolso

**Aviso de aprovacao.** Hoje o cartao so aparece se o site estiver aberto. Um
pedido que vence em 120 segundos sem avisar ninguem e um pedido que vai vencer.
iOS 16.4+ aceita Web Push em PWA instalado, entao da para fazer sem App Store —
precisa de chaves VAPID, guardar a inscricao do aparelho e disparar quando o
pedido nasce.

| # | Decisao |
|---|---|
| D120 | O app Expo nao e hospedado no servidor: Metro e ferramenta de desenvolvimento, nao peca de producao |
| D121 | O acesso de qualquer lugar e o site instalado na tela de inicio — ja estava pronto, faltava instalar |
| D122 | A versao do cache do service worker e derivada do conteudo, nao escrita na mao |
| D123 | Alvo de toque minimo de 44px e campo de 16px no celular, por `pointer: coarse` e nao so por largura |

---

## 38. O app nativo, e o que "segundo plano" quer dizer no iOS

### 38.1 A correcao que motivou esta secao

A §37 trocou o pedido por outra coisa: o Lucas pediu o app Expo online, e eu
entreguei polimento do site. Ele apontou, e estava certo. O registro fica aqui
porque o erro nao foi tecnico, foi de obediencia — substituir o que foi pedido
pela minha leitura do que seria melhor.

A razao dada tambem estava pela metade. Eu apresentei duas saidas (TestFlight
ou Expo Go) como se fossem as unicas. Hospedar atualizacao propria e abrir no
Expo Go realmente nao serve mais — "legacy manifests" deixaram de ser aceitos
no SDK 51, e a mudanca de maio de 2026 restringiu o carregamento no Expo Go a
projetos do proprio dono, com pacote em JavaScript puro. Mas exportar para web
e servir do proprio servidor era possivel e eu nao disse.

Nada disso importou no fim: o Lucas quer **app nativo**, porque precisa do que
so app faz. E a resposta certa, e o motivo esta logo abaixo.

### 38.2 Nao existe app rodando em segundo plano no iOS

Esta e a parte que muda o desenho, e que quase todo mundo descobre tarde:

> **A Apple suspende o app pouco depois de voce sair dele. Nenhuma configuracao
> muda isso.**

O que existe de verdade:

| mecanismo | quando roda | serve para |
|---|---|---|
| **push** | o servidor empurra, o sistema entrega na hora | avisar. E imediato |
| tarefa em segundo plano | o iOS decide: 15 minutos ou 6 horas | sincronizar |
| audio / localizacao / VoIP | so com uso legitimo da funcao | outra coisa |

Um pedido de aprovacao vence em 120 segundos. **Nenhuma janela de tarefa em
segundo plano e pontual o bastante para isso.** Entao o aviso e push, e a
tarefa de fundo fica como rede de seguranca: se um push se perder, na proxima
janela que o iOS der o app confere se ficou pedido em aberto.

### 38.3 Como o aviso chega

O servidor empurra pelo servico do Expo em vez de falar direto com a Apple. A
diferenca pratica: **a chave da APNs fica guardada no EAS e nao neste
servidor** — um lugar a menos de onde ela pode vazar.

O corpo do aviso leva **o comando cru**, nao a justificativa do modelo. Mesma
regra do cartao (§35.3): quem decide tem de ver o que vai rodar, e a tela de
bloqueio e onde a tentacao de so bater o olho e maior.

O disparo mora em `index.ts`, escutando `aoMudar`, e nao dentro de
`aprovacao.ts`. O registro de aprovacoes anuncia o que aconteceu; quem se
importa, escuta. Se amanha o aviso tambem for por e-mail, entra outro ouvinte e
`aprovacao.ts` continua igual.

Token que a Apple recusa com `DeviceNotRegistered` e apagado na hora: aparelho
apagado ou app desinstalado nunca melhora sozinho, e guardar para sempre
significa tentar e falhar em toda aprovacao futura.

### 38.4 O que trava, e nao sou eu

O codigo esta pronto e a configuracao nativa foi validada: bundle
`network.bolla.thor`, modos de segundo plano `remote-notification`, `fetch` e
`processing`, os tres plugins aplicados. O que falta nao e codigo:

| o que | custo | para que |
|---|---|---|
| conta Apple Developer | **US$ 99/ano** | qualquer app num iPhone de verdade |
| conta Expo | gratis | `eas init`, que da identidade de push ao app |

**Nao ha contorno para a conta da Apple.** Instalar app em iPhone fisico exige
provisionamento assinado, e provisionamento exige conta paga. A unica excecao e
compilar pelo Xcode num Mac, com certificado que vence em 7 dias — o que nao
resolve uso diario e exige um Mac, que nao temos.

### 38.5 O que ainda nao foi testado

Push nao pode ser testado sem aparelho de verdade e sem as duas contas. Entao,
honestamente: o caminho esta escrito e conferido ate onde da, e **a primeira
prova real so acontece com o telefone na mao**.

| # | Decisao |
|---|---|
| D124 | Aviso de aprovacao e **push**, nao tarefa em segundo plano: 120 segundos nao cabem numa janela que o iOS agenda quando quer |
| D125 | A tarefa em segundo plano fica como rede de seguranca para push perdido, e isso esta dito no codigo para ninguem confundir os papeis |
| D126 | O push sai pelo servico do Expo, para a chave da APNs nao morar neste servidor |
| D127 | O corpo do aviso leva o comando cru, nunca a justificativa do modelo |
| D128 | O disparo escuta `aoMudar` de fora; `aprovacao.ts` nao sabe que push existe |
| D129 | Token recusado com `DeviceNotRegistered` e apagado na hora |

---

## 39. O projeto organizado, e o deploy pelo GitHub

### 39.1 A estrutura

```
README.md          a porta de entrada
server/            o agente
web/               o site
mobile/            o app
infra/             o que poe no ar
voz/               ferramentas da voz
docs/              plano, diario e operacao
```

`app/` deixou de existir como invólucro: `app/server` dizia duas vezes a mesma
coisa, e `app/deploy` nunca foi aplicacao.

### 39.2 O deploy deixou de empacotar e passou a buscar

Antes: `tar` da pasta local, `scp`, extrair, instalar. O que rodava no servidor
era **o que estava na maquina de quem rodou o script** — sem registro de qual
versao era, e com a possibilidade silenciosa de publicar algo que nunca foi
commitado.

Agora o servidor busca do GitHub:

```
/opt/thor/
├── repo/   git reset --hard a cada deploy
├── data/   o banco, nunca tocado
└── .env    os segredos, nunca tocados
```

Dados e segredos ficam **fora** do repositorio porque o deploy apaga o que nao
esta versionado. `git reset --hard` e nao `git pull`: servidor e destino de
deploy, nao lugar de editar — se alguem mexeu la, o certo e perder a mudanca,
nao travar o deploy num conflito.

E o `deploy.sh` se recusa a publicar com alteracao nao enviada. Se o servidor
busca do GitHub, o que nao chegou no GitHub nao existe.

### 39.3 Duas coisas que o deploy por git obrigou a arrumar

**A versao do service worker.** O `install.sh` reescrevia `sw.js` para carimbar
a versao do cache. Com o codigo versionado, um script que edita arquivo
versionado suja a arvore e trava o `git reset` seguinte. Agora a versao e
calculada **ao servir**, a partir do resumo de `app.js`, `app.css` e
`index.html`. Nao ha passo para esquecer nem arquivo para sujar.

**Os PNG do icone.** Gerados do SVG a cada instalacao, agora fora do
versionamento. Uma fonte de verdade em vez de quatro arquivos para manter em
sincronia.

### 39.4 Volta automatica

As duas unidades disputam a porta 8787, entao a troca tem um instante em que
ninguem atende. Se o servico novo nao responder, o `install.sh` **religa o
anterior** e mostra o log.

Por isso a unit antiga e desligada mas **o arquivo dela fica**: apagar seria
queimar a ponte no meio da travessia.

### 39.5 O index.ts de mil linhas

Fazia tudo: criava o servidor, declarava trinta rotas, montava o prompt e
rodava o laco do agente. Funcionava, e era exatamente o tipo de arquivo onde
uma mudanca pequena exige ler o resto inteiro para ter certeza.

```
index.ts            39 linhas: o que entra e em que ordem
http/servidor.ts    instancia, estaticos, CSP, service worker
http/contexto.ts    quem esta falando — a unica definicao de "autenticado"
rotas/              conta, conversas, memoria, operacao, personalidade
agente/conversa.ts  ferramentas, prompt, o que fica guardado
agente/canal.ts     o WebSocket e o laco
```

Cada grupo de rota e um plugin do Fastify. A ordem importa num ponto so: a rota
de sobra vai por ultimo, porque e ela que responde o que ninguem respondeu.

Conferido antes de publicar com o servidor novo rodando numa **porta separada**:
rota publica 200, privada 401, caminho desconhecido caindo no index, service
worker saindo com versao. Depois, os 90 casos de aprovacao de novo.

### 39.6 Um erro que a mudanca de caminho criou

`/opt/luk/data` estava **escrito a mao** dentro do `executar.ts` como o unico
lugar onde gravar era aprovavel. Com a mudanca para `/opt/thor`, a faixa de
aprovacao passou a apontar para um diretorio que nao existe mais: nada do que
o Thor pedisse para gravar funcionaria, e o motivo seria dificil de achar.

Agora sai de `config.dataDir`, a mesma fonte que o systemd usa em
`ReadWritePaths`. **Duas copias de um caminho sao duas chances de divergir.**

| # | Decisao |
|---|---|
| D130 | O deploy busca do GitHub; o que esta no ar e um commit, com nome e historico |
| D131 | `git reset --hard`, nao `pull`: servidor e destino de deploy, nao lugar de editar |
| D132 | Dados e segredos fora do repositorio, porque o deploy apaga o que nao e versionado |
| D133 | A versao do service worker e calculada ao servir, nao escrita nem carimbada |
| D134 | `install.sh` religa a versao anterior sozinho se a nova nao responder |
| D135 | Cada grupo de rota e um plugin; `index.ts` so monta |
| D136 | Caminho que o systemd e o codigo precisam saber tem **uma** fonte: `config.dataDir` |

---

## 40. A memoria, construida

O plano da §39 e de `docs/memoria.md` saiu do papel. O que esta rodando:

### 40.1 A alma virou arquivo

`server/personalidade.md`, lido no arranque, estavel byte a byte durante a
conversa. A tela ainda pode sobrepor; restaurar volta ao arquivo.

Sumiu com isso toda a logica de migracao por hash da §36.2 — o git ja faz esse
trabalho, e fazia desde sempre.

A personalidade e espelhada no JARVIS do Homem de Ferro, mas sem a parte que
nao serve: nada de "senhor", nada de sotaque. O que ficou foi o util — **o
ponto fixo ao lado de alguem agitado**, calmo na noticia ruim, seco quando
cabe, e opiniao em vez de cardapio.

### 40.2 O nucleo se enche sozinho

`preferencia` e `decisao` com confianca ≥ 0,8 entram fixadas automaticamente,
com teto de 40 — porque isto e pago em toda mensagem.

`fato` nao entra: "a reuniao mudou para quinta" e passageiro, vai para o
arquivo. O criterio e **vale em qualquer conversa?**

### 40.3 Busca por sentido, medida

Servico Python separado (`ferramentas/embed/servidor.py`), modelo
`paraphrase-multilingual-mpnet-base-v2`, 768 dimensoes.

Medido neste servidor, contra pares que dizem a mesma coisa com outras
palavras: margem +0,284, contra +0,156 do MiniLM e negativo nos demais. Em
producao: 1,4 GB em repouso, 17 s para carregar.

Processo separado de proposito — **modelo que trava nao pode levar o agente
junto**. Tudo falha para o lado macio: sem o servico, a busca por palavra
continua e o Thor so fica mais cego.

Os vetores ficam numa coluna BLOB do SQLite e sao comparados um a um. E
ingenuo e e suficiente: com milhares de pensamentos sao poucos milissegundos.
Quando passar de ~10 mil, troca-se por `pgvector` no Postgres que ja temos.

**Indexacao a prova de servico fora do ar:** pensamento guardado sem vetor fica
marcado e e indexado na proxima oportunidade. Sem isso ele ficaria invisivel
para a busca por sentido, em silencio, para sempre.

### 40.4 A conversa cresce em vez de deslizar

Levar as 24 ultimas mensagens fazia duas coisas ruins: o Thor **esquecia** o
comeco, e o desconto de repeticao do provedor nunca se aplicava — ele exige que
o inicio do pedido se repita, e numa janela que desliza o inicio muda sempre.

Agora cresce. No limite, o meio vira resumo estruturado (objetivo, preferencias,
o que foi feito, o que ficou pendente, decisoes) feito por um **modelo barato**.
Nada e apagado do banco: o resumo so substitui o que e **enviado**.

Falha para o lado seguro: se o modelo auxiliar nao responder, nada e comprimido
e a conversa segue inteira. Caro e melhor que perdido — e **nunca** se descarta
o meio sem resumo, que o Hermes documenta como a causa mais comum de
compactacao ruim.

### 40.5 Colheita no fim

As marcas `<lembrar>` continuam, mas e o modelo decidindo no calor da resposta
e muito escapa. A cada 6 mensagens novas um modelo barato le o trecho e extrai
o que **continua verdade depois que a conversa acabar**.

A marca de ate onde leu so avanca **depois** de o modelo responder: avancar
antes trocaria "guardei nada" por "nunca mais olho isto".

### 40.6 A cerca

Memoria recuperada volta cercada em `<memoria>`, com aviso de que e dado e nao
ordem. O Thor executa comandos no servidor — para ele, a diferenca entre "algo
que guardei" e "ordem que recebi" nao e formatacao.

### 40.7 Tres erros que so apareceram ao fazer funcionar

Vale registrar porque todos tinham a mesma forma: **codigo que nunca era
percorrido nao estava certo, estava apenas calado.**

1. **`fallbackTitle` e `hasKey` sem import.** A quebra do `index.ts` em modulos
   deixou funcoes definidas num arquivo e usadas em outro. Como o projeto roda
   TypeScript sem compilar, nao havia etapa que tropecasse nisso: quebrava na
   primeira mensagem de uma conversa nova, em producao.
2. **Ordem invertida no banco.** O pensamento era gravado apontando para uma
   mensagem que ainda nao existia. O erro estava ali desde sempre e nunca
   aparecia porque a memoria nunca chegava a guardar nada.
3. **Teste que pulava calado.** As partes pagas eram puladas porque o banco de
   teste nao tinha a chave — e o pulo so aparecia numa linha no meio da saida.

O (1) virou `infra/verificar.sh`, que roda o compilador no servidor (onde as
dependencias existem) antes de publicar.

### 40.8 Verificado

| suite | conferencias |
|---|---|
| `testes/memoria.ts` | 47 |
| `testes/ponta-a-ponta.ts` | conversa real, 3 conversas |
| comandos e aprovacao | 90 + 5 |

O teste ponta a ponta e o que importa: ele conta uma preferencia ao Thor numa
conversa, abre **outra** conversa e confirma que ele lembrou sem ser lembrado.

| # | Decisao |
|---|---|
| D137 | A alma e arquivo no git, nao linha no banco; a tela sobrepoe, restaurar volta ao arquivo |
| D138 | `preferencia` e `decisao` entram fixadas sozinhas, com teto; `fato` nao |
| D139 | Embed roda em processo separado — modelo que trava nao leva o agente junto |
| D140 | Sem embed, a busca por palavra continua: tudo falha para o lado macio |
| D141 | Vetor em BLOB no SQLite, comparado um a um ate ~10 mil memorias |
| D142 | A conversa cresce e comprime; a compressao e a unica quebra de cache aceita |
| D143 | Resumo e colheita usam modelo barato, nunca o principal |
| D144 | A marca da colheita so avanca depois da resposta do modelo |
| D145 | Memoria recuperada vem cercada e marcada como dado, nunca como ordem |
| D146 | `infra/verificar.sh` roda antes de publicar: sem compilacao, nome solto so aparece em producao |
