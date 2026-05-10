/* ═══════════════════════════════════════════════════
   FARO — Service Worker v2.0
   Estrategia:
     - index.html       → Network-first  (siempre versión más reciente)
     - Assets estáticos → Cache-first    (React, fuentes — no cambian)
     - API / Firebase   → Network-only   (nunca cachear)
═══════════════════════════════════════════════════ */

const CACHE_NAME = 'faro-cache-v2';

// Solo assets pesados que raramente cambian
const STATIC_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400&family=Plus+Jakarta+Sans:wght@300;400;500;600&display=swap',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
];

/* ─── Install: pre-cachear assets estáticos (sin index.html) ─── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(
        STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

/* ─── Activate: limpiar caches viejos ─── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

/* ─── Fetch: estrategia según tipo de request ─── */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-only: API, Firebase, Cloud Run
  if (
    url.hostname === 'api.anthropic.com' ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('google') ||
    url.hostname.includes('cloudfunctions') ||
    url.hostname.includes('.run.app')
  ) {
    return;
  }

  // Network-first para index.html: siempre intenta red, cae a caché si offline
  if (event.request.destination === 'document' || url.pathname === '/' || url.pathname.endsWith('index.html')) {
    event.respondWith(
      fetch(event.request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first para assets estáticos (React, fuentes, imágenes)
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'opaque') {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return networkResponse;
        }).catch(() => new Response('Sin conexión', { status: 503 }));
      })
  );
});

/* ─── Push notifications (preparado para futuro) ─── */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'FARO', {
    body: data.body || 'Tienes una nueva alerta financiera',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: data.url || './' }
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
