#!/usr/bin/env bash
# Backup de Blucaro News: base SQLite (copia consistente) + channels.json + feeds.json.
# Uso:  ./scripts/backup.sh            -> backups/blucaronews-AAAAMMDD-HHMM.tar.gz
# Cron diario (ejemplo):  15 4 * * * cd /opt/blucaronews && ./scripts/backup.sh >/dev/null
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p backups

# Corre con el mismo volumen "data" que la app; escribe en un directorio temporal del host.
docker compose run --rm --no-deps -T --user root \
  -v "$TMP:/backup" app node src/backup.js /backup

# Opcional: también la config local (.env tiene secretos: el tar queda con permisos 600).
cp .env "$TMP/env.backup" 2>/dev/null || true

OUT="backups/blucaronews-$STAMP.tar.gz"
tar -C "$TMP" -czf "$OUT" .
chmod 600 "$OUT"
echo "OK: $OUT ($(du -h "$OUT" | cut -f1))"

# Rotación
find backups -name 'blucaronews-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
