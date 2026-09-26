'use strict';
/* Star Circuit service worker — installable PWA support.
 * - Cache-first for same-origin static assets (js/css/icons/manifest/images).
 * - Network-first for navigations; offline falls back to the cached '/'.
 * - /api/* requests are NEVER intercepted: they pass through to the network untouched.
 */
var CACHE = 'star-circuit-v1';
var PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/css/style.css',
  '/js/app.js',
  '/js/balance.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { /* precache is best-effort; never fail install */ })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function isStaticAsset(path) {
  return path === '/manifest.webmanifest' ||
    path === '/sw.js' ||
    path === '/favicon.ico' ||
    path.indexOf('/js/') === 0 ||
    path.indexOf('/css/') === 0 ||
    path.indexOf('/icons/') === 0 ||
    /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf)$/i.test(path);
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: untouched
  if (url.pathname.indexOf('/api/') === 0) return;  // API: pass through untouched

  if (req.mode === 'navigate') {
    // Network-first for navigations; fall back to cached '/' when offline.
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE)
            .then(function (c) { c.put('/', copy); })
            .catch(function () {});
          return res;
        })
        .catch(function () {
          return caches.match('/').then(function (r) { return r || Response.error(); });
        })
    );
    return;
  }

  if (isStaticAsset(url.pathname)) {
    // Cache-first for static assets.
    event.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && (res.status === 200 || res.type === 'opaque')) {
            var copy = res.clone();
            caches.open(CACHE)
              .then(function (c) { c.put(req, copy); })
              .catch(function () {});
          }
          return res;
        });
      })
    );
  }
  // Anything else same-origin: let the browser handle it natively.
});
