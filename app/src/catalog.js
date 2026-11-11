// Catálogos editables: channels.json y feeds.json dentro del volumen de datos.
// Se pueden editar a mano o desde /admin (que escribe de forma atómica).
import fs from 'node:fs';
import path from 'node:path';
import { settings } from './settings.js';

export const CATEGORIES = {
  noticias: 'Noticias',
  aire: 'Aire',
  radio: 'Radio',
  economia: 'Economía',
  provinciales: 'Provinciales',
  'santa-cruz': 'Santa Cruz',
  deportes: 'Deportes (sin derechos)',
  internacionales: 'Internacionales',
};

export const TYPES = ['youtube', 'twitch', 'iframe', 'audio'];

const FILES = { channels: 'channels.json', feeds: 'feeds.json' };
const cache = {};

function filePath(kind) {
  return path.join(settings.dataDir, FILES[kind]);
}

/** Copia las semillas al volumen si todavía no existen. Idempotente. */
export function ensureSeeds() {
  fs.mkdirSync(settings.dataDir, { recursive: true });
  for (const kind of Object.keys(FILES)) {
    const dest = filePath(kind);
    if (fs.existsSync(dest)) continue;
    const src = path.join(settings.seedDir, FILES[kind]);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.copyFileSync(src, tmp);
    try {
      fs.linkSync(tmp, dest); // falla si otro proceso ya lo creó: no pisamos nada
    } catch {}
    fs.rmSync(tmp, { force: true });
  }
}

function load(kind) {
  const p = filePath(kind);
  const st = fs.statSync(p);
  const c = cache[kind];
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.data;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  cache[kind] = { mtimeMs: st.mtimeMs, size: st.size, data };
  return data;
}

function save(kind, data) {
  const p = filePath(kind);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, p); // rename es atómico en el mismo filesystem
  delete cache[kind];
}

export function getChannels() {
  return load('channels').channels || [];
}

export function getFeeds() {
  return load('feeds').feeds || [];
}

// ---------- validación ----------

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function httpsUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

function httpUrl(v) {
  try {
    const u = new URL(v);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

export function validateChannel(input) {
  const errors = [];
  const id = cleanText(input.id, 40).toLowerCase();
  const name = cleanText(input.name, 60);
  const category = cleanText(input.category, 30);
  const type = cleanText(input.type, 10);
  let source = cleanText(input.source, 500);

  if (!ID_RE.test(id)) errors.push('id: solo minúsculas, números y guiones (máx. 40).');
  if (!name) errors.push('name: obligatorio.');
  if (!CATEGORIES[category]) errors.push(`category: una de ${Object.keys(CATEGORIES).join(', ')}.`);
  if (!TYPES.includes(type)) errors.push(`type: uno de ${TYPES.join(', ')}.`);

  if (type === 'youtube') {
    const m = source.match(/(UC[\w-]{22})/);
    if (!m) errors.push('source: para YouTube va el ID de canal (empieza con UC y tiene 24 caracteres).');
    else source = m[1];
  } else if (type === 'twitch') {
    source = source.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/\/.*$/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,25}$/.test(source)) errors.push('source: usuario de Twitch inválido.');
  } else if (type === 'iframe' || type === 'audio') {
    const u = httpsUrl(source);
    if (!u) errors.push('source: tiene que ser una URL https:// del player/stream oficial del medio.');
    else source = u;
  }

  const verified = /^\d{4}-\d{2}-\d{2}$/.test(input.verified || '')
    ? input.verified
    : new Date().toISOString().slice(0, 10);

  return { errors, value: { id, name, category, type, source, verified } };
}

export function validateFeed(input) {
  const errors = [];
  const id = cleanText(input.id, 40).toLowerCase();
  const name = cleanText(input.name, 60);
  const url = httpUrl(cleanText(input.url, 500));
  if (!ID_RE.test(id)) errors.push('id: solo minúsculas, números y guiones (máx. 40).');
  if (!name) errors.push('name: obligatorio (es el nombre del medio que se muestra).');
  if (!url) errors.push('url: URL http(s) del feed RSS/Atom.');
  return { errors, value: { id, name, url, enabled: input.enabled !== false } };
}

// ---------- altas, bajas y modificaciones ----------

function upsert(kind, listKey, item, originalId) {
  const data = structuredClone(load(kind));
  const list = data[listKey] || (data[listKey] = []);
  const key = originalId || item.id;
  const idx = list.findIndex((x) => x.id === key);
  if (item.id !== key && list.some((x) => x.id === item.id)) {
    throw Object.assign(new Error(`Ya existe un elemento con id "${item.id}".`), { statusCode: 409 });
  }
  if (!originalId) {
    // Alta: el id no puede existir.
    if (idx !== -1) throw Object.assign(new Error(`Ya existe un elemento con id "${item.id}".`), { statusCode: 409 });
    list.push(item);
  } else {
    if (idx === -1) throw Object.assign(new Error('No existe.'), { statusCode: 404 });
    list[idx] = item;
  }
  save(kind, data);
  return item;
}

function remove(kind, listKey, id) {
  const data = structuredClone(load(kind));
  const before = (data[listKey] || []).length;
  data[listKey] = (data[listKey] || []).filter((x) => x.id !== id);
  if (data[listKey].length === before) throw Object.assign(new Error('No existe.'), { statusCode: 404 });
  save(kind, data);
}

export const saveChannel = (item, originalId) => upsert('channels', 'channels', item, originalId);
export const deleteChannel = (id) => remove('channels', 'channels', id);
export const saveFeed = (item, originalId) => upsert('feeds', 'feeds', item, originalId);
export const deleteFeed = (id) => remove('feeds', 'feeds', id);

export function moveChannel(id, dir) {
  const data = structuredClone(load('channels'));
  const list = data.channels;
  const i = list.findIndex((x) => x.id === id);
  const j = i + (dir === 'up' ? -1 : 1);
  if (i === -1) throw Object.assign(new Error('No existe.'), { statusCode: 404 });
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  save('channels', data);
}
