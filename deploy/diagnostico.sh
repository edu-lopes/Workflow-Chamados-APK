#!/usr/bin/env bash
# ==================================================================
#  Diagnóstico de rede do servidor (SOMENTE LEITURA — não altera nada)
#
#     sudo ./deploy/diagnostico.sh SEU-SUBDOMINIO.duckdns.org
#
#  Mostra: para onde o DuckDNS aponta, seu IP público, quem atualiza o
#  DuckDNS, quais portas/processos estão escutando (inclusive o serviço
#  antigo), firewall e se a API/Caddy respondem.
# ==================================================================
set -uo pipefail

DOMAIN="${1:-}"
ENV_FILE=/etc/fluxo-api/fluxo-api.env
HTTPS_ENV=/etc/fluxo-api/https.env
HTTPS_PORT=$(grep -E '^HTTPS_PORT=' "$HTTPS_ENV" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]"' || true)
HTTPS_PORT=${HTTPS_PORT:-8443}
if [[ -z "$DOMAIN" && -f "$ENV_FILE" ]]; then
  DOMAIN=$(grep -E '^GOOGLE_REDIRECT_URI=' "$ENV_FILE" | sed -E 's|^[^=]+=https?://([^/:]+).*|\1|')
fi
[[ -n "$DOMAIN" ]] || { echo "Uso: sudo $0 seu-subdominio.duckdns.org"; exit 1; }
[[ "$DOMAIN" == *.* ]] || DOMAIN="$DOMAIN.duckdns.org"
[[ $EUID -eq 0 ]] || echo "(dica: rode com sudo para ver os processos de cada porta)"

h()    { echo; echo -e "\e[1;34m━━ $* \e[0m"; }
ok()   { echo -e "  \e[32m✔\e[0m $*"; }
warn() { echo -e "  \e[33m!\e[0m $*"; }
bad()  { echo -e "  \e[31m✖\e[0m $*"; }

# ---------------------------------------------------------------
h "1. DNS — para onde $DOMAIN aponta"
dns_ip=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')
public_ip=$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)
echo "  IP no DuckDNS : ${dns_ip:-<não resolveu>}"
echo "  IP público    : ${public_ip:-<não obtido>}"
if [[ -z "$dns_ip" ]]; then
  bad "O domínio não resolve. Confira o nome em https://www.duckdns.org"
elif [[ -z "$public_ip" ]]; then
  warn "Não consegui descobrir o IP público (sem acesso à internet?)"
elif [[ "$dns_ip" == "$public_ip" ]]; then
  ok "DuckDNS aponta para esta internet"
else
  bad "DuckDNS aponta para OUTRO IP. O atualizador não está rodando (ver item 2)."
fi

# ---------------------------------------------------------------
h "2. Quem atualiza o DuckDNS neste servidor"
found=0
for f in /etc/crontab /etc/cron.d/* /var/spool/cron/crontabs/*; do
  [[ -f "$f" ]] && grep -Hn -i duckdns "$f" 2>/dev/null && found=1
done
for d in /root/duckdns /home/*/duckdns; do
  [[ -d "$d" ]] && { echo "  pasta: $d"; ls -1 "$d" | sed 's/^/     /'; found=1; }
done
systemctl list-timers --all 2>/dev/null | grep -i duck && found=1
(( found )) && ok "Atualizador encontrado (acima)" || warn "Nenhum atualizador. O IP pode ficar desatualizado se a operadora trocar seu IP."

# ---------------------------------------------------------------
h "3. Portas escutando (serviço antigo aparece aqui)"
ss -tlnpH 2>/dev/null | awk '{printf "  %-24s %s\n", $4, $6}' | sort -u
echo
for p in "$HTTPS_PORT" 8080 80 443; do
  line=$(ss -tlnpH "sport = :$p" 2>/dev/null | head -1)
  if [[ -z "$line" ]]; then
    echo "  porta $p: livre"
  else
    proc=$(echo "$line" | grep -oP 'users:\(\("\K[^"]+' || echo "?")
    addr=$(echo "$line" | awk '{print $4}')
    echo "  porta $p: ocupada por '$proc' em $addr"
  fi
done

h "4. Processos Node / gerenciadores (API antiga?)"
ps -eo pid,user,etime,cmd --sort=start_time | grep -E "[n]ode |[p]m2|[t]s-node|[n]pm (run|start)" | sed 's/^/  /' || true
command -v pm2 >/dev/null && { echo "  pm2:"; pm2 ls 2>/dev/null | sed 's/^/    /'; }
systemctl list-units --type=service --all --no-legend 2>/dev/null | grep -iE "node|fluxo|api|pm2|nginx|apache|caddy" | sed 's/^/  /'

# ---------------------------------------------------------------
h "5. Firewall"
if command -v ufw >/dev/null; then ufw status 2>/dev/null | sed 's/^/  /'; else echo "  ufw não instalado"; fi
if command -v nft >/dev/null; then
  rules=$(nft list ruleset 2>/dev/null | grep -cE "drop|reject")
  echo "  nftables: $rules regra(s) drop/reject"
fi

# ---------------------------------------------------------------
h "6. API nova e HTTPS"
port=$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]'); port=${port:-8080}
if systemctl is-active --quiet fluxo-api 2>/dev/null; then ok "serviço fluxo-api ativo"; else warn "serviço fluxo-api não está ativo"; fi
if curl -fsS --max-time 5 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
  ok "http://127.0.0.1:$port/health responde: $(curl -s --max-time 5 "http://127.0.0.1:$port/health")"
else
  warn "nada respondendo /health em 127.0.0.1:$port"
fi
if systemctl is-active --quiet caddy 2>/dev/null; then ok "Caddy ativo"; else warn "Caddy não está ativo"; fi
# Testa o Caddy local forçando o domínio para 127.0.0.1 (evita limitação do roteador)
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" "https://$DOMAIN:$HTTPS_PORT/health" 2>/dev/null)
[[ "$code" == "200" ]] && ok "HTTPS local ($DOMAIN:$HTTPS_PORT -> Caddy -> API): 200" || warn "HTTPS local respondeu: ${code:-sem resposta} (certificado ainda não emitido? veja journalctl -u caddy)"
if caddy list-modules 2>/dev/null | grep -q '^dns.providers.duckdns'; then ok "Caddy com plugin DuckDNS"; else warn "Caddy sem plugin DuckDNS (rode o setup.sh)"; fi
for p in 80 443; do
  ss -tlnpH "sport = :$p" 2>/dev/null | grep -q caddy && warn "Caddy escutando na porta $p (não deveria neste modo)"
done

echo
echo "Próximo passo: teste DE FORA da rede (celular no 4G/5G, Wi-Fi desligado):"
echo "   https://$DOMAIN:$HTTPS_PORT/health"
echo "   Se não abrir por fora mas o item 6 está OK: verifique o encaminhamento da porta $HTTPS_PORT no roteador ou CGNAT (README)."
