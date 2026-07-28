// =============================================
// GPX TRACKER - Service Worker
// Cache-first for app shell, network-first for map tiles
// =============================================

const CACHE_NAME = 'gpx-tracker-v7';
const TILES_CACHE = 'gpx-tracker-tiles-v1';
const MAX_TILES = 500;

const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js?v=7',
  './js/track-creator.js?v=7',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
  'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4',
  'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches completely
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Bypass Service Worker cache completely for cloud API requests and dynamic data
  if (url.includes('.supabase.co') || url.includes('openrouteservice.org') || url.includes('nominatim.openstreetmap.org')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Map tiles: network-first with cache fallback
  if (url.includes('tile.openstreetmap.org') || url.includes('arcgisonline.com')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(TILES_CACHE).then(async cache => {
            cache.put(event.request, clone);
            // Limit tile cache size
            const keys = await cache.keys();
            if (keys.length > MAX_TILES) {
              await cache.delete(keys[0]);
            }
          });
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Google Fonts CSS: network-first (may vary)
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else: network-first for JS/HTML app logic, fallback to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
