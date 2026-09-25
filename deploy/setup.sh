#!/usr/bin/env bash
# ==================================================================
#  Instala OU atualiza a API no Debian 12/13. Pode rodar quantas
#  vezes quiser (idempotente). Execute a partir da raiz do projeto:
#
#     sudo ./deploy/setup.sh
#
#  HTTPS numa porta própria (padrão 8443), sem usar as portas 80/443:
#  o certificado Let's Encrypt é validado por DNS através do DuckDNS.
#
#  Arquivos de configuração (criados na 1ª execução):
#    /etc/fluxo-api/fluxo-api.env   variáveis da API
#    /etc/fluxo-api/https.env       HTTPS_PORT e DUCKDNS_API_TOKEN (Caddy)
# ==================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/var/www/html/fluxo-chamados
ETC_DIR=/etc/fluxo-api
ENV_FILE="$ETC_DIR/fluxo-api.env"
HTTPS_ENV="$ETC_DIR/https.env"
SERVICE=fluxo-api

info() { echo -e "\e[1;34m==>\e[0m $*"; }
ok()   { echo -e "\e[1;32m✔\e[0m  $*"; }
warn() { echo -e "\e[1;33m!\e[0m  $*"; }
fail() { echo -e "\e[1;31m✖\e[0m  $*" >&2; exit 1; }
trap 'fail "Erro inesperado na linha $LINENO: $BASH_COMMAND"' ERR

# Lê VAR=valor de um arquivo de ambiente (vazio se não existir)
env_get() { grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' | sed -E 's/^["'"'"']|["'"'"']$//g' || true; }

[[ $EUID -eq 0 ]] || fail "Execute com sudo."
[[ -f "$REPO_DIR/backend/package.json" ]] || fail "Rode a partir da raiz do projeto (pasta com backend/)."
[[ "$APP_DIR" != "$REPO_DIR" && "$APP_DIR" != "$REPO_DIR/"* ]] || fail "APP_DIR não pode ser a pasta do código-fonte."

# ---------- 1. Pacotes do sistema ----------
info "Verificando dependências do sistema"
apt-get update -qq
apt-get install -y -qq ca-certificates curl rsync openssl iproute2 caddy >/dev/null

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if (( node_major < 22 )); then
  info "Instalando Node.js 22 LTS (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

# Caddy com o plugin DuckDNS (o pacote do Debian não traz plugins de DNS)
if ! caddy list-modules 2>/dev/null | grep -q '^dns.providers.duckdns'; then
  info "Instalando Caddy com o plugin DuckDNS (caddyserver.com)"
  case "$(dpkg --print-architecture)" in
    amd64) arch=amd64 ;;
    arm64) arch=arm64 ;;
    *) fail "Arquitetura $(dpkg --print-architecture) não suportada por este script." ;;
  esac
  tmp=$(mktemp)
  curl -fsSL --max-time 180 -o "$tmp" \
    "https://caddyserver.com/api/download?os=linux&arch=${arch}&p=github.com/caddy-dns/duckdns"
  chmod +x "$tmp"
  "$tmp" list-modules 2>/dev/null | grep -q '^dns.providers.duckdns' || fail "Download do Caddy inválido."
  systemctl stop caddy 2>/dev/null || true
  install -m 755 "$tmp" /usr/bin/caddy && rm -f "$tmp"
  apt-mark hold caddy >/dev/null   # impede o apt de voltar para o Caddy sem plugin
fi
ok "Node $(node -v), Caddy $(caddy version | awk '{print $1}') com DuckDNS"

# ---------- 2. Usuário de serviço ----------
if ! id fluxo &>/dev/null; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin fluxo
  ok "Usuário de sistema 'fluxo' criado"
fi

# ---------- 3. Arquivos de configuração ----------
mkdir -p "$ETC_DIR"
pending=0

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$REPO_DIR/backend/.env.example" "$ENV_FILE"
  sed -i 's/\r$//' "$ENV_FILE"
  secret=$(openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-64)
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${secret}|" "$ENV_FILE"
  ok "Criado $ENV_FILE (JWT_SECRET já gerado) — preencha DB_* e GOOGLE_*"
  pending=1
fi
chown root:fluxo "$ENV_FILE"; chmod 640 "$ENV_FILE"

if [[ ! -f "$HTTPS_ENV" ]]; then
  # Reaproveita o token do atualizador DuckDNS existente, se houver
  token=$(grep -ohP 'token=\K[A-Za-z0-9-]+' /opt/duckdns.sh /root/duckdns/duck.sh /home/*/duckdns/duck.sh 2>/dev/null | head -1 || true)
  cat > "$HTTPS_ENV" <<EOF
# Porta pública do HTTPS (encaminhe esta porta no roteador para este servidor)
HTTPS_PORT=8443
# Token da conta DuckDNS (painel duckdns.org) — usado para validar o certificado por DNS
DUCKDNS_API_TOKEN=${token}
EOF
  chmod 600 "$HTTPS_ENV"
  if [[ -n "$token" ]]; then
    ok "Criado $HTTPS_ENV (token DuckDNS copiado do atualizador existente)"
  else
    ok "Criado $HTTPS_ENV — preencha DUCKDNS_API_TOKEN"
    pending=1
  fi
fi
chown root:root "$HTTPS_ENV"; chmod 600 "$HTTPS_ENV"

if (( pending )); then
  echo
  echo "   Edite e rode novamente:"
  echo "     sudo nano $ENV_FILE"
  echo "     sudo nano $HTTPS_ENV"
  echo "     sudo ./deploy/setup.sh"
  exit 0
fi

sed -i 's/\r$//' "$ENV_FILE" "$HTTPS_ENV"
grep -q "SEU-SUBDOMINIO" "$ENV_FILE" && fail "Troque SEU-SUBDOMINIO em $ENV_FILE antes de continuar."

https_port=$(env_get "$HTTPS_ENV" HTTPS_PORT); https_port=${https_port:-8443}
duck_token=$(env_get "$HTTPS_ENV" DUCKDNS_API_TOKEN)
api_port=$(env_get "$ENV_FILE" PORT); api_port=${api_port:-8080}
redirect=$(env_get "$ENV_FILE" GOOGLE_REDIRECT_URI)
domain=$(sed -E 's|^https?://([^/:]+).*|\1|' <<<"$redirect")

[[ "$https_port" =~ ^[0-9]+$ ]] || fail "HTTPS_PORT inválida em $HTTPS_ENV"
[[ "$https_port" != "80" && "$https_port" != "443" ]] || fail "HTTPS_PORT não pode ser 80/443 neste modo."
[[ "$https_port" != "$api_port" ]] || fail "HTTPS_PORT ($https_port) não pode ser igual à PORT da API ($api_port)."
[[ -n "$duck_token" ]] || fail "Preencha DUCKDNS_API_TOKEN em $HTTPS_ENV"
[[ "$domain" == *.duckdns.org ]] || fail "GOOGLE_REDIRECT_URI deve usar o domínio *.duckdns.org (atual: $redirect)"
expected="https://${domain}:${https_port}/auth/google/callback"
[[ "$redirect" == "$expected" ]] || fail "GOOGLE_REDIRECT_URI deve ser exatamente: $expected
   (e o mesmo endereço precisa estar cadastrado no Google Cloud Console)"

# ---------- 4. Código e build ----------
info "Copiando e compilando a API em $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .env \
  "$REPO_DIR/backend/" "$APP_DIR/"
mkdir -p "$APP_DIR/deploy" && cp "$REPO_DIR/deploy/duckdns.sh" "$APP_DIR/deploy/"
cd "$APP_DIR"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
npm prune --omit=dev --no-audit --no-fund --loglevel=error
chown -R root:fluxo "$APP_DIR"
chmod -R u=rwX,g=rX,o= "$APP_DIR"
ok "Build concluído"

# ---------- 5. Portas livres ----------
port_owner() { ss -tlnpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true; }
check_port() {
  local p=$1 allowed=$2 pid unit
  pid=$(port_owner "$p"); [[ -z "$pid" ]] && return 0
  unit=$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ' || true)
  [[ "$unit" == "$allowed" ]] && return 0
  echo; ps -o pid,user,cmd -p "$pid" | sed 's/^/   /'
  fail "Porta $p ocupada por outro processo (unidade: ${unit:-nenhuma}). Escolha outra porta ou pare o processo."
}
check_port "$api_port" "$SERVICE.service"
check_port "$https_port" caddy.service

# ---------- 6. Serviço da API ----------
install -m 644 "$REPO_DIR/deploy/fluxo-api.service" /etc/systemd/system/$SERVICE.service
systemctl daemon-reload
systemctl enable --quiet $SERVICE
systemctl restart $SERVICE

info "Aguardando a API responder em 127.0.0.1:$api_port"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$api_port/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:$api_port/health" >/dev/null 2>&1; then
  echo; journalctl -u $SERVICE -n 40 --no-pager
  fail "A API não respondeu. Veja o log acima (journalctl -u $SERVICE -f)."
fi
ok "API no ar"

# ---------- 7. HTTPS (Caddy) ----------
mkdir -p /etc/systemd/system/caddy.service.d
# Sem "--environ" (o padrão do Debian imprime todas as variáveis, inclusive o token, no journal)
cat > /etc/systemd/system/caddy.service.d/fluxo-duckdns.conf <<EOF
[Service]
EnvironmentFile=$HTTPS_ENV
ExecStart=
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
EOF

if [[ -f /etc/caddy/Caddyfile && ! -f /etc/caddy/Caddyfile.orig ]]; then
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig
fi
sed -e "s|__DOMAIN__|$domain|g" -e "s|__HTTPS_PORT__|$https_port|g" -e "s|__PORT__|$api_port|g" \
  "$REPO_DIR/deploy/Caddyfile.template" > /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
DUCKDNS_API_TOKEN="$duck_token" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  || { DUCKDNS_API_TOKEN="$duck_token" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; fail "Caddyfile inválido."; }
systemctl daemon-reload
systemctl enable --quiet caddy
systemctl restart caddy
sleep 2
if ! systemctl is-active --quiet caddy; then
  journalctl -u caddy -n 20 --no-pager
  fail "O Caddy não iniciou. Veja o log acima."
fi
ok "Caddy configurado: https://$domain:$https_port (sem usar as portas 80/443)"

info "Aguardando o certificado (validação por DNS, pode levar até 2 min)"
cert_ok=0
for _ in $(seq 1 24); do
  if curl -fsS --max-time 5 --resolve "$domain:$https_port:127.0.0.1" "https://$domain:$https_port/health" >/dev/null 2>&1; then
    cert_ok=1; break
  fi
  sleep 5
done
if (( cert_ok )); then
  ok "Certificado emitido e HTTPS respondendo"
else
  warn "O certificado ainda não saiu. Acompanhe: journalctl -u caddy -f"
fi

# ---------- 8. DuckDNS (opcional) ----------
if [[ -f "$ETC_DIR/duckdns.env" ]]; then
  chmod 600 "$ETC_DIR/duckdns.env"
  echo "*/5 * * * * root $APP_DIR/deploy/duckdns.sh" > /etc/cron.d/duckdns
  chmod 644 /etc/cron.d/duckdns
  "$APP_DIR/deploy/duckdns.sh" && ok "DuckDNS atualizado (cron a cada 5 min)"
fi

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw status | grep -qE "^${https_port}(/tcp)?\s+ALLOW" || warn "ufw ativo: libere a porta com  sudo ufw allow ${https_port}/tcp"
fi

echo
ok "Pronto!  No roteador, encaminhe a porta TCP $https_port para este servidor."
echo "   Teste de fora da rede (4G):  https://$domain:$https_port/health"
echo "   URL do app (eas.json):       https://$domain:$https_port"
echo "   Logs da API:   journalctl -u $SERVICE -f"
echo "   Logs do HTTPS: journalctl -u caddy -f"
