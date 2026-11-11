// Descarga y parseo de feeds RSS 2.0 / Atom / RDF.
// Solo se extrae: título, link, fecha y la bajada (description/summary) recortada.
// Nunca se lee content:encoded ni el cuerpo de la nota.
import { XMLParser } from 'fast-xml-parser';
import { settings } from './settings.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  // No necesitamos el contenido completo: lo descartamos antes de que pese.
  stopNodes: ['*.content:encoded', '*.content'],
});

export const SUMMARY_MAX = 240;

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  agrave: 'à', egrave: 'è', ograve: 'ò', ccedil: 'ç', atilde: 'ã', otilde: 'õ', acirc: 'â', ecirc: 'ê', ocirc: 'ô',
  iexcl: '¡', iquest: '¿', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  sbquo: '‚', bdquo: '„', hellip: '…', ndash: '–', mdash: '—', middot: '·', bull: '•', deg: '°',
  ordm: 'º', ordf: 'ª', euro: '€', copy: '©', reg: '®', trade: '™', times: '×', shy: '',
};

function decodeEntities(str) {
  return str.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ' ';
    }
    return ENTITY_MAP[e] ?? ENTITY_MAP[e.toLowerCase()] ?? m;
  });
}

export function stripHtml(s) {
  // Algunos medios escapan dos veces (&amp;aacute;): decodificamos hasta dos pasadas.
  let out = String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  out = decodeEntities(decodeEntities(out));
  return out
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function text(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text(v['#text'] ?? '');
  return String(v);
}

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '') + '…';
}

function atomLink(link) {
  const links = Array.isArray(link) ? link : [link];
  const alt = links.find((l) => l && typeof l === 'object' && (!l['@rel'] || l['@rel'] === 'alternate'));
  if (alt) return alt['@href'];
  const first = links[0];
  return typeof first === 'string' ? first : first?.['@href'];
}

function parseDate(...candidates) {
  for (const c of candidates) {
    const s = text(c);
    if (!s) continue;
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** Normaliza un link para deduplicar: sin fragmento, sin parámetros de tracking. */
export function normalizeLink(href, base) {
  try {
    const u = new URL(href, base);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|cmpid|outputType$)/i.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return null;
  }
}

/** Clave para detectar el mismo titular aunque cambie el link. */
export function titleKey(title) {
  return title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseFeed(xml, baseUrl) {
  const doc = parser.parse(xml);
  let raw = [];
  if (doc.rss?.channel) raw = doc.rss.channel.item ?? [];
  else if (doc.feed) raw = doc.feed.entry ?? [];
  else if (doc['rdf:RDF']) raw = doc['rdf:RDF'].item ?? [];
  else throw new Error('No parece un feed RSS/Atom');
  if (!Array.isArray(raw)) raw = [raw];

  const items = [];
  for (const it of raw) {
    const title = truncate(stripHtml(text(it.title)), 300);
    const href = typeof it.link === 'string' ? it.link : atomLink(it.link) ?? text(it.guid);
    const rawHref = text(href).trim();
    const link = rawHref ? normalizeLink(rawHref, baseUrl) : null;
    if (!title || !link) continue;
    const summary = truncate(stripHtml(text(it.description ?? it.summary)), SUMMARY_MAX);
    const date = parseDate(it.pubDate, it.published, it.updated, it['dc:date']);
    items.push({ title, link, summary: summary || null, date });
  }
  return items;
}

function decode(buf, contentType) {
  let charset = /charset=([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = buf.subarray(0, 200).toString('latin1');
    charset = /encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder((charset || 'utf-8').toLowerCase()).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/**
 * Descarga un feed con peticiones condicionales (ETag / Last-Modified) para no
 * cargar a los medios. Devuelve { notModified, items, etag, lastModified }.
 */
export async function fetchFeed(url, cacheInfo = {}, timeoutMs = 15000) {
  const headers = {
    'user-agent': settings.userAgent,
    accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  };
  if (cacheInfo.etag) headers['if-none-match'] = cacheInfo.etag;
  if (cacheInfo.lastModified) headers['if-modified-since'] = cacheInfo.lastModified;

  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 304) return { notModified: true, items: [], ...cacheInfo };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > 5_000_000) throw new Error('Feed demasiado grande');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 5_000_000) throw new Error('Feed demasiado grande');
  const xml = decode(buf, res.headers.get('content-type'));
  return {
    notModified: false,
    items: parseFeed(xml, res.url || url),
    etag: res.headers.get('etag') || null,
    lastModified: res.headers.get('last-modified') || null,
  };
}
