// Datos externos que consulta SOLO el worker (el navegador nunca llama a terceros
// para estos datos): dólar, clima y estado de vivos de YouTube.
import { settings } from './settings.js';

const UA = { 'user-agent': settings.userAgent, accept: 'application/json' };

async function getJson(url, timeoutMs = 12000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${new URL(url).host}`);
  return res.json();
}

// ---------- Dólar ----------
// Fuente principal: dolarapi.com (gratuita, sin key). Respaldo: bluelytics (sin MEP).

const CASAS = { oficial: 'Oficial', blue: 'Blue', bolsa: 'MEP' };

export async function fetchDolar() {
  try {
    const data = await getJson('https://dolarapi.com/v1/dolares');
    const out = {};
    for (const d of data) {
      if (!CASAS[d.casa]) continue;
      out[d.casa] = {
        nombre: CASAS[d.casa],
        compra: Number(d.compra) || null,
        venta: Number(d.venta) || null,
        actualizado: d.fechaActualizacion || null,
      };
    }
    if (!out.oficial && !out.blue) throw new Error('Respuesta sin cotizaciones');
    return { fuente: 'dolarapi.com', casas: out };
  } catch (err) {
    const b = await getJson('https://api.bluelytics.com.ar/v2/latest');
    return {
      fuente: 'bluelytics.com.ar',
      aviso: `Fuente principal caída (${err.message}); sin dato MEP.`,
      casas: {
        oficial: { nombre: 'Oficial', compra: b.oficial?.value_buy, venta: b.oficial?.value_sell, actualizado: b.last_update },
        blue: { nombre: 'Blue', compra: b.blue?.value_buy, venta: b.blue?.value_sell, actualizado: b.last_update },
      },
    };
  }
}

// ---------- Clima (Open-Meteo, sin key) ----------

const WMO = {
  0: ['Despejado', 'sol'],
  1: ['Mayormente despejado', 'sol-nube'],
  2: ['Parcialmente nublado', 'sol-nube'],
  3: ['Nublado', 'nube'],
  45: ['Niebla', 'niebla'],
  48: ['Niebla con escarcha', 'niebla'],
  51: ['Llovizna débil', 'lluvia'],
  53: ['Llovizna', 'lluvia'],
  55: ['Llovizna intensa', 'lluvia'],
  56: ['Llovizna helada', 'lluvia'],
  57: ['Llovizna helada intensa', 'lluvia'],
  61: ['Lluvia débil', 'lluvia'],
  63: ['Lluvia', 'lluvia'],
  65: ['Lluvia intensa', 'lluvia'],
  66: ['Lluvia helada', 'lluvia'],
  67: ['Lluvia helada intensa', 'lluvia'],
  71: ['Nevada débil', 'nieve'],
  73: ['Nevada', 'nieve'],
  75: ['Nevada intensa', 'nieve'],
  77: ['Granizo fino', 'nieve'],
  80: ['Chaparrones débiles', 'lluvia'],
  81: ['Chaparrones', 'lluvia'],
  82: ['Chaparrones fuertes', 'lluvia'],
  85: ['Chaparrones de nieve', 'nieve'],
  86: ['Chaparrones de nieve fuertes', 'nieve'],
  95: ['Tormenta', 'tormenta'],
  96: ['Tormenta con granizo', 'tormenta'],
  99: ['Tormenta con granizo fuerte', 'tormenta'],
};

export async function fetchClima() {
  const { lat, lon, tz, name } = settings.weather;
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day',
    daily: 'temperature_2m_max,temperature_2m_min',
    forecast_days: '1',
    timezone: tz,
    wind_speed_unit: 'kmh',
  });
  const d = await getJson(`https://api.open-meteo.com/v1/forecast?${q}`);
  const c = d.current || {};
  const [desc, icono] = WMO[c.weather_code] || ['Sin dato', 'nube'];
  return {
    fuente: 'open-meteo.com',
    lugar: name,
    temp: c.temperature_2m,
    sensacion: c.apparent_temperature,
    humedad: c.relative_humidity_2m,
    viento: c.wind_speed_10m,
    rafagas: c.wind_gusts_10m,
    vientoDir: c.wind_direction_10m,
    esDia: c.is_day === 1,
    descripcion: desc,
    icono,
    max: d.daily?.temperature_2m_max?.[0],
    min: d.daily?.temperature_2m_min?.[0],
    hora: c.time,
  };
}

// ---------- YouTube: estado de vivos (opcional, requiere YT_API_KEY) ----------
// Sin descargar video: se leen los IDs recientes del feed RSS público del canal y
// se consulta videos.list (1 unidad de cuota por cada 50 IDs) para saber cuál está
// en vivo y si el dueño permite incrustarlo.

async function recentVideoIds(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
    headers: { 'user-agent': settings.userAgent },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`RSS YouTube HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map((m) => m[1]).slice(0, 15);
}

// Los canales 24 h tienen el vivo abierto desde hace semanas y no aparece en el feed.
// Para esos se usa search.list (eventType=live), que cuesta 100 unidades: se hace como
// mucho cada SEARCH_EVERY_MS por canal, solo si el canal no tiene un vivo conocido, y
// con un tope diario para no pasar la cuota gratuita (10.000 unidades/día).
// Una vez encontrado, el ID se revalida cada 5 min con videos.list (1 unidad / 50 IDs).
const SEARCH_EVERY_MS = 90 * 60_000;
const SEARCH_DAILY_BUDGET = 7000;

async function videosInfo(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const q = new URLSearchParams({
      part: 'snippet,status',
      id: ids.slice(i, i + 50).join(','),
      key: settings.ytApiKey,
      fields: 'items(id,snippet(channelId,liveBroadcastContent,title),status(embeddable))',
    });
    const data = await getJson(`https://www.googleapis.com/youtube/v3/videos?${q}`);
    out.push(...(data.items || []));
  }
  return out;
}

async function searchLive(channelId) {
  const q = new URLSearchParams({
    part: 'id', channelId, eventType: 'live', type: 'video', maxResults: '3', key: settings.ytApiKey,
    fields: 'items(id(videoId))',
  });
  const data = await getJson(`https://www.googleapis.com/youtube/v3/search?${q}`);
  return (data.items || []).map((it) => it.id?.videoId).filter(Boolean);
}

/**
 * prev: el resultado anterior ({ status, meta }) para reusar IDs conocidos y no
 * repetir búsquedas. Devuelve { status: { [channelId]: {live, videoId, embeddable, title} }, meta }.
 */
export async function fetchYoutubeLive(channelIds, prev = null, now = Date.now()) {
  if (!settings.ytApiKey || channelIds.length === 0) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  const meta = {
    day,
    searchUnits: prev?.meta?.day === day ? prev.meta.searchUnits || 0 : 0,
    searchedAt: { ...(prev?.meta?.searchedAt || {}) },
  };

  // 1) Candidatos: últimos videos del feed + el vivo conocido de la pasada anterior.
  const candidates = new Set();
  await Promise.all(
    channelIds.map(async (cid) => {
      try {
        for (const v of await recentVideoIds(cid)) candidates.add(v);
      } catch {}
      const known = prev?.status?.[cid]?.videoId;
      if (known) candidates.add(known);
    }),
  );

  // Default: desconocido (live: null) => el navegador carga el player del canal igual.
  const status = Object.fromEntries(channelIds.map((c) => [c, { live: null, videoId: null, embeddable: null }]));
  const apply = (items) => {
    for (const it of items) {
      const cid = it.snippet?.channelId;
      if (!status[cid] || status[cid].live) continue;
      if (it.snippet?.liveBroadcastContent === 'live') {
        status[cid] = { live: true, videoId: it.id, embeddable: it.status?.embeddable !== false, title: it.snippet.title };
      }
    }
  };
  apply(await videosInfo([...candidates]));

  // 2) Canales sin vivo encontrado: buscar (caro) respetando intervalo y tope diario.
  const found = [];
  for (const cid of channelIds) {
    if (status[cid].live) continue;
    const last = meta.searchedAt[cid] || 0;
    if (now - last < SEARCH_EVERY_MS) {
      // Búsqueda reciente sin vivo: si sigue sin aparecer en el feed, no hay vivo.
      if (prev?.status?.[cid]?.live === false) status[cid].live = false;
      continue;
    }
    if (meta.searchUnits + 100 > SEARCH_DAILY_BUDGET) continue;
    meta.searchUnits += 100;
    meta.searchedAt[cid] = now;
    const ids = await searchLive(cid).catch(() => null);
    if (ids === null) continue;
    if (ids.length === 0) status[cid].live = false;
    else found.push(...ids);
  }
  if (found.length) apply(await videosInfo(found));
  return { status, meta };
}

/**
 * Chequeo de "embed oficial y público" para el panel admin, sin API key:
 * consulta el oEmbed oficial de YouTube con los últimos videos del canal.
 * oEmbed responde 401 cuando el dueño desactivó la inserción.
 */
export async function checkYoutubeEmbeddable(channelId) {
  const ids = await recentVideoIds(channelId);
  if (ids.length === 0) return { ok: false, detalle: 'El canal no tiene videos públicos recientes.' };
  const results = [];
  for (const v of ids.slice(0, 3)) {
    const r = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${v}`)}`,
      { headers: UA, signal: AbortSignal.timeout(10000) },
    );
    results.push(r.status);
  }
  const ok = results.every((s) => s === 200);
  return {
    ok,
    detalle: ok
      ? `oEmbed oficial OK en los últimos ${results.length} videos del canal.`
      : `oEmbed devolvió ${results.join(', ')} (401 = el medio no permite incrustar).`,
  };
}
