const CACHE_NAME = 'ai-image-cache-v1';

const FILES_TO_CACHE = [
  '/',
  'index.html',
  'favicon.ico',
  'icon/icon-512x512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[ServiceWorker] 開啟快取並加入 App Shell');
        return cache.addAll(FILES_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(keyList.map((key) => {
        if (key !== CACHE_NAME) {
          console.log('[ServiceWorker] 移除舊快取:', key);
          return caches.delete(key);
        }
      }));
    })
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {

  if (event.request.method === 'GET' && !event.request.url.includes('/api/')) {
    event.respondWith(
      caches.match(event.request)
        .then((response) => {
          if (response) return response;
          return fetch(event.request).catch(() => {
            return null;
          });
        })
    );
  }
});