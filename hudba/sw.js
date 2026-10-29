// Uloží aplikaci do telefonu, aby se otevřela i bez internetu.
const CACHE = 'hudba-v2';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'fonts/fonts.css', 'fonts/montserrat-latin.woff2', 'fonts/montserrat-latin-ext.woff2',
  'fonts/newsreader-latin.woff2', 'fonts/newsreader-latin-ext.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Nejdřív uložená kopie (otevře se hned, i bez signálu), na pozadí se stáhne případná nová verze.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.registration.scope)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const update = fetch(e.request)
      .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
      .catch(() => null);
    if (cached) {
      e.waitUntil(update);
      return cached;
    }
    return (await update) || (e.request.mode === 'navigate' && await cache.match('./')) || Response.error();
  })());
});
