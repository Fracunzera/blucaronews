// Servidor web: páginas estáticas, API pública de lectura y panel admin.
// Nunca toca ni retransmite señales de audio/video: solo entrega el catálogo para
// que el navegador cargue el reproductor OFICIAL de cada medio.
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { getDb, kvGet } from './db.js';
import {
  CATEGORIES, TYPES, ensureSeeds, getChannels, getFeeds, validateChannel, validateFeed,
  saveChannel, deleteChannel, saveFeed, deleteFeed, moveChannel,
} from './catalog.js';
import {
  COOKIE, checkCredentials, createSession, destroySession, validSession,
  loginBlocked, loginFailed, loginSucceeded,
} from './auth.js';
import { fetchFeed } from './rss.js';
import { checkYoutubeEmbeddable } from './sources.js';
import { settings } from './settings.js';

ensureSeeds();
const db = getDb();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: true, // detrás de Caddy (el puerto 3000 no se publica a Internet)
  bodyLimit: 32 * 1024,
});

await app.register(fastifyCookie);

// ---------- cabeceras de seguridad + CSP armada desde el catálogo ----------

function originsFor(type) {
  const set = new Set();
  for (const c of getChannels()) {
    if (c.type !== type) continue;
    try { set.add(new URL(c.source).origin); } catch {}
  }
  return [...set];
}

function buildCsp() {
  const frames = ['https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.twitch.tv', ...originsFor('iframe')];
  const media = ["'self'", ...originsFor('audio')];
  return [
    "default-src 'self'",
    "script-src 'self' https://www.youtube.com https://s.ytimg.com",
    "style-src 'self'",
    "img-src 'self' data: https://i.ytimg.com",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${frames.join(' ')}`,
    `media-src ${media.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

app.addHook('onSend', async (req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  // YouTube exige Referer en los embeds: no usar "no-referrer".
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  const ct = String(reply.getHeader('content-type') || '');
  if (ct.startsWith('text/html')) reply.header('Content-Security-Policy', buildCsp());
  if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  return payload;
});

await app.register(fastifyStatic, {
  root: settings.publicDir,
  index: false,
  wildcard: false,
  cacheControl: true,
  maxAge: 0, // revalida con ETag: liviano y siempre fresco tras un deploy
});

// ---------- páginas ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(file) {
  const raw = fs.readFileSync(path.join(settings.publicDir, file), 'utf8');
  return raw
    .replaceAll('{{SITE}}', esc(settings.siteName))
    .replaceAll('{{EMAIL}}', esc(settings.contactEmail))
    .replaceAll('{{DOMAIN}}', esc(settings.domain));
}
const pages = { index: page('index.html'), terminos: page('terminos.html'), admin: page('admin.html') };

app.get('/', (req, reply) => reply.type('text/html; charset=utf-8').send(pages.index));
app.get('/terminos', (req, reply) => reply.type('text/html; charset=utf-8').send(pages.terminos));
app.get('/admin', (req, reply) => reply.header('X-Robots-Tag', 'noindex').type('text/html; charset=utf-8').send(pages.admin));
// ---------- app de Android TV ----------
// El APK se arma con android/build.sh y se copia al volumen de datos (no va en la imagen
// ni en git). /tv explica cómo instalarlo; /tv.apk lo descarga.
const APK_PATH = path.join(settings.dataDir, 'apk', 'blucaronews-tv.apk');
const APK_INFO = path.join(settings.dataDir, 'apk', 'version.json');

function apkInfo() {
  try {
    const st = fs.statSync(APK_PATH);
    let v = {};
    try { v = JSON.parse(fs.readFileSync(APK_INFO, 'utf8')); } catch {}
    const mb = (st.size / 1024 / 1024).toFixed(st.size < 1024 * 1024 ? 2 : 1);
    return `Versión ${esc(v.versionName || '1.0')} · ${mb} MB · actualizada el ${new Date(st.mtimeMs).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`;
  } catch {
    return 'El APK todavía no está publicado en este servidor.';
  }
}

app.get('/remote', (req, reply) => reply.header('X-Robots-Tag', 'noindex').type('text/html; charset=utf-8').send(page('remote.html')));

app.get('/tv', (req, reply) => reply.type('text/html; charset=utf-8').send(page('tv.html').replaceAll('{{APK_INFO}}', apkInfo())));

// Es la misma app para la tele y para el celu: /app.apk es el mismo archivo.
function sendApk(req, reply) {
  let st;
  try { st = fs.statSync(APK_PATH); } catch {
    return reply.code(404).type('text/plain; charset=utf-8').send('Todavía no hay APK publicado. Ver /tv');
  }
  return reply
    .header('Content-Type', 'application/vnd.android.package-archive')
    .header('Content-Disposition', 'attachment; filename="blucaronews.apk"')
    .header('Content-Length', st.size)
    .header('Cache-Control', 'no-cache')
    .send(fs.createReadStream(APK_PATH));
}
app.get('/tv.apk', sendApk);
app.get('/app.apk', sendApk);

app.get('/robots.txt', (req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /api/\n'));

// ---------- API pública (solo lectura) ----------

app.get('/api/channels', () => {
  const live = kvGet('ytlive');
  return {
    categories: CATEGORIES,
    channels: getChannels().map(({ id, name, category, type, source }) => ({ id, name, category, type, source })),
    // Solo si hay YT_API_KEY: { [channelId]: { live, videoId, embeddable } }
    youtube: live && live.value?.status ? { updatedAt: live.updatedAt, status: live.value.status } : null,
  };
});

const newsStmt = {
  all: db.prepare('SELECT id, feed_id, source, title, link, summary, published_at FROM news ORDER BY published_at DESC LIMIT ?'),
  byFeed: db.prepare('SELECT id, feed_id, source, title, link, summary, published_at FROM news WHERE feed_id = ? ORDER BY published_at DESC LIMIT ?'),
  counts: db.prepare('SELECT feed_id, source, COUNT(*) AS n, MAX(published_at) AS last FROM news GROUP BY feed_id'),
  // Incremental: el id es el rowid (crece con cada alta), así el cliente pide solo lo nuevo.
  after: db.prepare('SELECT id, feed_id, source, title, link, summary, published_at FROM news WHERE id > ? ORDER BY published_at DESC LIMIT ?'),
  maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM news'),
};

app.get('/api/news', (req) => {
  const limit = Math.max(1, Math.min(300, Number(req.query.limit) || 150));
  const feed = typeof req.query.feed === 'string' ? req.query.feed.slice(0, 40) : '';
  // ?after=<maxId de la respuesta anterior>: solo los titulares agregados desde entonces.
  // Todos los clientes al día piden el mismo "after", así que la caché de nginx los agrupa.
  const after = Number.parseInt(req.query.after, 10);
  const maxId = Number(newsStmt.maxId.get().m);
  const incremental = Number.isSafeInteger(after) && after >= 0 && !feed;
  const rows = incremental
    ? newsStmt.after.all(after, limit)
    : feed ? newsStmt.byFeed.all(feed, limit) : newsStmt.all.all(limit);
  const counts = Object.fromEntries(newsStmt.counts.all().map((r) => [r.feed_id, r]));
  const status = kvGet('feedstatus')?.value || {};
  const worker = kvGet('worker')?.value || null;
  return {
    worker: worker && { lastRss: worker.lastRss, intervalSec: worker.intervalSec },
    maxId,
    incremental,
    sources: getFeeds()
      .filter((f) => f.enabled !== false)
      .map((f) => ({ id: f.id, name: f.name, count: counts[f.id]?.n || 0, ok: status[f.id]?.ok ?? null })),
    items: rows.map((r) => ({
      id: r.id, feed: r.feed_id, source: r.source, title: r.title, link: r.link, summary: r.summary, ts: r.published_at,
    })),
  };
});

app.get('/api/data', () => {
  const dolar = kvGet('dolar');
  const clima = kvGet('clima');
  return {
    dolar: dolar && { ...dolar.value, updatedAt: dolar.updatedAt },
    clima: clima && { ...clima.value, updatedAt: clima.updatedAt },
  };
});

app.get('/healthz', () => ({ ok: true }));

app.get('/api/health', (req, reply) => {
  const w = kvGet('worker');
  const age = w ? Math.round((Date.now() - w.value.lastRss) / 1000) : null;
  const n = db.prepare('SELECT COUNT(*) AS n FROM news').get().n;
  const ok = age !== null && age < 600;
  reply.code(ok ? 200 : 503);
  return { ok, workerLastRssAgeSec: age, news: n, jobs: {
    dolar: kvGet('job:dolar')?.value || null,
    clima: kvGet('job:clima')?.value || null,
    youtube: kvGet('job:youtube')?.value || null,
  } };
});

// ---------- Admin ----------

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // navegadores viejos; igual queda SameSite=Strict
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function cookieOpts(maxAge) {
  return { path: '/', httpOnly: true, sameSite: 'strict', secure: settings.cookieSecure, maxAge };
}

app.post('/api/admin/login', async (req, reply) => {
  const ip = req.ip;
  if (!sameOrigin(req)) return reply.code(403).send({ error: 'Origen no permitido.' });
  if (loginBlocked(ip)) return reply.code(429).send({ error: 'Demasiados intentos. Probá de nuevo en 15 minutos.' });
  const { user, password } = req.body || {};
  if (!settings.adminPasswordHash) return reply.code(503).send({ error: 'Falta configurar ADMIN_PASSWORD_HASH en .env.' });
  if (typeof user !== 'string' || typeof password !== 'string' || !checkCredentials(user, password)) {
    loginFailed(ip);
    req.log.warn({ ip }, 'login fallido');
    return reply.code(401).send({ error: 'Usuario o contraseña incorrectos.' });
  }
  loginSucceeded(ip);
  const s = createSession();
  reply.setCookie(COOKIE, s.token, cookieOpts(s.maxAge));
  return { ok: true };
});

app.post('/api/admin/logout', async (req, reply) => {
  destroySession(req.cookies[COOKIE]);
  reply.clearCookie(COOKIE, { path: '/' });
  return { ok: true };
});

app.get('/api/admin/me', (req) => ({ loggedIn: validSession(req.cookies[COOKIE]), user: settings.adminUser }));

// Todo lo de /api/admin/* (menos login/logout/me) exige sesión + mismo origen + cabecera anti-CSRF.
app.addHook('preHandler', async (req, reply) => {
  const url = req.routeOptions.url || '';
  if (!url.startsWith('/api/admin/') || ['/api/admin/login', '/api/admin/logout', '/api/admin/me'].includes(url)) return;
  if (!validSession(req.cookies[COOKIE])) return reply.code(401).send({ error: 'Sesión vencida. Volvé a entrar.' });
  if (req.method !== 'GET' && (req.headers['x-bn-csrf'] !== '1' || !sameOrigin(req))) {
    return reply.code(403).send({ error: 'Petición rechazada (CSRF).' });
  }
});

function sendErrors(reply, errors) {
  return reply.code(400).send({ error: errors.join(' ') });
}

app.get('/api/admin/catalog', () => ({
  categories: CATEGORIES,
  types: TYPES,
  channels: getChannels(),
  feeds: getFeeds(),
  feedStatus: kvGet('feedstatus')?.value || {},
}));

// Regla: si el medio no permite que lo incrusten, no se agrega (YouTube e iframes
// se verifican siempre; audio y Twitch quedan a criterio del admin).
async function mustBeEmbeddable(value, previous) {
  if (!['youtube', 'iframe'].includes(value.type)) return null;
  if (previous && previous.type === value.type && previous.source === value.source) return null;
  const r = await checkChannel(value);
  return r.ok ? null : r.detalle;
}

app.post('/api/admin/channels', async (req, reply) => {
  const { errors, value } = validateChannel(req.body || {});
  if (errors.length) return sendErrors(reply, errors);
  const blocked = await mustBeEmbeddable(value);
  if (blocked) return reply.code(422).send({ error: `No se agregó: ${blocked}` });
  return saveChannel(value);
});
app.put('/api/admin/channels/:id', async (req, reply) => {
  const { errors, value } = validateChannel(req.body || {});
  if (errors.length) return sendErrors(reply, errors);
  const previous = getChannels().find((c) => c.id === req.params.id);
  const blocked = await mustBeEmbeddable(value, previous);
  if (blocked) return reply.code(422).send({ error: `No se guardó: ${blocked}` });
  return saveChannel(value, req.params.id);
});
app.delete('/api/admin/channels/:id', (req) => { deleteChannel(req.params.id); return { ok: true }; });
app.post('/api/admin/channels/:id/move', (req) => { moveChannel(req.params.id, req.body?.dir); return { ok: true }; });

app.post('/api/admin/feeds', (req, reply) => {
  const { errors, value } = validateFeed(req.body || {});
  if (errors.length) return sendErrors(reply, errors);
  return saveFeed(value);
});
app.put('/api/admin/feeds/:id', (req, reply) => {
  const { errors, value } = validateFeed(req.body || {});
  if (errors.length) return sendErrors(reply, errors);
  return saveFeed(value, req.params.id);
});
app.delete('/api/admin/feeds/:id', (req) => { deleteFeed(req.params.id); return { ok: true }; });

// Verificaciones previas a dar de alta (las hace el backend, no el navegador).
app.post('/api/admin/check/feed', async (req, reply) => {
  const { errors, value } = validateFeed({ id: 'x', name: 'x', ...req.body });
  if (errors.length) return sendErrors(reply, errors);
  try {
    const r = await fetchFeed(value.url, {}, 12000);
    return { ok: r.items.length > 0, detalle: `${r.items.length} titulares encontrados.`, ejemplos: r.items.slice(0, 3).map((i) => i.title) };
  } catch (err) {
    return { ok: false, detalle: `No se pudo leer el feed: ${err.message}` };
  }
});

// Verifica que el embed sea público y que el medio permita insertarlo.
async function checkChannel(value) {
  try {
    if (value.type === 'youtube') return await checkYoutubeEmbeddable(value.source);
    if (value.type === 'twitch') {
      return { ok: true, detalle: 'Twitch permite su player oficial en sitios HTTPS (con parent=dominio). Confirmá que sea el canal oficial del medio.' };
    }
    const res = await fetch(value.source, {
      method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10000),
      headers: { 'user-agent': settings.userAgent, range: 'bytes=0-1023' },
    });
    res.body?.cancel().catch(() => {});
    if (value.type === 'audio') {
      const ct = res.headers.get('content-type') || '';
      const ok = res.ok && /^(audio\/|application\/ogg)/i.test(ct);
      return { ok, detalle: ok ? `Stream de audio (${ct}).` : `No parece un stream de audio (HTTP ${res.status}, ${ct || 'sin content-type'}).` };
    }
    const xfo = (res.headers.get('x-frame-options') || '').toLowerCase();
    const fa = /frame-ancestors([^;]*)/i.exec(res.headers.get('content-security-policy') || '')?.[1]?.trim();
    if (!res.ok) return { ok: false, detalle: `HTTP ${res.status}.` };
    if (xfo.includes('deny') || xfo.includes('sameorigin')) return { ok: false, detalle: `El medio no permite incrustarlo (X-Frame-Options: ${xfo}). No se agrega.` };
    if (fa && !fa.includes('*') && !fa.includes(settings.domain)) return { ok: false, detalle: `El medio restringe dónde se incrusta (frame-ancestors ${fa}). No se agrega.` };
    return { ok: true, detalle: 'El servidor del medio no bloquea la inserción. Confirmá que sea su player oficial publicado para embeber.' };
  } catch (err) {
    return { ok: false, detalle: `No se pudo verificar: ${err.message}` };
  }
}

app.post('/api/admin/check/channel', async (req, reply) => {
  const { errors, value } = validateChannel({ id: 'x', name: 'x', category: 'noticias', ...req.body });
  if (errors.length) return sendErrors(reply, errors);
  return checkChannel(value);
});

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'No encontrado.' });
  return reply.code(404).type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><title>No encontrado</title><p>No encontrado. <a href="/">Volver</a></p>');
});

app.setErrorHandler((err, req, reply) => {
  const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  if (code >= 500) req.log.error(err);
  reply.code(code).send({ error: code >= 500 ? 'Error interno.' : err.message });
});

await app.listen({ port: settings.port, host: settings.host });

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await app.close();
    try { db.close(); } catch {}
    process.exit(0);
  });
}
