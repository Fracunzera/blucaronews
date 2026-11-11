# Entorno para compilar el APK sin Gradle: JDK 17 + Android SDK (platform 34, build-tools 34).
# Se construye una sola vez (~700 MB) y queda como imagen local "blucaronews-android-builder".
FROM eclipse-temurin:17-jdk-jammy
RUN apt-get update && apt-get install -y --no-install-recommends unzip zip wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV ANDROID_HOME=/opt/android-sdk
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
 && wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O /tmp/clt.zip \
 && unzip -q /tmp/clt.zip -d $ANDROID_HOME/cmdline-tools \
 && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
 && rm /tmp/clt.zip \
 && yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null \
 && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-34" "build-tools;34.0.0" >/dev/null
# androidx.webkit (solo classes.jar): WebViewCompat.addDocumentStartJavaScript para el
# script de códec/diagnóstico dentro del reproductor oficial de YouTube. Checksum fijo.
RUN mkdir -p /opt/libs \
 && wget -q https://dl.google.com/android/maven2/androidx/webkit/webkit/1.12.1/webkit-1.12.1.aar -O /tmp/webkit.aar \
 && echo "18a0a51ad129e0c8563f031d46c8a7e61169f56ae84e562a0d75686941262111  /tmp/webkit.aar" | sha256sum -c - \
 && unzip -q -p /tmp/webkit.aar classes.jar > /opt/libs/androidx-webkit.jar \
 && rm /tmp/webkit.aar
