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
  // 1. 我們只處理 GET 請求且非 API 的請求以進行快取
  // 這樣能完全避免 POST/PUT 請求與 Service Worker 的傳輸衝突
  if (event.request.method === 'GET' && !event.request.url.includes('/api/')) {
    event.respondWith(
      caches.match(event.request)
        .then((response) => {
          // 如果快取中有，優先回傳
          if (response) return response;
          // 否則透過網路抓取
          return fetch(event.request).catch(() => {
            // 當連線逾時、斷網或被 Abort() 中斷時，返回一個平穩的操作
            // 這能解決 "TypeError: Load failed" 的問題 (那是因為 event.respondWith 收到 Rejected Promise)
            return null;
          });
        })
    );
  }
  // 其餘請求 (如 API POST) 則直接交由瀏覽器原生連線處理，不觸發 SW 攔截
});