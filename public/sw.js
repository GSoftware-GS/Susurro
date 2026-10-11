'use strict';
// Guarda la app en caché para que abra al instante y funcione sin conexión.
// La caché es por versión: al publicar cambios hay que cambiar CACHE. El navegador detecta que
// sw.js es distinto, descarga todos los archivos de golpe y la versión nueva espera: se aplica entera
// cuando el usuario pulsa «Actualizar» o en el siguiente arranque. Así nunca se mezclan versiones.
const CACHE = 'susurro-v5';
const ASSETS = [
  './', 'index.html', 'legal.html', 'app.js', 'styles.css', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'vendor/openpgp.min.js', 'vendor/nostr.bundle.js', 'vendor/qrcode.js', 'vendor/jsQR.js',
];
const SCOPE = new URL('./', self.location).pathname;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
});

// La página pide aplicar la versión nueva (botón «Actualizar») y se recarga a continuación.
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // Abrir la app (también con ?url=… del share_target) sirve siempre la copia guardada,
  // sin pedir nada al servidor.
  const isApp = req.mode === 'navigate' && (url.pathname === SCOPE || url.pathname === SCOPE + 'index.html');
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = isApp ? await cache.match('./') : await cache.match(req, { ignoreSearch: true });
    return hit || fetch(req);
  })());
});
