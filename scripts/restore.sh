#!/usr/bin/env bash
# Restaura un backup hecho con backup.sh.
# Uso:  ./scripts/restore.sh backups/blucaronews-AAAAMMDD-HHMM.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:?Indicá el .tar.gz a restaurar}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -C "$TMP" -xzf "$FILE"
# El contenedor corre como "node" (sin privilegios): que pueda leer los archivos a restaurar.
chmod 755 "$TMP"
chmod 644 "$TMP"/news.db "$TMP"/channels.json "$TMP"/feeds.json 2>/dev/null || true

echo "Deteniendo app y worker..."
docker compose stop app worker

docker compose run --rm --no-deps -T -v "$TMP:/restore:ro" --entrypoint sh app -c '
  set -e
  rm -f /data/news.db-wal /data/news.db-shm
  for f in news.db channels.json feeds.json; do
    if [ -f "/restore/$f" ]; then cp "/restore/$f" "/data/$f.tmp" && mv "/data/$f.tmp" "/data/$f" && echo "restaurado $f"; fi
  done
'
[ -f "$TMP/env.backup" ] && echo "Nota: el backup trae una copia de .env en env.backup (no se pisa la actual)."

docker compose up -d
echo "OK: restaurado desde $FILE"
