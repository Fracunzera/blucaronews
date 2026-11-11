import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChannel, validateFeed } from '../src/catalog.js';

test('canal YouTube: acepta ID o URL de canal y normaliza', () => {
  const { errors, value } = validateChannel({ id: 'tn', name: 'TN', category: 'noticias', type: 'youtube', source: 'https://www.youtube.com/channel/UCj6PcyLvpnIRT_2W_mwa9Aw' });
  assert.deepEqual(errors, []);
  assert.equal(value.source, 'UCj6PcyLvpnIRT_2W_mwa9Aw');
});

test('canal iframe/audio: solo https', () => {
  assert.ok(validateChannel({ id: 'r', name: 'R', category: 'radio', type: 'iframe', source: 'http://radio.com/player' }).errors.length);
  assert.ok(validateChannel({ id: 'r', name: 'R', category: 'radio', type: 'audio', source: 'javascript:alert(1)' }).errors.length);
  assert.deepEqual(validateChannel({ id: 'r', name: 'R', category: 'radio', type: 'iframe', source: 'https://radio.com/player' }).errors, []);
});

test('canal: categoría y tipo deben existir; id en minúsculas', () => {
  const { errors } = validateChannel({ id: 'Mal ID', name: '', category: 'futbol', type: 'm3u8', source: 'x' });
  assert.equal(errors.length, 4);
});

test('feed: requiere URL http(s) y nombre del medio', () => {
  assert.ok(validateFeed({ id: 'x', name: '', url: 'ftp://a' }).errors.length === 2);
  assert.deepEqual(validateFeed({ id: 'x', name: 'X', url: 'https://a.com/rss' }).errors, []);
});
