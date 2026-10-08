// Offline support. Online: always fetch the newest files, so an update published to the site shows up
// the next time the app is opened. Offline or on a very slow connection: use the last downloaded copy.
const CACHE = 'mixpairs';
const FILES = ['./', 'styles.css', 'db.js', 'discogs.js', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return; // Discogs etc. untouched

  // 'no-cache' makes the browser check with the server instead of trusting its own HTTP cache.
  const fresh = fetch(request, { cache: 'no-cache' }).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy));
    }
    return response;
  });
  const timeout = new Promise((_, reject) => setTimeout(reject, NETWORK_TIMEOUT_MS));

  event.respondWith(
    Promise.race([fresh, timeout]).catch(() => caches.match(request).then(cached => cached || fresh)));
});
