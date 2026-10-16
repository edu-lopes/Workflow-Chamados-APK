#!/usr/bin/env bash
# Atualiza o IP público no DuckDNS. Agendado pelo setup.sh em /etc/cron.d/duckdns.
# Configuração em /etc/fluxo-api/duckdns.env:
#   DUCKDNS_DOMAIN=seu-subdominio      (sem .duckdns.org)
#   DUCKDNS_TOKEN=xxxxxxxx-xxxx-...
set -euo pipefail
source /etc/fluxo-api/duckdns.env
result=$(curl -fsS --max-time 20 "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=")
if [[ "$result" != "OK" ]]; then
  logger -t duckdns "Falha ao atualizar ${DUCKDNS_DOMAIN}: ${result}"
  exit 1
fi
