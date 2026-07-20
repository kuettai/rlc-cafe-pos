const CACHE_NAME = 'rlc-cafe-v1.61.0';
const SHELL = [
  './', './index.html', './track.html', './pos.html', './admin.html', './display.html',
  './css/style.css', './css/admin.css', './css/display.css',
  './js/config.js', './js/phone.js', './js/variants.js', './js/app.js', './js/track.js',
  './js/pos.js', './js/pos-walkup.js', './js/pos-voucher.js', './js/pos-stock.js', './js/pos-checklist.js', './js/pos-history.js',
  './js/pos-training.js', './js/training-config.json',
  './js/admin.js', './js/admin-dashboard.js', './js/admin-menu.js', './js/admin-ingredients.js',
  './js/admin-checklist.js', './js/admin-vouchers.js', './js/admin-preorder.js', './js/admin-verses.js', './js/admin-display.js',
  './js/admin-customers.js',
  './js/display.js',
  './changelog.json', './js/changelog.js'
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

// --- Push Notifications ---
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || '☕ RLC Café';
  const options = {
    body: data.body || 'Your order status has been updated',
    icon: './img/icon-192.png',
    badge: './img/icon-72.png',
    vibrate: [200, 100, 200],
    tag: 'order-' + (data.orderId || 'unknown'),
    renotify: true,
    data: { orderId: data.orderId },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const orderId = event.notification.data?.orderId;
  const url = orderId ? './track.html?highlight=' + orderId : './track.html';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes('track') && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
