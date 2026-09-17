const CACHE_NAME = 'hoyfio-cache-v7';
const STATIC_ASSETS = [
  '/styles.css',
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg'
];

const NETWORK_FIRST_PATHS = ['/', '/index.html', '/config.js', '/app.js'];

function isNetworkFirstRequest(url) {
  return NETWORK_FIRST_PATHS.some((path) => url.pathname === path || url.pathname.endsWith(path));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) =>
      Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[ServiceWorker] Removing old cache', key);
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('google') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('cdn.jsdelivr.net')
  ) {
    return;
  }

  if (event.request.method !== 'GET') return;

  if (isNetworkFirstRequest(url)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await caches.match('/index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}
