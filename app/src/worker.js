// Worker: lee los feeds RSS cada 60–120 s, deduplica, guarda solo lo mínimo en
// SQLite y borra lo que tenga más de 48 h. También refresca dólar, clima y
// (si hay YT_API_KEY) el estado de los vivos de YouTube.
import { getDb, kvGet, kvSet } from './db.js';
import { ensureSeeds, getChannels, getFeeds } from './catalog.js';
import { fetchFeed, titleKey } from './rss.js';
import { fetchClima, fetchDolar, fetchYoutubeLive } from './sources.js';
import { settings } from './settings.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const MAX_AGE_MS = settings.newsMaxAgeHours * 3600_000;
const HOUR = 3600_000;

ensureSeeds();
const db = getDb();

const insertNews = db.prepare(`
  INSERT OR IGNORE INTO news(feed_id, source, title, title_key, link, summary, published_at, fetched_at)
  VALUES(?, ?, ?, ?, ?, ?, ?, ?)`);
const titleExists = db.prepare('SELECT 1 FROM news WHERE title_key = ? LIMIT 1');
const purgeOld = db.prepare('DELETE FROM news WHERE published_at < ?');

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

export function storeItems(feed, items, now = Date.now()) {
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const it of items) {
      let ts = it.date ?? now;
      if (ts > now + 10 * 60_000) ts = now; // fechas en el futuro: las tomamos como "ahora"
      if (ts < now - MAX_AGE_MS) continue; // más viejo que 48 h: ni se guarda
      const key = titleKey(it.title);
      if (!key || titleExists.get(key)) continue; // mismo titular ya cargado (otro link / otro medio)
      const r = insertNews.run(feed.id, feed.name, it.title, key, it.link, it.summary, ts, now);
      added += Number(r.changes);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

async function runRss() {
  const feeds = getFeeds().filter((f) => f.enabled !== false);
  const status = kvGet('feedstatus')?.value || {};
  let total = 0;
  await pool(feeds, 4, async (feed) => {
    const cacheKey = `feedcache:${feed.id}`;
    const cache = kvGet(cacheKey)?.value || {};
    const prev = status[feed.id] || {};
    try {
      const sameUrl = cache.url === feed.url;
      const r = await fetchFeed(feed.url, sameUrl ? cache : {});
      if (!r.notModified) kvSet(cacheKey, { url: feed.url, etag: r.etag, lastModified: r.lastModified });
      const added = r.notModified ? 0 : storeItems(feed, r.items);
      total += added;
      status[feed.id] = { ok: true, lastOk: Date.now(), lastItems: r.notModified ? prev.lastItems ?? 0 : r.items.length, error: null };
    } catch (err) {
      status[feed.id] = { ...prev, ok: false, lastError: Date.now(), error: String(err.message || err).slice(0, 200) };
      log(`feed ${feed.id}: ${err.message}`);
    }
  });
  // Quitar estado de feeds borrados.
  for (const id of Object.keys(status)) if (!feeds.some((f) => f.id === id)) delete status[id];
  kvSet('feedstatus', status);
  const purged = Number(purgeOld.run(Date.now() - MAX_AGE_MS).changes);
  kvSet('worker', { lastRss: Date.now(), added: total, purged, intervalSec: settings.rssIntervalSec });
  log(`rss: ${feeds.length} feeds, +${total} titulares, -${purged} viejos`);
}

// ---------- Dólar ----------

const ART_OFFSET = 3 * HOUR; // Argentina: UTC-3 todo el año
function startOfTodayART(now = Date.now()) {
  return Math.floor((now - ART_OFFSET) / 86400_000) * 86400_000 + ART_OFFSET;
}

const histInsert = db.prepare('INSERT INTO dolar_hist(casa, venta, ts) VALUES(?, ?, ?)');
const histPrev = db.prepare('SELECT venta FROM dolar_hist WHERE casa = ? AND ts < ? ORDER BY ts DESC LIMIT 1');
const histPurge = db.prepare('DELETE FROM dolar_hist WHERE ts < ?');

async function runDolar() {
  const d = await fetchDolar();
  const now = Date.now();
  const dayStart = startOfTodayART(now);
  for (const [casa, v] of Object.entries(d.casas)) {
    if (v.venta == null) continue;
    histInsert.run(casa, v.venta, now);
    const prev = histPrev.get(casa, dayStart)?.venta;
    if (prev != null) {
      v.anterior = prev;
      v.variacion = Math.round(((v.venta - prev) / prev) * 10000) / 100; // % con 2 decimales
    }
  }
  histPurge.run(now - 5 * 24 * HOUR);
  kvSet('dolar', d);
}

async function runClima() {
  kvSet('clima', await fetchClima());
}

async function runYoutube() {
  const ids = [...new Set(getChannels().filter((c) => c.type === 'youtube').map((c) => c.source))];
  const prev = kvGet('ytlive')?.value;
  // Formato viejo (solo el mapa de estados) => se descarta.
  const r = await fetchYoutubeLive(ids, prev && prev.status ? prev : null);
  if (r) kvSet('ytlive', r);
}

function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

// ---------- planificador sin solapamientos ----------

const timers = new Map();
let stopping = false;

function every(name, ms, fn, { enabled = true } = {}) {
  if (!enabled) return;
  const tick = async () => {
    if (stopping) return;
    try {
      await fn();
      kvSet(`job:${name}`, { ok: true, at: Date.now() });
    } catch (err) {
      log(`${name}: ${err.message}`);
      kvSet(`job:${name}`, { ok: false, at: Date.now(), error: String(err.message).slice(0, 200) });
    }
    if (!stopping) timers.set(name, setTimeout(tick, ms));
  };
  tick();
}

every('rss', settings.rssIntervalSec * 1000, runRss);
every('dolar', 5 * 60_000, runDolar);
every('clima', 15 * 60_000, runClima);
every('youtube', 5 * 60_000, runYoutube, { enabled: Boolean(settings.ytApiKey) });
every('sessions', HOUR, cleanupSessions);

log(`worker iniciado: RSS cada ${settings.rssIntervalSec}s, YouTube API ${settings.ytApiKey ? 'activada' : 'no configurada'}`);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    for (const t of timers.values()) clearTimeout(t);
    log('worker detenido');
    try { db.close(); } catch {}
    process.exit(0);
  });
}
