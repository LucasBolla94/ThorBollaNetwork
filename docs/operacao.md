# Operação

O que fazer quando algo precisa ser olhado, reiniciado ou recuperado.
Para o que o projeto é e como está organizado, veja o [README](../README.md).

---

## Mapa dos arquivos do servidor

```
server/
  package.json          5 dependências, todas JavaScript puro
  src/
    config.ts           lê o .env e junta as configurações
    db.ts               esquema do SQLite + a teia de pensamento
    auth.ts             senha (scrypt), sessões, TOTP, tíquete do WebSocket
    memory.ts           guardar, corrigir, ligar e buscar pensamentos
    llm.ts              OpenRouter e Anthropic, em streaming
    executar.ts         a ferramenta de comandos e os três níveis
    aprovacao.ts        o canal de autorização
    push.ts             aviso de aprovação no celular
    index.ts            rotas HTTP e o chat por WebSocket
```

---

## Onde as coisas moram no servidor

```
/opt/thor/
├── repo/   o código. Trocado inteiro a cada deploy
├── data/   o banco. Nunca tocado pelo deploy
└── .env    os segredos. Nunca tocados pelo deploy
```

Roda como o usuário `thor`, que só tem permissão de escrita em
`/opt/thor/data`. Todo o resto do disco é somente leitura para ele — inclusive
o próprio código.

---

## Comandos do dia a dia

```bash
sudo systemctl status thor        # estado
sudo journalctl -u thor -f        # log ao vivo
sudo journalctl -u caddy -f       # log do proxy e do HTTPS
sudo systemctl restart thor       # reiniciar
sudo cat /opt/thor/.env           # configuração e segredos
```

---

## Publicar uma versão nova

```bash
bash infra/deploy.sh
```

O servidor busca do GitHub e reinstala. Dados e segredos ficam intactos.

Se o serviço novo não responder, o script **volta sozinho** para a versão
anterior e mostra o log — a troca tem um instante em que ninguém atende a porta
8787, e nesse instante a única saída boa é poder voltar com um comando.

---

## Backup

O que importa cabe em dois caminhos:

```bash
ssh dedicated-1 'sudo sqlite3 /opt/thor/data/thor.db ".backup /tmp/thor-backup.db"'
scp dedicated-1:/tmp/thor-backup.db ./backup-$(date +%F).db
```

Use `.backup` e não `cp`: o banco está em modo WAL, e copiar o arquivo com o
serviço rodando pode pegar um estado pela metade.

O `.env` também merece cópia. Perder o `SESSION_SECRET` só desconecta todo
mundo; perder a chave do OpenRouter dá trabalho.

---

## Quando algo dá errado

**O site não responde.** Veja `systemctl status thor`. Se o serviço estiver
reiniciando em laço, o log diz por quê — quase sempre é variável faltando no
`.env`, e o erro nomeia qual.

**Voltar para a versão anterior.**

```bash
ssh dedicated-1 'sudo git -C /opt/thor/repo reset --hard HEAD~1 && sudo bash /opt/thor/repo/infra/install.sh'
```

**O que o agente tentou executar.** Toda tentativa, autorizada ou não, fica no
banco com o motivo da recusa:

```bash
ssh dedicated-1 'sudo -u thor sqlite3 /opt/thor/data/thor.db "select datetime(created_at/1000,\"unixepoch\"), permitido, motivo, comando from comandos order by created_at desc limit 20;"'
```

---

## Servidor novo, do zero

```bash
sudo bash infra/bootstrap.sh
```

Instala Node, clona o repositório e chama o `install.sh`. Roda uma vez; depois
disso toda atualização é `infra/deploy.sh`.
