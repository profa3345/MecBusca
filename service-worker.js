/**
 * MecBusca — Service Worker v2.0
 * FIX: cache version agora usa timestamp do build para invalidar automaticamente.
 * Estratégia: Cache-first para assets estáticos, Network-first para API/Firestore.
 */

// FIX: incluir timestamp no nome do cache garante que novo deploy
// invalida o cache antigo automaticamente — sem precisar mudar manualmente.
// FIX: BUILD_TS substituído pelo CI/CD: sed -i "s/__BUILD_TS__/$(date +%s)/g" service-worker.js
// Fallback: invalida por dia se o placeholder não foi substituído
const _RAW_TS = '__BUILD_TS__';
const BUILD_TS = _RAW_TS.startsWith('__')
  ? 'daily-' + Math.floor(Date.now() / 86400000)
  : _RAW_TS;
if (_RAW_TS.startsWith('__')) {
  console.warn('[SW] BUILD_TS não substituído no deploy. Cache invalida por dia como fallback.');
}
const CACHE_NAME = 'mecbusca-v2-' + BUILD_TS;

const CACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// ── Install: pré-cacheia assets shell ────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: remove TODOS os caches antigos ─────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => {
        console.log('[SW] Removendo cache antigo:', k);
        return caches.delete(k);
      }))
    )
  );
  self.clients.claim();
});

// ── Fetch: Cache-first para shell, Network-first para o resto ────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.hostname !== self.location.hostname) return;

  // index.html: sempre Network-first para pegar versões novas
  // FIX: sem isso, uma nova versão deployada fica bloqueada pelo SW
  if (request.destination === 'document' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // JS/CSS: cache-first com atualização em background
  if (request.destination === 'script' || request.destination === 'style') {
    event.respondWith(
      caches.match(request).then(cached => {
        const networkFetch = fetch(request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, clone));
          }
          return response;
        });
        return cached || networkFetch;
      })
    );
    return;
  }

  // Tudo mais: network-first com fallback para cache
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
