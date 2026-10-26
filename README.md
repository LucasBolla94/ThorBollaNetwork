# Thor

Segundo cérebro pessoal. Um agente que conversa, lembra do que importa entre
conversas e executa comandos no servidor — sempre lendo, e escrevendo só com
autorização.

Roda em <https://bolla.network>.

---

## O que tem aqui

| pasta | o que é |
|---|---|
| `server/` | o agente: API, WebSocket, memória, ferramentas. Node + TypeScript, sem compilação |
| `web/` | o site. HTML, CSS e JavaScript puros, sem framework e sem build |
| `mobile/` | o app de iPhone, em Expo |
| `infra/` | o que põe no ar: systemd, Caddy, instalação e deploy |
| `voz/` | ferramentas para treinar a voz dele |
| `docs/` | [o plano](docs/plano.md) e [o diário](docs/diario.md) |

---

## Três decisões que explicam o resto do código

**Sem passo de compilação.** O Node 24 executa TypeScript direto, descartando
os tipos. Não há `tsc`, não há `dist/`, e o que está no repositório é o que
roda no servidor. Em troca, três construções de TypeScript não existem aqui:
`enum`, `namespace` e parâmetro-propriedade no construtor.

**Sem dependência nativa.** O banco é o `node:sqlite`, que já vem no Node, com
busca em texto completo. Nada de `node-gyp`, nada de recompilar a cada
atualização — o servidor não tem compilador e não vai ter.

**Sem framework no site.** A tela é desenhada em `canvas` e CSS. A política de
segurança de conteúdo proíbe script externo, então não há CDN: tudo que a
página usa vem do próprio domínio.

---

## O modelo de segurança, em uma tela

O agente tem uma ferramenta que roda comandos no servidor. Ela classifica cada
comando em três níveis:

| nível | o que é | o que acontece |
|---|---|---|
| **livre** | consulta | roda na hora |
| **aprovar** | grava em `/opt/thor/data` ou `/tmp` | para e pede autorização |
| **nunca** | o resto | não roda nem com autorização |

O terceiro nível segue um princípio só:

> **Aprovar só protege quando o que aparece é o que roda.**

Por isso substituição de comando, `&`, `crontab`, `xargs` e `curl` ficam de
fora mesmo sendo úteis — ou o comando muda depois de ser lido, ou ninguém
consegue julgar olhando. Detalhe em [docs/plano.md](docs/plano.md), seção 35.

Três camadas sustentam isso, e a lista é a mais fraca delas: o isolamento do
systemd deixa só `/opt/thor/data` gravável, a lista de permissões decide o que
passa, e toda tentativa — autorizada ou não — vai para auditoria no banco.

---

## Rodando aqui

```bash
cd server
npm install
node src/index.ts
```

Precisa de um `.env` na raiz com `SESSION_SECRET`. O site sobe em
<http://127.0.0.1:8787>.

O app:

```bash
cd mobile
npm install
npx expo start
```

---

## Publicando

O servidor busca do GitHub. Da máquina de desenvolvimento:

```bash
bash infra/deploy.sh
```

Ele se recusa a publicar com alteração não enviada — se o servidor busca do
GitHub, o que não chegou lá não existe.

Num servidor novo, uma vez só:

```bash
sudo bash infra/bootstrap.sh
```

### O que o deploy nunca toca

```
/opt/thor/
├── repo/   ← o código. git reset --hard a cada deploy
├── data/   ← o banco. nunca tocado
└── .env    ← os segredos. nunca tocados
```

Dados e segredos ficam **fora** do repositório justamente porque o deploy
apaga o que não está versionado.

---

## O que falta

- **App nativo no iPhone.** O código está pronto e a configuração validada.
  Falta uma conta Apple Developer (US$ 99/ano) — é exigência da Apple para
  qualquer app em aparelho físico, sem contorno.
- **Voz própria.** O corpus está gravado (300 frases, 18,8 minutos). Falta
  alugar uma GPU para treinar.
