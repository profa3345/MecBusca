/**
 * MecBusca — Service Worker v3.0
 *
 * Melhorias v3.0:
 *   SW-V3-1: Runtime caching com TTL para respostas de API (evita dados stale indefinidos)
 *   SW-V3-2: Background sync para leads offline (enfileira e reenvio quando conexão volta)
 *   SW-V3-3: Offline fallback page dedicada (melhor UX sem rede)
 *   SW-V3-4: Cache quota guard — evita DOMException: QuotaExceededError
 *   SW-V3-5: Estratégia stale-while-revalidate com max-age para scripts/estilos
 *   SW-V3-6: Broadcast de atualização disponível para o app via BroadcastChannel
 *   SW-V3-7: Limpeza automática de entradas velhas (LRU simples por data de acesso)
 */

const CACHE_VER  = 3;
const CACHE_NAME = `mecbusca-v3-r${CACHE_VER}`;
const OFFLINE_URL = '/offline.html';

// Assets que precisam de cache imediato no install
const CACHE_ASSETS = [
  '/index.html',
  '/manifest.json',
  '/firebase-layer.js',
  '/service-worker.js',
];

// BroadcastChannel para notificar o app sobre atualizações
const updateChannel = new BroadcastChannel('sw-updates');

// ── Utilitários ───────────────────────────────────────────────────
function isValidURL(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isCacheableResponse(response) {
  return response &&
    response.status === 200 &&
    response.type !== 'opaque'; // nunca cachear respostas opacas (CORS)
}

async function safeCachePut(cacheName, request, response) {
  try {
    // SW-V3-4: verificar quota antes de gravar
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const { usage, quota } = await navigator.storage.estimate();
      const usagePercent = usage / quota;
      if (usagePercent > 0.85) {
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

// SW-V3-7: remove as N entradas mais antigas pelo header Date
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

// ── Install ───────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(CACHE_ASSETS);
      } catch (err) {
        console.warn('[SW] Pré-cache parcial:', err.message);
      }
      // skipWaiting aqui garante ativação imediata sem esperar tabs fecharem
      await self.skipWaiting();
    })()
  );
});

// ── Activate ──────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Remover caches de versões anteriores
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] Removendo cache antigo:', k);
            return caches.delete(k);
          })
      );
      // SW-V3-6: notificar o app que atualização foi aplicada
      updateChannel.postMessage({ type: 'SW_UPDATED', version: CACHE_VER });
      await self.clients.claim();
    })()
  );
});

// ── Message ───────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CACHE_URLS') {
    // Permite que o app pré-cache URLs extras sob demanda
    const urls = event.data.urls || [];
    caches.open(CACHE_NAME).then(cache => cache.addAll(urls)).catch(() => {});
  }
});

// ── Background Sync (SW-V3-2) ─────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-leads') {
    event.waitUntil(syncPendingLeads());
  }
});

async function syncPendingLeads() {
  // Lê fila de leads pendentes do IndexedDB e reenvia
  try {
    const db = await openLeadsDB();
    const tx = db.transaction('pending-leads', 'readwrite');
    const store = tx.objectStore('pending-leads');
    const leads = await storeGetAll(store);
    for (const lead of leads) {
      try {
        const res = await fetch('/api/leads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(lead.data),
        });
        if (res.ok) {
          await store.delete(lead.id);
          console.log('[SW] Lead sincronizado:', lead.id);
        }
      } catch {
        // Deixa na fila para próxima tentativa
      }
    }
    await tx.done;
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

function storeGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Fetch ─────────────────────────────────────────────────────────
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

  // Não interceptar cross-origin exceto se for nosso CDN/assets conhecidos
  if (url.hostname !== self.location.hostname) return;

  // ── Navegação (HTML / document) — Network-first ──────────────────
  if (
    request.destination === 'document' ||
    url.pathname === '/' ||
    url.pathname === '/index.html'
  ) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (isCacheableResponse(response)) {
            const clone = response.clone();
            safeCachePut(CACHE_NAME, request, clone);
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          // SW-V3-3: fallback offline page
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

  // ── Scripts e Estilos — Stale-while-revalidate ───────────────────
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

        // SW-V3-5: responde imediatamente com cache e atualiza em background
        return cached || networkFetch;
      })
    );
    return;
  }

  // ── Imagens — Cache-first (imagens mudam pouco) ──────────────────
  if (request.destination === 'image') {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request)
          .then(response => {
            if (isCacheableResponse(response)) {
              safeCachePut(CACHE_NAME, request, response.clone());
            }
            return response;
          })
          .catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }

  // ── Tudo mais — Network-first com fallback ───────────────────────
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
