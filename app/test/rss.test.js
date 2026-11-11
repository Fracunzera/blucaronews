import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, normalizeLink, titleKey, stripHtml, SUMMARY_MAX } from '../src/rss.js';

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>X</title>
<item><title><![CDATA[Título con <b>HTML</b> &amp; acento: Río]]></title><link>https://medio.com/nota-1?utm_source=rss#top</link>
<description>&lt;p&gt;Bajada &amp;aacute; ${'larga '.repeat(100)}&lt;/p&gt;</description>
<content:encoded><![CDATA[<p>TEXTO COMPLETO QUE NUNCA SE GUARDA</p>]]></content:encoded>
<pubDate>Wed, 11 Nov 2026 12:00:00 -0300</pubDate></item>
<item><title>Sin link</title></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
<entry><title>Nota Atom</title><link rel="alternate" href="/a/1"/><updated>2026-11-11T10:00:00Z</updated><summary>Resumen</summary><content>COMPLETO</content></entry></feed>`;

test('RSS: solo título, link limpio, fecha y bajada recortada; nunca content:encoded', () => {
  const items = parseFeed(RSS, 'https://medio.com/rss');
  assert.equal(items.length, 1);
  const [it] = items;
  assert.equal(it.title, 'Título con HTML & acento: Río');
  assert.equal(it.link, 'https://medio.com/nota-1');
  assert.equal(it.date, Date.parse('2026-11-11T15:00:00Z'));
  assert.ok(it.summary.startsWith('Bajada á'));
  assert.ok(it.summary.length <= SUMMARY_MAX + 1);
  assert.ok(!JSON.stringify(it).includes('TEXTO COMPLETO'));
});

test('Atom: link relativo resuelto contra la URL del feed', () => {
  const [it] = parseFeed(ATOM, 'https://otro.com/feed.xml');
  assert.equal(it.link, 'https://otro.com/a/1');
  assert.equal(it.summary, 'Resumen');
  assert.ok(!JSON.stringify(it).includes('COMPLETO'));
});

test('dedupe: mismo titular con distinta puntuación/acentos da la misma clave', () => {
  assert.equal(titleKey('¡Último momento: Río Gallegos!'), titleKey('ultimo momento rio gallegos'));
});

test('normalizeLink rechaza protocolos no http(s)', () => {
  assert.equal(normalizeLink('javascript:alert(1)'), null);
  assert.equal(normalizeLink('https://a.com/x?fbclid=1&id=2'), 'https://a.com/x?id=2');
});

test('stripHtml decodifica entidades doblemente escapadas', () => {
  assert.equal(stripHtml('C&amp;iacute;rculo &amp;ldquo;x&amp;rdquo;'), 'Círculo “x”');
});
