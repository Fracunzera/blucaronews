# Blucaro News — monitor de medios argentinos

Una sola pantalla con varias señales en vivo, titulares de noticias y datos útiles (dólar y clima de Río Gallegos). Es un proyecto personal sin fines de lucro, pensado para dejarlo abierto todo el día en un monitor y que también se pueda usar en el celular.

- **Grilla de 1, 4 o 9 paneles.** Cada panel tiene su selector de canal. La combinación se guarda en el navegador y se comparte por URL (`/?g=3&c=tn,c5n,...`).
- **Ticker y columna de titulares.** La columna se filtra por medio. Los titulares vienen de RSS y se actualizan cada 1–2 minutos.
- **Dólar** oficial, blue y MEP, más el **clima**. El backend los cachea: el navegador nunca llama a terceros para esos datos.
- **Panel `/admin`** para sumar o quitar canales y feeds sin tocar archivos. Tiene un solo usuario y la contraseña hasheada con scrypt.
- Tema oscuro por defecto, con opción de tema claro. En el celular se ve un solo panel con selector.

## Reglas legales (cómo se cumplen)

| Regla | Implementación |
|---|---|
| Solo reproductores oficiales | El frontend inserta el iframe de YouTube (`youtube.com/embed/live_stream?channel=…`), el de Twitch (`player.twitch.tv`) o el player embebible de la radio. El servidor **nunca** toca audio ni video: no hay proxy, ni captura, ni re-encode, ni m3u8. La CSP solo permite frames de esos orígenes. |
| Si el medio no permite incrustar, no se agrega | Al guardar un canal de YouTube o un iframe, el backend lo verifica: el oEmbed oficial de YouTube devuelve 401 si el dueño desactivó la inserción, y para los iframes se revisan `X-Frame-Options` y `frame-ancestors`. Si falla, se rechaza con 422. |
| Sin deportes con derechos exclusivos | La categoría se llama "Deportes (sin derechos)" y el catálogo inicial no trae ninguno. Hay que revisarlo a mano antes de cada alta. |
| Noticias: solo titular, medio y link | En SQLite se guarda solo título, medio, link, fecha y la bajada del RSS **recortada a 240 caracteres**. `content:encoded` se descarta sin leerlo. Todo se borra a las 48 h. Cada titular muestra el medio y enlaza a la nota original. |
| Sin logos de medios en la marca | La marca es texto ("Blucaro News") y el favicon es una grilla genérica. |
| `/terminos` | Explica que el contenido es de sus autores y que no se retransmiten señales. Tiene el mail de altas y bajas (`CONTACT_EMAIL`) con resolución en 48 h. |

## Arquitectura, servicios y puertos

```
                Internet
                   │  80/tcp, 443/tcp, 443/udp (HTTP/3)
            ┌──────▼──────┐
            │    caddy    │  HTTPS automático (Let's Encrypt)
            └──────┬──────┘
                   │ red interna de Docker
            ┌──────▼──────┐      127.0.0.1:3080 (solo localhost, para chequeos)
            │     app     │  Node 24 + Fastify: páginas, API, /admin
            └──────┬──────┘
                   │ volumen "data": news.db (SQLite), channels.json, feeds.json
            ┌──────┴──────┐
            │   worker    │  RSS cada 90 s, dólar cada 5 min, clima cada 15 min
            └─────────────┘  (sin puertos)
```

| Servicio | Imagen | Puertos | RAM medida |
|---|---|---|---|
| `caddy` | `caddy:2.10-alpine` | **80, 443/tcp, 443/udp** públicos | ~15 MB |
| `app` | `blucaronews-app` (node:24-alpine) | 3000 interno + `127.0.0.1:3080` | ~30 MB |
| `worker` | la misma imagen | ninguno | ~60 MB |

**¿Por qué Node?** Es un solo lenguaje para front, back y worker. SQLite ya viene en Node 24 (`node:sqlite`), así que no hay dependencias compiladas. Todo el stack ocupa unos 100 MB de RAM.

Los contenedores corren como usuario sin privilegios, con sistema de archivos de solo lectura, `cap_drop: ALL`, límites de memoria y logs rotados.

## Instalación en el VPS

Requisitos: Docker con el plugin Compose, el dominio apuntando al VPS (registro A) y los puertos 80/443 abiertos. Los scripts de chequeo también usan `curl`, `python3`, `openssl` y `ss` (paquete iproute2), que vienen instalados en Ubuntu y Debian.

1. Cloná el repo:

```bash
sudo git clone https://github.com/fracunzera/blucaronews.git /opt/blucaronews
```

2. Creá el `.env` a partir del ejemplo:

```bash
cd /opt/blucaronews && sudo cp .env.example .env
```

3. Generá el hash de la contraseña del admin:

```bash
sudo docker compose build && sudo docker compose run --rm -it app node src/hash-password.js
```

4. Editá `.env`: `DOMAIN`, `CONTACT_EMAIL` y `ADMIN_PASSWORD_HASH`. Pegá el hash tal cual sale del paso anterior, **con las comillas simples**.

```bash
sudo nano .env
```

5. Revisá qué hay corriendo y en qué puertos. El script no modifica nada:

```bash
sudo ./scripts/preflight.sh
```

6. Levantá el stack:

```bash
sudo docker compose up -d --build
```

7. Verificá HTTPS, la API y que el ticker se actualice. Tarda unos 2 minutos:

```bash
sudo ./scripts/verify.sh
```

Después abrí `https://news.blucaro.site` en un navegador y fijate que los paneles muestren **● EN VIVO** o **▶ Listo**. Los embeds se reproducen en el navegador de cada usuario, así que esa prueba no se puede hacer desde el servidor.

### Si el VPS ya tiene nginx, Traefik u otro proxy en 80/443

En `.env` dejá `COMPOSE_PROFILES=` vacío. Así no se levanta Caddy, y la app queda en `127.0.0.1:3080`. Ejemplo para nginx, con el certificado sacado con certbot:

```nginx
server {
    listen 443 ssl http2;
    server_name news.blucaro.site;
    # ssl_certificate ... (certbot --nginx -d news.blucaro.site)
    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Cómo agregar canales

**Desde `/admin` (recomendado):** completá el formulario y apretá "Verificar embed". Al guardar, el servidor vuelve a verificar y rechaza el canal si el medio no permite incrustarlo.

| Tipo | `source` | Ejemplo |
|---|---|---|
| `youtube` | ID del canal (empieza con `UC`, 24 caracteres). También acepta la URL `youtube.com/channel/UC…`. | `UCFgk2Q2mVO1BklRQhSv6p0w` |
| `twitch` | Usuario del canal | `nombredelcanal` |
| `iframe` | URL **https** del player embebible que publica el medio | `https://radio.ejemplo/player` |
| `audio` | URL **https** del stream que la propia radio publica para escuchar en vivo. El navegador lo reproduce directo desde el servidor de la radio; nunca pasa por el nuestro. | `https://stream.radio.ejemplo/live.mp3` |

Para sacar el ID de un canal de YouTube, abrí el canal → "Más información" → "Compartir canal" → "Copiar ID del canal". Otra opción es ver el código fuente de la página y buscar `"externalId"`.

Categorías disponibles: `noticias`, `aire`, `radio`, `economia`, `provinciales`, `santa-cruz`, `deportes` (sin derechos), `internacionales`.

**Editando el archivo:** los catálogos viven en el volumen, no en la carpeta `config/` (esa carpeta es solo la semilla del primer arranque). Bajá el archivo a una copia local:

```bash
sudo docker compose cp app:/data/channels.json ./channels.json
```

Editalo:

```bash
sudo nano channels.json
```

Y volvé a subirlo. Se aplica solo, sin reiniciar:

```bash
sudo docker compose cp ./channels.json app:/data/channels.json
```

Con `feeds.json` es igual. Si lo editás a mano, la verificación de embed corre por tu cuenta: usá "Verificar embed" en `/admin`.

## Cómo agregar feeds RSS

En `/admin`, en la sección "Feeds RSS", completá medio, ID y URL. Apretá "Probar feed" para ver cuántos titulares trae y guardá. El worker lo lee en la próxima pasada (menos de 2 minutos). La tabla muestra el estado de cada feed: ✓ OK con la hora, o ⚠ con el error.

## Estado "EN VIVO" de YouTube (opcional)

Sin configurar nada, cada panel carga el vivo actual del canal y muestra el estado que informa el reproductor (● EN VIVO, ⚠ Señal no disponible, etc.).

Si cargás `YT_API_KEY` (YouTube Data API v3, gratis), el worker averigua el **ID del vivo** de cada canal y el panel inserta ese video. Esto hace falta porque el formato genérico `embed/live_stream?channel=…` da error 150 en algunos canales que sí permiten insertar el vivo (pasaba con Canal 26 y Crónica). También muestra "○ Sin transmisión en vivo" en los canales sin vivo y "El medio no permite incrustar este vivo" cuando el dueño lo bloqueó (Telefe Noticias). Los vivos nuevos salen del feed del canal (gratis); los 24 h, que quedan fuera del feed, se buscan con `search.list` (100 unidades) como mucho cada 90 minutos por canal y solo mientras no haya un vivo conocido, con un tope de 7.000 unidades por día de las 10.000 gratuitas. No se descarga ningún video. Si la key tiene restricción por IP, tiene que ser la IPv4 del VPS: los contenedores salen por IPv4.

## App para TV, celular e instalación

- **Modo TV.** Se activa solo en navegadores de tele y en la app de Android TV, o a mano con `/?tv=1` (`/?tv=0` lo apaga). Con las flechas del control te movés entre paneles y botones. **OK sobre un panel activa o silencia su sonido**: todos arrancan silenciados y podés tener varios con sonido. El canal se cambia con el selector de cada panel, que en Android TV abre la lista nativa. El volumen se maneja con el de la tele.
- **App de Android TV, Google TV y Fire TV.** Es un WebView mínimo (`android/`, unos 28 KB) que abre la página en modo TV y aparece en el inicio con banner. No necesita cuenta en ninguna tienda: se instala con Downloader o desde un pendrive. Las instrucciones para el usuario están en **`/tv`**, y la descarga en **`/tv.apk`**.
- **PWA.** En el celular o la compu se puede "instalar" desde el navegador (botón *Instalar app* o *Agregar a pantalla de inicio*). El service worker solo cachea la página. Nunca cachea `/api/*` ni los reproductores.
- **Titulares incrementales.** Después de la primera carga, el navegador pide `/api/news?after=<maxId>` y recibe solo los titulares nuevos, cerca de 1 KB por minuto.

Para compilar y publicar el APK (la primera vez arma una imagen de Docker de unos 700 MB con el SDK de Android):

```bash
sudo ./android/build.sh
```

El APK queda en el volumen de datos (`/data/apk`), no en git. La **clave de firma** se crea la primera vez en `/root/.blucaronews-apk/`. Hacele backup: si se pierde, las teles que ya tienen la app no pueden actualizarla y hay que desinstalarla y volver a instalarla. Los íconos y el banner se regeneran con `python3 scripts/make-icons.py`.

## Backup y restore

Para hacer un backup:

```bash
sudo ./scripts/backup.sh
```

Genera `backups/blucaronews-AAAAMMDD-HHMM.tar.gz` con `news.db` (copia consistente con `VACUUM INTO`, se puede hacer con la app andando), `channels.json`, `feeds.json` y una copia de `.env`. El archivo queda con permisos 600 y la rotación borra los de más de 14 días.

Para un backup diario, agregá esta línea al crontab de root (`sudo crontab -e`):

```
15 4 * * * cd /opt/blucaronews && ./scripts/backup.sh >/dev/null 2>&1
```

Para restaurar:

```bash
sudo ./scripts/restore.sh backups/blucaronews-20261111-0415.tar.gz
```

Lo más valioso son los catálogos. Los titulares se regeneran solos en minutos y los certificados de Caddy se vuelven a emitir solos.

## Operación

Para actualizar a la última versión, traé los cambios:

```bash
cd /opt/blucaronews && sudo git pull
```

Y reconstruí:

```bash
sudo docker compose up -d --build
```

Para ver los logs:

```bash
sudo docker compose logs -f --tail=50 worker
```

Para ver el estado del worker y de los datos:

```bash
curl -s http://127.0.0.1:3080/api/health
```

**Problemas frecuentes:**
- **No sale el certificado:** revisá `docker compose logs caddy`. Suele ser el DNS sin propagar o el firewall del proveedor cerrando 80/443. Si usás Cloudflare, desactivá el proxy (nube naranja) o usá el modo "Full (strict)".
- **"⚠ Señal no disponible" en un panel:** el medio no está en vivo, desactivó la inserción, o YouTube bloqueó la reproducción. El botón **Reintentar** vuelve a cargar el player oficial.
- **"⚠ feed con error" en el filtro de medios:** en `/admin` está el detalle del error. Hay medios que bloquean lectores automáticos, y en ese caso se reemplazan por otro.

## Catálogo inicial (verificado el 11/11/2026)

**12 canales (YouTube).** Para cada uno se verificó el ID con el feed oficial del canal y que su vivo tenga `embeddable=true` en la API:
- TN Todo Noticias, C5N, A24, La Nación (LN+), Canal 26 y Crónica TV (noticias)
- Luzu TV (aire)
- Radio Mitre y Urbana Play 104.3 (radio)
- Canal 9 Santa Cruz (Santa Cruz)
- DW Español y France 24 Español (internacionales)

**Telefe Noticias** no está: su vivo tiene la inserción desactivada (`embeddable=false`). Canal 26, Radio Mitre y Crónica daban error 150 con el embed genérico `live_stream?channel=` (Canal 26 tiene dos vivos a la vez); con `YT_API_KEY` el panel usa el ID del vivo y funcionan.

**15 feeds RSS:** Infobae, Noticias Argentinas, La Nación, Página/12, Perfil, Ámbito, El Cronista, iProfesional, Diario Norte, LM Neuquén, MinutoUno, TiempoSur (Santa Cruz), Río Negro, El Economista y elDiarioAR.

Feeds descartados:
- **Clarín y TN** rechazan lectores automáticos identificados (HTTP 403). No se intentó esquivar ese bloqueo.
- **Tiempo Argentino** tenía el RSS comprometido con spam.
- **La Opinión Austral** y **El Destape** no publican un RSS accesible.
- **Chequeado** publica poco y no tenía nada de las últimas 48 h.

## Estructura

```
/opt/blucaronews/
├── docker-compose.yml     # caddy (perfil "caddy"), app, worker, volúmenes
├── Caddyfile              # HTTPS automático para $DOMAIN
├── .env.example           # configuración (copiar a .env)
├── config/                # semillas: channels.json, feeds.json (solo primer arranque)
├── app/
│   ├── Dockerfile
│   ├── src/
│   │   ├── server.js      # páginas, API pública, /admin, CSP
│   │   ├── worker.js      # RSS + dólar + clima + vivos de YouTube
│   │   ├── rss.js         # parser RSS/Atom (solo titular y bajada)
│   │   ├── sources.js     # dolarapi/bluelytics, Open-Meteo, YouTube oEmbed/API
│   │   ├── catalog.js     # catálogos editables con escritura atómica + validación
│   │   ├── auth.js        # scrypt, sesiones, límite de intentos
│   │   ├── db.js          # SQLite (WAL) y esquema
│   │   ├── backup.js
│   │   └── hash-password.js
│   ├── public/            # index, admin, terminos, app.js, styles.css (sin frameworks)
│   └── test/              # node --test
└── scripts/
    ├── preflight.sh       # qué corre y en qué puertos, ANTES de levantar
    ├── verify.sh          # HTTPS, API, ticker, headers, DESPUÉS de levantar
    ├── backup.sh
    └── restore.sh
```

Para correr los tests (requiere Node 24):

```bash
cd app && npm ci && npm test
```
