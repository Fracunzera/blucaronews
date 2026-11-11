#!/usr/bin/env bash
# Pruebas DESPUÉS de levantar: HTTPS, API, ticker que se actualiza, headers de seguridad.
# Uso:  ./scripts/verify.sh          (tarda ~2–3 minutos por la prueba del ticker)
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a

DOMAIN="${DOMAIN:?Falta DOMAIN en .env}"
LOCAL="http://127.0.0.1:${APP_LOCAL_PORT:-3080}"
BASE="https://$DOMAIN"
FAIL=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

echo "== Contenedores"
docker compose ps --format '  {{.Service}}: {{.State}} {{.Status}}'

echo "== App local ($LOCAL)"
H=$(curl -s --max-time 5 "$LOCAL/api/health")
[ -n "$H" ] && ok "health: $H" || bad "La app no responde en $LOCAL"

if [[ ",${COMPOSE_PROFILES:-}," == *",caddy,"* ]] || curl -s -o /dev/null --max-time 5 "$BASE"; then
  echo "== HTTPS ($BASE)"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/")
  [ "$CODE" = 200 ] && ok "GET / -> 200 por HTTPS (certificado válido)" || bad "GET / -> $CODE (si es 000: certificado aún no emitido, DNS o firewall; ver: docker compose logs caddy)"
  ISSUER=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -issuer -enddate 2>/dev/null | tr '\n' ' ')
  [ -n "$ISSUER" ] && ok "Certificado: $ISSUER"
  R=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "http://$DOMAIN/")
  [[ "$R" == 30* ]] && ok "HTTP redirige a HTTPS ($R)" || bad "HTTP no redirige a HTTPS ($R)"
  HDR=$(curl -sI --max-time 10 "$BASE/")
  for h in content-security-policy strict-transport-security referrer-policy x-content-type-options; do
    echo "$HDR" | grep -qi "^$h:" && ok "Header $h" || bad "Falta header $h"
  done
  curl -s --max-time 10 "$BASE/terminos" | grep -q "${CONTACT_EMAIL:-@}" && ok "/terminos muestra el mail de contacto" || bad "/terminos no muestra CONTACT_EMAIL"
  BASEAPI="$BASE"
else
  echo "== HTTPS: perfil caddy desactivado y $BASE no responde; pruebo solo local."
  BASEAPI="$LOCAL"
fi

echo "== Datos"
D=$(curl -s --max-time 10 "$BASEAPI/api/data")
echo "$D" | json "'Dólar oficial venta: %s, blue: %s' % (d['dolar']['casas']['oficial']['venta'], d['dolar']['casas']['blue']['venta'])" | sed 's/^/  ✓ /' || bad "Sin datos de dólar"
echo "$D" | json "'Clima %s: %s°C, viento %s km/h' % (d['clima']['lugar'], d['clima']['temp'], d['clima']['viento'])" | sed 's/^/  ✓ /' || bad "Sin datos de clima"

echo "== Canales"
curl -s --max-time 10 "$BASEAPI/api/channels" | json "'%d canales: ' % len(d['channels']) + ', '.join(c['name'] for c in d['channels'])" | sed 's/^/  ✓ /' || bad "No responde /api/channels"

echo "== Ticker / titulares (espera una pasada del worker)"
N1=$(curl -s "$BASEAPI/api/news?limit=1" | json "d['worker']['lastRss']")
C1=$(curl -s "$BASEAPI/api/health" | json "d['news']")
[ -n "$N1" ] && ok "Última lectura RSS: $(date -d @$((N1/1000)) '+%H:%M:%S'), $C1 titulares" || bad "El worker todavía no leyó feeds"
WAIT=$(( ${RSS_INTERVAL_SEC:-90} + 30 ))
echo "  … esperando hasta ${WAIT}s a la próxima pasada"
for _ in $(seq 1 $((WAIT/5))); do
  sleep 5
  N2=$(curl -s "$BASEAPI/api/news?limit=1" | json "d['worker']['lastRss']")
  [ -n "$N2" ] && [ "$N2" != "$N1" ] && break
done
if [ -n "${N2:-}" ] && [ "${N2:-}" != "$N1" ]; then
  C2=$(curl -s "$BASEAPI/api/health" | json "d['news']")
  ok "El worker volvió a leer a las $(date -d @$((N2/1000)) '+%H:%M:%S') ($C2 titulares) → el ticker se actualiza"
else
  bad "El worker no hizo una nueva pasada en ${WAIT}s (docker compose logs worker)"
fi
curl -s "$BASEAPI/api/news?limit=300" | json "'\n'.join(('  ✓ ' if s['ok'] else '  ⚠ ') + '%s: %d titulares' % (s['name'], s['count']) for s in d['sources'])"

echo "== Embeds"
echo "  ℹ La reproducción de YouTube/Twitch ocurre en el navegador de cada usuario (directo del medio)."
echo "    Abrí $BASE en un navegador y confirmá que los paneles muestren '● EN VIVO' o 'Listo · tocá ▶'."

echo
[ "$FAIL" = 0 ] && echo "Resultado: ✓ todo OK" || { echo "Resultado: ✗ hay fallas (ver arriba)"; exit 1; }
