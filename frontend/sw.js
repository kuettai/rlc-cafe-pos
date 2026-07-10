const CACHE_NAME = 'rlc-cafe-v1.50.3';
const SHELL = [
  './', './index.html', './track.html', './pos.html', './admin.html',
  './css/style.css', './css/admin.css',
  './js/config.js', './js/phone.js', './js/variants.js', './js/app.js', './js/track.js', './js/pos.js', './js/admin.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Cache-first strategy for menu images: serve from cache immediately if
// available, otherwise fetch + cache for next time. A failed network request
// on a cache miss returns the network failure (the <img onerror> on the
// customer page hides broken images so missing files don't show as broken).
function handleMenuImage(req) {
  return caches.open(CACHE_NAME).then(cache =>
    cache.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(resp => {
        if (resp && resp.ok) cache.put(req, resp.clone());
        return resp;
      });
    })
  );
}

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  } else if (e.request.url.includes('/img/menu/')) {
    e.respondWith(handleMenuImage(e.request));
  } else {
    e.respondWith(fetch(e.request).then(r => {
      const clone = r.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      return r;
    }).catch(() => caches.match(e.request)));
  }
});
