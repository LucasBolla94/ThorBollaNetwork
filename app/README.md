# Thor — aplicacao

O site e o servidor do Thor. No ar em **https://bolla.network**.

## Mapa dos arquivos

```
app/
  server/
    package.json          5 dependencias, todas JavaScript puro
    src/
      config.ts           le o .env e junta as configuracoes
      db.ts               esquema do SQLite + a teia de pensamento
      auth.ts             senha (scrypt), sessoes, TOTP, limite de tentativas
      memory.ts           guardar, corrigir, ligar e buscar pensamentos
      llm.ts              OpenRouter em streaming
      index.ts            rotas HTTP e o chat por WebSocket
  web/
    index.html            uma pagina, quatro telas
    app.css               tema escuro, sem framework
    app.js               cliente: chat, teia, alma, configuracao
    sw.js                 service worker (rede primeiro)
    manifest.webmanifest  PWA
    icon.svg              o orbe; os PNG saem dele na instalacao
  deploy/
    Caddyfile             proxy reverso + HTTPS automatico
    luk.service           unit do systemd, com isolamento
    install.sh            instala/atualiza no servidor (idempotente)
    deploy.sh             empacota daqui e chama o install la
```

## Atualizar o site

```bash
bash app/deploy/deploy.sh
```

Sobe so o codigo. O `.env` e o banco ficam intactos.

## Decisoes que explicam o codigo

**Zero compilacao.** O Node 24 roda TypeScript apagando os tipos. Nao ha `tsc`,
nao ha pasta `dist`, nao ha etapa de build no servidor. Em troca, nao da para
usar sintaxe que gera codigo: nada de `enum`, `namespace` ou parameter property
no construtor.

**Zero dependencia nativa.** O banco e o `node:sqlite` embutido (com FTS5), e a
senha usa `scrypt` do `node:crypto`. Nenhum `node-gyp`, nenhum modulo que quebra
quando o Node sobe de versao.

**Cinco dependencias.** Fastify e tres plugins dele, mais o gerador de QR Code.
O TOTP foi escrito a mao (sao 30 linhas) para nao somar uma sexta.

**Nada de CDN.** A CSP bloqueia script externo. Tudo que a pagina usa vem do
proprio servidor.

## Operacao

```bash
sudo systemctl status luk        # estado
sudo journalctl -u luk -f        # log ao vivo
sudo journalctl -u caddy -f      # log do proxy / HTTPS
sudo systemctl restart luk       # reiniciar
sudo cat /opt/luk/.env           # configuracao e segredos
sudo cat /opt/luk/SETUP.txt      # token de primeiro acesso
```

No servidor tudo vive em `/opt/luk`, rodando como o usuario `luk`, que so tem
permissao de escrita em `/opt/luk/data`.

## Backup

O que importa cabe em dois caminhos:

```bash
ssh dedicated-1 'sudo sqlite3 /opt/luk/data/luk.db ".backup /tmp/luk-backup.db"'
scp dedicated-1:/tmp/luk-backup.db ./backup-$(date +%F).db
```

O `.env` tambem merece copia: perder o `SESSION_SECRET` so desconecta todo
mundo, mas perder a chave do OpenRouter da trabalho.
