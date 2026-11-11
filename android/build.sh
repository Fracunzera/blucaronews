#!/usr/bin/env bash
# Compila el APK de Android TV y lo publica en el sitio (/tv.apk).
#   sudo ./android/build.sh            compila y publica
#   sudo ./android/build.sh --no-publish  solo compila (queda en android/build/)
# La clave de firma vive en $KEYS_DIR (por defecto /root/.blucaronews-apk): hacele backup.
set -euo pipefail
cd "$(dirname "$0")/.."
KEYS_DIR="${KEYS_DIR:-/root/.blucaronews-apk}"
IMAGE=blucaronews-android-builder
VERSION_CODE="${VERSION_CODE:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}"
VERSION_NAME="${VERSION_NAME:-1.0.$VERSION_CODE}"

mkdir -p "$KEYS_DIR" && chmod 700 "$KEYS_DIR"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" android/
docker run --rm -e VERSION_CODE="$VERSION_CODE" -e VERSION_NAME="$VERSION_NAME" \
  -v "$PWD/android:/src" -v "$KEYS_DIR:/keys" "$IMAGE" sh /src/build-in-container.sh

APK=android/build/blucaronews-tv.apk
echo "APK: $APK ($(du -h "$APK" | cut -f1)), versión $VERSION_NAME"
if [[ "${1:-}" != "--no-publish" ]]; then
  docker compose exec -T app mkdir -p /data/apk
  docker compose cp "$APK" app:/data/apk/blucaronews-tv.apk
  docker compose cp android/build/version.json app:/data/apk/version.json
  echo "Publicado: https://$(grep -E '^DOMAIN=' .env | cut -d= -f2)/tv.apk"
fi
