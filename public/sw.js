const CACHE_NAME = 'ai-image-cache-v14';

const FILES_TO_CACHE = [
  '/',
  'index.html',
  'favicon.ico',
  'icon/icon-512x512.png'
];

const BYPASS_HOSTS = [
  'storage.googleapis.com',
  'firebasestorage.app',
  'firebasestorage.googleapis.com'
];

const shouldBypass = (request) => {
  if (request.method !== 'GET') return true;
  if (request.headers.has('range')) return true;
  try {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return true;
    return BYPASS_HOSTS.some((host) => url.hostname.endsWith(host));
  } catch (e) {
    return true;
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(FILES_TO_CACHE))
      .then(() => self.skipWaiting())
      .catch((e) => console.error('[ServiceWorker] 快取建立失敗:', e))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keyList) => Promise.all(
        keyList.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .catch((e) => console.error('[ServiceWorker] 舊快取清除失敗:', e))
  );
});

self.addEventListener('fetch', (event) => {
  if (shouldBypass(event.request)) return;

  event.respondWith(
    caches.match(event.request)
      .then((cached) => cached || fetch(event.request))
      .catch(() => caches.match('index.html'))
  );
});
