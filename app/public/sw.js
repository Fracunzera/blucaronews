// Service worker de Blucaro News: solo hace que la app se pueda instalar y que la
// "cáscara" (HTML, JS, CSS, íconos) abra rápido. NUNCA cachea la API (/api/*), los
// reproductores ni nada de otros dominios: las señales siempre van directo del medio.
'use strict';
const CACHE = 'bn-shell-v1';
const SHELL = ['/', '/app.js', '/styles.css', '/theme.js', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || url.pathname.endsWith('.apk')) return;
  const isShell = req.mode === 'navigate' ? url.pathname === '/' : SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/');
  if (!isShell) return;
  // Red primero (siempre la versión nueva tras un deploy); la caché solo si no hay red.
  const key = req.mode === 'navigate' ? '/' : req;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit || Response.error())),
  );
});
