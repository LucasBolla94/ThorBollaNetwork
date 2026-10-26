#!/usr/bin/env bash
# =========================================================================
# Sobe uma instancia de demonstracao do Luk, com conta pronta e memoria
# semeada, para conferir o visual sem tocar na instalacao real.
#
#   ssh dedicated-1 'bash /opt/thor/repo/server/demo.sh'       # no servidor
#   ssh -f -N -L 8788:127.0.0.1:8788 dedicated-1         # tunel, daqui
#   depois abra http://localhost:8788
#
# Para desmontar:  bash demo.sh --fim
#
# Usa banco proprio em /tmp e um usuario descartavel no Supabase. A conta real
# e o banco de verdade nao sao tocados em momento algum.
# =========================================================================
set -uo pipefail

EMAIL="demo-visual@bolla.network"
SENHA="senha-de-demonstracao-123"
PORTA=8788

matar() {
  local p
  p=$(sudo ss -tlnp 2>/dev/null | grep ":$PORTA" | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2)
  [ -n "$p" ] && sudo kill "$p" && sleep 2
}

sb() {
  local metodo=$1 caminho=$2 corpo=${3:-}
  local sr
  sr=$(sudo grep "^SERVICE_ROLE_KEY=" /opt/supabase/app/.env | cut -d= -f2-)
  if [ -n "$corpo" ]; then
    curl -s -X "$metodo" "http://127.0.0.1:8000/auth/v1$caminho" \
      -H "apikey: $sr" -H "Authorization: Bearer $sr" \
      -H "Content-Type: application/json" -d "$corpo"
  else
    curl -s -X "$metodo" "http://127.0.0.1:8000/auth/v1$caminho" \
      -H "apikey: $sr" -H "Authorization: Bearer $sr"
  fi
}

apagar_usuario() {
  local id
  id=$(sb GET /admin/users | jq -r ".users[] | select(.email==\"$EMAIL\") | .id")
  [ -n "$id" ] && sb DELETE "/admin/users/$id" > /dev/null && echo "   usuario de demo removido"
}

if [ "${1:-}" = "--fim" ]; then
  matar
  apagar_usuario
  rm -f /tmp/demo.env /tmp/demo.jar /tmp/demo.log /tmp/demo.db /tmp/demo.db-wal /tmp/demo.db-shm
  echo "demo desmontada. usuarios no Supabase: $(sb GET /admin/users | jq '.users | length')"
  exit 0
fi

matar
apagar_usuario
rm -f /tmp/demo.db /tmp/demo.db-wal /tmp/demo.db-shm /tmp/demo.log

# .env proprio: sem gate de dono e sem e-mail de verdade saindo
sudo cp /opt/thor/.env /tmp/demo.env
sudo chown "$USER" /tmp/demo.env
chmod 600 /tmp/demo.env
sed -i "s|^SMTP_HOST=.*|SMTP_HOST=smtp.invalido.localdomain|" /tmp/demo.env
sed -i "s|^LUK_OWNER_EMAIL=.*|LUK_OWNER_EMAIL=|" /tmp/demo.env

cd /opt/thor/repo/server
LUK_ENV=/tmp/demo.env LUK_DB=/tmp/demo.db PORT=$PORTA SECURE_COOKIES=false \
  nohup /usr/local/bin/node src/index.ts > /tmp/demo.log 2>&1 &
sleep 4

B=http://127.0.0.1:$PORTA
curl -s -X POST $B/api/auth/signup -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$SENHA\"}" > /dev/null

ID=$(sb GET /admin/users | jq -r ".users[] | select(.email==\"$EMAIL\") | .id")
sb PUT "/admin/users/$ID" '{"email_confirm":true}' > /dev/null

curl -s -c /tmp/demo.jar -X POST $B/api/auth/login -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$SENHA\"}" > /dev/null

add() {
  curl -s -b /tmp/demo.jar -X POST $B/api/thoughts -H "Content-Type: application/json" \
    -d "{\"kind\":\"$1\",\"content\":\"$2\"}" | jq -r ".thought.id // empty"
}

A=$(add preferencia "O Lucas prefere respostas curtas e diretas")
add preferencia "Ele trabalha no Windows, com servidor Ubuntu" > /dev/null
C=$(add projeto "O Luk roda no dedicated-1, servido pelo Caddy em bolla.network")
add projeto "A memoria usa SQLite com FTS5 e busca por ferramenta" > /dev/null
add projeto "O painel segue a gramatica de HUD: traco fino e anel concentrico" > /dev/null
add decisao "Nao usar Claude Code como motor: custa 13x mais por mensagem" > /dev/null
add decisao "Autenticacao pelo Supabase, com e-mail e senha" > /dev/null
add decisao "O cache do prompt precisa de marcador explicito na Anthropic" > /dev/null
add fato "O servidor tem 31 GB de RAM e nao tem GPU" > /dev/null
add fato "O dominio bolla.network tem e-mail na IONOS" > /dev/null
add fato "BollaNetwork e a empresa; Luk e o produto" > /dev/null
add pessoa "Sandeco escreveu as specs do SandeClaw que usamos de base" > /dev/null

[ -n "$A" ] && curl -s -b /tmp/demo.jar -X POST "$B/api/thoughts/$A/pin" > /dev/null
[ -n "$C" ] && curl -s -b /tmp/demo.jar -X POST "$B/api/thoughts/$C/pin" > /dev/null

echo "demo no ar em $B"
echo "  e-mail: $EMAIL"
echo "  senha:  $SENHA"
curl -s -b /tmp/demo.jar $B/api/thoughts \
  | jq -r '"  memoria: \(.thoughts | length) pensamentos, \(.links | length) ligacoes"'
