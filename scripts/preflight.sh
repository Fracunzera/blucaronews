#!/usr/bin/env bash
# Chequeos ANTES de levantar: qué hay corriendo en el VPS y en qué puertos, para no pisar nada.
# No modifica nada. Uso:  ./scripts/preflight.sh
set -uo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; WARN=1; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }
WARN=0; FAIL=0

echo "== Docker"
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then ok "Docker $(docker version -f '{{.Server.Version}}')"; else bad "Docker no está instalado o no corre."; fi
if docker compose version >/dev/null 2>&1; then ok "$(docker compose version)"; else bad "Falta el plugin 'docker compose'."; fi

echo "== Recursos"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
ok "RAM total: ${MEM_MB} MB (el stack usa ~150–250 MB)"
DISK=$(df -h / | awk 'NR==2 {print $4}')
ok "Disco libre en /: $DISK"

echo "== .env"
if [ ! -f .env ]; then
  bad "No existe .env (cp .env.example .env y completalo)."
else
  set -a; . ./.env 2>/dev/null; set +a
  [ -n "${DOMAIN:-}" ] && ok "DOMAIN=$DOMAIN" || bad "Falta DOMAIN."
  case "${CONTACT_EMAIL:-}" in ""|*CAMBIAR*|*ejemplo*) bad "CONTACT_EMAIL sin completar (aparece en /terminos).";; *) ok "CONTACT_EMAIL configurado";; esac
  case "${ADMIN_PASSWORD_HASH:-}" in scrypt\$*) ok "ADMIN_PASSWORD_HASH configurado";; *) warn "Falta ADMIN_PASSWORD_HASH (el panel /admin no va a dejar entrar).";; esac
fi
PROFILES="${COMPOSE_PROFILES:-}"
APP_PORT="${APP_LOCAL_PORT:-3080}"

echo "== Puertos en uso"
if command -v ss >/dev/null; then LISTEN=$(ss -H -ltnup 2>/dev/null)
elif command -v netstat >/dev/null; then LISTEN=$(netstat -ltnup 2>/dev/null | awk 'NR>2 {print $1, "x", "x", "x", $4, $0}')
else LISTEN="__unknown__"; warn "No hay 'ss' ni 'netstat' (apt install iproute2): no puedo verificar puertos."; fi
port_owner() { echo "$LISTEN" | awk -v p=":$1\$" '$5 ~ p {print $0}' | head -3; }
for P in 80 443 "$APP_PORT"; do
  [ "$LISTEN" = "__unknown__" ] && break
  OWN=$(port_owner "$P")
  if [ -z "$OWN" ]; then ok "Puerto $P libre"; continue; fi
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^blucaronews-'; then
    if echo "$OWN" | grep -q docker-proxy && docker ps --format '{{.Names}} {{.Ports}}' | grep '^blucaronews-' | grep -q ":$P->"; then
      ok "Puerto $P ya lo usa este mismo proyecto"; continue
    fi
  fi
  if [ "$P" = "$APP_PORT" ]; then bad "Puerto $P (APP_LOCAL_PORT) ocupado: cambiá APP_LOCAL_PORT en .env"; echo "$OWN" | sed 's/^/      /'; continue; fi
  if [[ ",$PROFILES," == *",caddy,"* ]]; then
    bad "Puerto $P ocupado y COMPOSE_PROFILES incluye caddy: chocarían."
  else
    ok "Puerto $P ocupado por otro proxy (COMPOSE_PROFILES sin caddy: OK, usá tu proxy)"
  fi
  echo "$OWN" | sed 's/^/      /'
done

echo "== Proxies / servidores web detectados"
FOUND=0
OWN_CADDY=$(docker ps -q --filter name=^blucaronews-caddy 2>/dev/null)
for s in nginx apache2 httpd caddy traefik haproxy; do
  [ "$s" = caddy ] && [ -n "$OWN_CADDY" ] && continue  # es el de este proyecto
  if pgrep -x "$s" >/dev/null 2>&1; then warn "Proceso '$s' corriendo en el host"; FOUND=1; fi
done
if command -v docker >/dev/null; then
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null | grep -Ei 'nginx|traefik|caddy|haproxy|apache|proxy' | grep -v '^blucaronews-' | while read -r l; do echo "      contenedor: $l"; done
fi
[ "$FOUND" = 0 ] && ok "Ningún proxy en el host"

echo "== Contenedores corriendo (todos)"
docker ps --format '      {{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null || true

echo "== DNS"
if [ -n "${DOMAIN:-}" ]; then
  DNS_IP=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')
  PUB_IP=$(curl -4 -s --max-time 5 https://api.ipify.org || true)
  if [ -z "$DNS_IP" ]; then bad "$DOMAIN no resuelve todavía (creá el registro A apuntando a ${PUB_IP:-la IP del VPS})."
  elif [ -n "$PUB_IP" ] && [ "$DNS_IP" != "$PUB_IP" ]; then warn "$DOMAIN apunta a $DNS_IP pero este VPS sale por $PUB_IP (¿Cloudflare proxy? desactivá la nube naranja para emitir el certificado)."
  else ok "$DOMAIN -> $DNS_IP"; fi
fi

echo "== Firewall"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw status | grep -E '^(80|443)' >/dev/null && ok "ufw permite 80/443" || warn "ufw activo: abrí 80/tcp, 443/tcp y 443/udp (ufw allow 80,443/tcp; ufw allow 443/udp)"
else ok "ufw inactivo o no instalado (revisá el firewall del proveedor)"; fi

echo
if [ "$FAIL" = 1 ]; then echo "Resultado: ✗ hay problemas que resolver antes de 'docker compose up -d'."; exit 1; fi
[ "$WARN" = 1 ] && echo "Resultado: ⚠ se puede levantar, pero revisá las advertencias." || echo "Resultado: ✓ todo listo para 'docker compose up -d --build'."
