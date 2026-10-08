// Offline support and updates.
// The app always opens from the copy stored on the phone, so it starts instantly with or without a signal.
// When a new version is published this file changes (the build number below), the browser notices, and the
// whole new version is downloaded in the background and swapped in together - never half old, half new.
const VERSION = '__VERSION__'; // replaced with the build number by the publish workflow
const CACHE = `mixpairs-${VERSION}`;
const FILES = ['./', 'styles.css', 'db.js', 'discogs.js', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', event => {
  // 'reload' bypasses the browser's own HTTP cache. addAll is all-or-nothing: if one file fails, the old version stays.
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(FILES.map(file => new Request(file, { cache: 'reload' }))))
      .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return; // Discogs etc. untouched
  event.respondWith(
    caches.open(CACHE)
      .then(cache => cache.match(request, { ignoreSearch: true }))
      .then(stored => stored || fetch(request)));
});
