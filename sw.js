/* ═══════════════════════════════════════════════════
   FARO — Service Worker v1.0
   Estrategia: Cache-first para assets, Network-first para API
═══════════════════════════════════════════════════ */

const CACHE_NAME = 'faro-cache-v1';
const STATIC_ASSETS = [
  './FARO-v2.html',
  'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400&family=Plus+Jakarta+Sans:wght@300;400;500;600&display=swap',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
];

/* ─── Install: pre-cachear assets estáticos ─── */
self.addEventListener('install', (event) => {
  console.log('[FARO SW] Instalando...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[FARO SW] Cacheando assets estáticos');
        // Intentar cachear cada asset individualmente para no fallar todo si uno falla
        return Promise.allSettled(
          STATIC_ASSETS.map(url => cache.add(url).catch(err => console.warn('[FARO SW] No se pudo cachear:', url, err)))
        );
      })
      .then(() => self.skipWaiting())
  );
});

/* ─── Activate: limpiar caches viejos ─── */
self.addEventListener('activate', (event) => {
  console.log('[FARO SW] Activando...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('[FARO SW] Eliminando cache antiguo:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

/* ─── Fetch: estrategia según tipo de request ─── */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // No interceptar la API de Anthropic — siempre red
  if (url.hostname === 'api.anthropic.com') {
    return event.respondWith(fetch(event.request));
  }

  // No interceptar Firebase
  if (url.hostname.includes('firebase') || url.hostname.includes('google')) {
    return event.respondWith(fetch(event.request));
  }

  // Para todo lo demás: Cache-first con fallback a red
  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        if (cachedResponse) {
          // Actualizar cache en background (stale-while-revalidate)
          fetch(event.request)
            .then(networkResponse => {
              if (networkResponse && networkResponse.status === 200) {
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, networkResponse.clone()));
              }
            })
            .catch(() => {});
          return cachedResponse;
        }

        // No está en cache: buscar en red y guardar
        return fetch(event.request)
          .then(networkResponse => {
            if (!networkResponse || networkResponse.status !== 200 || networkResponse.type === 'opaque') {
              return networkResponse;
            }
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseToCache));
            return networkResponse;
          })
          .catch(() => {
            // Offline fallback para la app
            if (event.request.destination === 'document') {
              return caches.match('./FARO-v2.html');
            }
            return new Response('Sin conexión', { status: 503, statusText: 'Service Unavailable' });
          });
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
