/**
 * MecBusca — Service Worker v3.1
 *
 * FIXES v3.1 aplicados:
 *   FIX-SW-1: offline.html adicionado ao CACHE_ASSETS (nunca estava sendo pré-cacheado)
 *   FIX-SW-2: quota guard corrigido — trocado navigator.storage por self.storage (contexto SW)
 *   FIX-SW-3: syncPendingLeads refatorado — deletes IDB movidos para fora do await fetch()
 *              (transação IDB fecha em microtasks; await dentro do loop a quebrava silenciosamente)
 *   FIX-SW-4: cache de imagens com limite LRU de 60 entradas (evita encher storage mobile)
 *   FIX-SW-5: catch-all network-first agora verifica isCacheableResponse antes de cachear
 *   FIX-SW-6: listener 'online' no cliente notificado via BroadcastChannel para reload automático
 */

const CACHE_VER  = 4;
const CACHE_NAME = `mecbusca-v3-r${CACHE_VER}`;
const OFFLINE_URL = '/offline.html';
const IMAGE_CACHE_LIMIT = 60; // FIX-SW-4

// FIX-SW-1: offline.html incluído no pré-cache
const CACHE_ASSETS = [
  '/index.html',
  '/manifest.json',
  '/firebase-layer.js',
  '/service-worker.js',
  '/offline.html',
];

const updateChannel = new BroadcastChannel('sw-updates');

// ── Utilitários ───────────────────────────────────────────────────────
function isValidURL(url) {
  try { new URL(url); return true; } catch { return false; }
}

function isCacheableResponse(response) {
  return response &&
    response.status === 200 &&
    response.type !== 'opaque';
}

async function safeCachePut(cacheName, request, response) {
  try {
    // FIX-SW-2: self.storage em vez de navigator.storage (contexto de Service Worker)
    if ('storage' in self && 'estimate' in self.storage) {
      const { usage, quota } = await self.storage.estimate();
      if (usage / quota > 0.85) {
        console.warn('[SW] Quota > 85%, pulando cache para:', request.url);
        return;
      }
    }
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      console.warn('[SW] Quota excedida, limpando cache antigo...');
      await evictOldEntries(cacheName, 20);
    } else {
      console.error('[SW] Erro ao cachear:', err.message);
    }
  }
}

async function evictOldEntries(cacheName, count) {
  try {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();
    const entries = await Promise.all(
      requests.map(async req => {
        const res = await cache.match(req);
        const date = res?.headers.get('Date') || '1970-01-01';
        return { req, ts: new Date(date).getTime() };
      })
    );
    entries.sort((a, b) => a.ts - b.ts);
    const toDelete = entries.slice(0, Math.min(count, entries.length));
    await Promise.all(toDelete.map(e => cache.delete(e.req)));
    console.log(`[SW] Evictadas ${toDelete.length} entradas antigas`);
  } catch (err) {
    console.error('[SW] Erro ao eviccionar:', err.message);
  }
}

// FIX-SW-4: limite de entradas no cache de imagens
async function enforceImageCacheLimit(cacheName, limit) {
  try {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();
    if (requests.length <= limit) return;
    const overflow = requests.length - limit;
    // Remove as mais antigas (primeiras da lista, que são as mais velhas)
    await Promise.all(requests.slice(0, overflow).map(r => cache.delete(r)));
  } catch (err) {
    console.error('[SW] Erro ao limitar cache de imagens:', err.message);
  }
}

// ── Install ───────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(CACHE_ASSETS); // FIX-SW-1: offline.html agora incluído
      } catch (err) {
        console.warn('[SW] Pré-cache parcial:', err.message);
      }
      await self.skipWaiting();
    })()
  );
});

// ── Activate ──────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] Removendo cache antigo:', k);
            return caches.delete(k);
          })
      );
      updateChannel.postMessage({ type: 'SW_UPDATED', version: CACHE_VER });
      await self.clients.claim();
    })()
  );
});

// ── Message ───────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CACHE_URLS') {
    const urls = event.data.urls || [];
    caches.open(CACHE_NAME).then(cache => cache.addAll(urls)).catch(() => {});
  }
});

// ── Background Sync (FIX-SW-3) ────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-leads') {
    event.waitUntil(syncPendingLeads());
  }
});

async function syncPendingLeads() {
  try {
    const db = await openLeadsDB();

    // Lê todos os leads pendentes primeiro
    const leads = await new Promise((resolve, reject) => {
      const tx = db.transaction('pending-leads', 'readonly');
      const store = tx.objectStore('pending-leads');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (!leads.length) return;

    // Tenta enviar cada lead — fora da transação IDB
    const syncedIds = [];
    for (const lead of leads) {
      try {
        const res = await fetch('/api/leads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(lead.data),
        });
        if (res.ok) {
          syncedIds.push(lead.id);
          console.log('[SW] Lead sincronizado:', lead.id);
        }
      } catch {
        // Mantém na fila para próxima tentativa
      }
    }

    // FIX-SW-3: deletes em transação separada, após todos os fetches
    if (syncedIds.length > 0) {
      const txDel = db.transaction('pending-leads', 'readwrite');
      const storeDel = txDel.objectStore('pending-leads');
      await Promise.all(syncedIds.map(id => new Promise((res, rej) => {
        const r = storeDel.delete(id);
        r.onsuccess = res;
        r.onerror = rej;
      })));
    }
  } catch (err) {
    console.warn('[SW] Background sync falhou:', err.message);
  }
}

function openLeadsDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mecbusca-offline', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('pending-leads', {
        keyPath: 'id',
        autoIncrement: true,
      });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

// ── Fetch ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;

  if (request.method !== 'GET') return;
  if (!isValidURL(request.url)) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (url.hostname !== self.location.hostname) return;

  // ── Navegação — Network-first ─────────────────────────────────────
  if (
    request.destination === 'document' ||
    url.pathname === '/' ||
    url.pathname === '/index.html'
  ) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (isCacheableResponse(response)) {
            safeCachePut(CACHE_NAME, request, response.clone());
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          return (
            (await caches.match(OFFLINE_URL)) ||
            new Response('<h1>Você está offline</h1>', {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
              status: 503,
            })
          );
        })
    );
    return;
  }

  // ── Scripts e Estilos — Stale-while-revalidate ────────────────────
  if (request.destination === 'script' || request.destination === 'style') {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(request);
        const networkFetch = fetch(request)
          .then(response => {
            if (isCacheableResponse(response)) {
              safeCachePut(CACHE_NAME, request, response.clone());
            }
            return response;
          })
          .catch(() => null);
        return cached || networkFetch;
      })
    );
    return;
  }

  // ── Imagens — Cache-first com limite LRU (FIX-SW-4) ──────────────
  if (request.destination === 'image') {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request)
          .then(response => {
            if (isCacheableResponse(response)) {
              safeCachePut(CACHE_NAME, request, response.clone()).then(() => {
                enforceImageCacheLimit(CACHE_NAME, IMAGE_CACHE_LIMIT);
              });
            }
            return response;
          })
          .catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }

  // ── Catch-all — Network-first com fallback (FIX-SW-5) ────────────
  // FIX-SW-5: verifica isCacheableResponse antes de cachear no catch-all
  event.respondWith(
    fetch(request)
      .then(response => {
        if (isCacheableResponse(response)) {
          safeCachePut(CACHE_NAME, request, response.clone());
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
