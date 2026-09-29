// Service Worker for Zhanetta Vaganova PWA (Instant Auto-Update Architecture v12)
const CACHE_NAME = 'zhanetta-pwa-v12';
const PRECACHE_ASSETS = [
  './',
  './manifest.json',
  './images/icon-192.png',
  './images/apple-touch-icon.png',
  './images/hero_bw_main.jpg',
  './images/zhanetta_avatar_camera.jpg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
     .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
     .then((windowClients) => {
       windowClients.forEach((client) => {
         try {
           client.postMessage({ type: 'SW_FORCE_RELOAD', version: CACHE_NAME });
         } catch (e) {}
       });
     })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never cache API calls or sw.js checks
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('/sw.js')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  const isHtmlNav =
    event.request.mode === 'navigate' ||
    (event.request.headers.get('accept') || '').includes('text/html') ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html');

  // Always Network-First with cache: 'no-store' for HTML so installed PWAs never get stuck on old versions
  if (isHtmlNav) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((networkResp) => {
          if (networkResp && networkResp.status === 200) {
            const copy = networkResp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
          }
          return networkResp;
        })
        .catch(() =>
          caches.match(event.request, { ignoreSearch: true })
            .then((r) => r || caches.match('./index.html') || caches.match('./'))
        )
    );
    return;
  }

  // Stale-While-Revalidate for images, fonts, and static assets
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResp) => {
          if (
            networkResp &&
            networkResp.status === 200 &&
            (networkResp.type === 'basic' || networkResp.type === 'cors')
          ) {
            const copy = networkResp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
          }
          return networkResp;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
