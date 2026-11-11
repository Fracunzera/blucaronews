#!/bin/sh
# Corre DENTRO del contenedor (lo llama build.sh). /src = carpeta android, /keys = keystore.
set -eu
BT=$ANDROID_HOME/build-tools/34.0.0
AJ=$ANDROID_HOME/platforms/android-34/android.jar
OUT=/src/build
rm -rf "$OUT" && mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

"$BT/aapt2" compile --dir /src/res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$AJ" --manifest /src/AndroidManifest.xml \
  --min-sdk-version 21 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --java "$OUT/gen" "$OUT/res.zip"

LIBS=/opt/libs/androidx-webkit.jar
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$AJ" -classpath "$LIBS" -d "$OUT/classes" \
  $(find /src/src "$OUT/gen" -name '*.java')
# androidx.webkit va adentro del dex. Sus referencias a androidx.core (WebViewAssetLoader,
# que no usamos) y a anotaciones quedan como avisos de d8, sin efecto en ejecución.
"$BT/d8" --release --min-api 21 --lib "$AJ" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class') "$LIBS" 2>&1 \
  | grep -v -E "^Warning|Missing class|androidx/(core|annotation)" || true
test -f "$OUT/dex/classes.dex"

cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q -j "$OUT/unsigned.apk" classes.dex)
"$BT/zipalign" -p -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

# Clave de firma: se crea una sola vez y se guarda FUERA del repo. Si se pierde, las
# teles con la app instalada no pueden actualizarla (hay que desinstalar y reinstalar).
if [ ! -f /keys/release.jks ]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=' > /keys/pass.txt
  keytool -genkeypair -keystore /keys/release.jks -storepass:file /keys/pass.txt -keypass:file /keys/pass.txt \
    -alias blucaronews -keyalg RSA -keysize 3072 -validity 18250 -dname "CN=Blucaro News" >/dev/null 2>&1
  chmod 600 /keys/release.jks /keys/pass.txt
  echo "Clave de firma nueva creada en el host (carpeta de claves)."
fi
"$BT/apksigner" sign --ks /keys/release.jks --ks-pass file:/keys/pass.txt --ks-key-alias blucaronews \
  --out "$OUT/blucaronews-tv.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/blucaronews-tv.apk"
echo "{\"versionName\":\"$VERSION_NAME\",\"versionCode\":$VERSION_CODE}" > "$OUT/version.json"
