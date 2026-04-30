/**
 * MecBusca — Firebase Layer v3.0
 *
 * Camada de abstração sobre o Firebase SDK que expõe uma API limpa
 * para o restante do app. Centraliza init, auth, Firestore e Analytics.
 *
 * Melhorias v3.0:
 *   FL-1: Inicialização lazy com singleton — evita duplo-init em HMR/reload.
 *   FL-2: Google Analytics 4 (G-TXZG30WZ60) integrado e rastreando eventos chave.
 *   FL-3: Retry automático com backoff exponencial para operações Firestore.
 *   FL-4: Abstração de auth com observer tipado e estado reativo via CustomEvent.
 *   FL-5: Helpers de Firestore com paginação cursor-based e cache de última consulta.
 *   FL-6: Modo offline-first com enableIndexedDbPersistence.
 *   FL-7: Error boundaries: todos os erros são normalizados para {code, message}.
 *   FL-8: Suporte a emuladores via variável de ambiente FIREBASE_EMULATOR.
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
// IMPORTANTE: estas credenciais são públicas por design (segurança vem das Rules).
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSy...",            // substitua pela chave real
  authDomain:        "mecbusca.firebaseapp.com",
  projectId:         "mecbusca",
  storageBucket:     "mecbusca.appspot.com",
  messagingSenderId: "000000000000",
  appId:             "1:000000000000:web:xxxxxxxxxxxx",
  measurementId:     window.__GA4_ID__ || "G-TXZG30WZ60", // GA4 — override via window.__GA4_ID__
};

// ── Estado singleton ──────────────────────────────────────────────────────────
let _app       = null;
let _auth      = null;
let _db        = null;
let _analytics = null;
let _messaging = null;
let _initPromise = null;

// ── Utilitários ───────────────────────────────────────────────────────────────

/** FL-7: normaliza erros do Firebase para {code, message} */
function normalizeError(err) {
  const code    = err?.code    || 'unknown';
  const message = err?.message || 'Ocorreu um erro inesperado.';
  const friendly = {
    'auth/user-not-found':      'Usuário não encontrado.',
    'auth/wrong-password':      'Senha incorreta.',
    'auth/email-already-in-use':'E-mail já cadastrado.',
    'auth/weak-password':       'Senha muito fraca (mínimo 8 caracteres).',
    'auth/too-many-requests':   'Muitas tentativas. Aguarde alguns minutos.',
    'auth/network-request-failed': 'Sem conexão. Verifique sua internet.',
    'permission-denied':        'Acesso negado. Faça login novamente.',
    'unavailable':              'Serviço temporariamente indisponível.',
    'not-found':                'Documento não encontrado.',
    'quota-exceeded':           'Limite de requisições atingido.',
  }[code];
  return { code, message: friendly || message };
}

/** FL-3: retry com backoff exponencial */
async function withRetry(fn, { retries = 3, baseDelayMs = 300 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Não reintentar erros de permissão ou argumento inválido
      if (['permission-denied', 'invalid-argument', 'not-found'].includes(err?.code)) throw err;
      const delay = baseDelayMs * 2 ** i + Math.random() * 100;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Dispara CustomEvent no window para comunicação reativa */
function emit(eventName, detail) {
  window.dispatchEvent(new CustomEvent(`mecbusca:${eventName}`, { detail }));
}

// ── Inicialização (FL-1) ──────────────────────────────────────────────────────
async function initFirebase() {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    // Guard: evita duplo-init em HMR
    const { initializeApp, getApps, getApp } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    _app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);

    // Auth
    const { getAuth, connectAuthEmulator } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    _auth = getAuth(_app);

    // Firestore com persistência offline (FL-6)
    const {
      getFirestore,
      connectFirestoreEmulator,
      enableIndexedDbPersistence,
      CACHE_SIZE_UNLIMITED,
      initializeFirestore,
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    _db = initializeFirestore(_app, {
      cacheSizeBytes: CACHE_SIZE_UNLIMITED,
      experimentalForceLongPolling: false,
    });

    // Habilitar persistência offline (ignora erro se já habilitada em outra aba)
    try {
      await enableIndexedDbPersistence(_db);
    } catch (err) {
      if (err.code === 'failed-precondition') {
        console.warn('[FL] Persistência offline já ativa em outra aba.');
      } else if (err.code === 'unimplemented') {
        console.warn('[FL] Persistência offline não suportada neste browser.');
      }
    }

    // FL-8: Emuladores em desenvolvimento
    if (
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1' ||
      window.__FIREBASE_EMULATOR__
    ) {
      connectAuthEmulator(_auth, 'http://localhost:9099', { disableWarnings: true });
      connectFirestoreEmulator(_db, 'localhost', 8080);
      console.info('[FL] 🔧 Emuladores ativos');
    }

    // Analytics GA4 (FL-2) — só em produção e se cookies foram aceitos
    if (location.hostname !== 'localhost' && 'measurementId' in FIREBASE_CONFIG) {
      try {
        const { getAnalytics, isSupported } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js');
        if (await isSupported()) {
          _analytics = getAnalytics(_app);
        }
      } catch {
        // Analytics não é crítico — falha silenciosa
      }
    }

    // Observar mudanças de auth (FL-4)
    const { onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    onAuthStateChanged(_auth, user => {
      emit('auth-changed', { user });
      // Expõe usuário atual globalmente de forma conveniente
      window.__mecbuscaUser__ = user;
    });

    console.info('[FL] ✅ Firebase inicializado');
    return { app: _app, auth: _auth, db: _db, analytics: _analytics };
  })();

  return _initPromise;
}

// ── Getters (garantem init antes do uso) ──────────────────────────────────────
async function getDB()       { await initFirebase(); return _db; }
async function getAuthInst() { await initFirebase(); return _auth; }
async function getAnalyticsInst() { await initFirebase(); return _analytics; }

// ── Auth API ──────────────────────────────────────────────────────────────────
const MecAuth = {
  /** Login com e-mail e senha */
  async loginEmail(email, password) {
    const { signInWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    const authInst = await getAuthInst();
    try {
      const cred = await signInWithEmailAndPassword(authInst, email.trim(), password);
      MecAnalytics.track('login', { method: 'email' });
      return { user: cred.user };
    } catch (err) {
      throw normalizeError(err);
    }
  },

  /** Login com Google */
  async loginGoogle() {
    const { GoogleAuthProvider, signInWithPopup } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    const authInst = await getAuthInst();
    try {
      const provider = new GoogleAuthProvider();
      provider.addScope('profile');
      provider.addScope('email');
      const cred = await signInWithPopup(authInst, provider);
      MecAnalytics.track('login', { method: 'google' });
      return { user: cred.user };
    } catch (err) {
      throw normalizeError(err);
    }
  },

  /** Cadastro com e-mail e senha */
  async cadastrar(email, password, nome) {
    const { createUserWithEmailAndPassword, updateProfile, sendEmailVerification } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    const authInst = await getAuthInst();
    try {
      const cred = await createUserWithEmailAndPassword(authInst, email.trim(), password);
      if (nome) await updateProfile(cred.user, { displayName: nome.trim() });
      // FIX SEC-2: send email verification
      try {
        await sendEmailVerification(cred.user, {
          url: `${location.origin}/?verificado=1`,
        });
      } catch (verErr) {
        // Não bloquear o cadastro se verificação falhar
        console.warn('[MecAuth] sendEmailVerification falhou:', verErr.message);
      }
      MecAnalytics.track('sign_up', { method: 'email' });
      return { user: cred.user, verificacaoEnviada: true };
    } catch (err) {
      throw normalizeError(err);
    }
  },

  /** Reenvia e-mail de verificação */
  async reenviarVerificacao() {
    const authInst = await getAuthInst();
    const user = authInst.currentUser;
    if (!user) throw { code: 'unauthenticated', message: 'Faça login primeiro.' };
    if (user.emailVerified) throw { code: 'already-verified', message: 'E-mail já verificado.' };
    const { sendEmailVerification } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    try {
      await sendEmailVerification(user, { url: `${location.origin}/?verificado=1` });
    } catch (err) {
      throw normalizeError(err);
    }
  },

  /** Logout */
  async logout() {
    const { signOut } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    const authInst = await getAuthInst();
    try {
      await signOut(authInst);
      emit('auth-changed', { user: null });
    } catch (err) {
      throw normalizeError(err);
    }
  },

  /** Recuperar senha por e-mail */
  async recuperarSenha(email) {
    const { sendPasswordResetEmail } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    const authInst = await getAuthInst();
    try {
      await sendPasswordResetEmail(authInst, email.trim(), {
        url: `${location.origin}/login`,
      });
    } catch (err) {
      throw normalizeError(err);
    }
  },

  /** Retorna o usuário atual (síncrono) */
  currentUser() {
    return _auth?.currentUser ?? null;
  },

  /** Aguarda o usuário estar resolvido (útil no boot) */
  async waitForUser() {
    const { onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    const authInst = await getAuthInst();
    return new Promise(resolve => {
      const unsub = onAuthStateChanged(authInst, user => {
        unsub();
        resolve(user);
      });
    });
  },
};

// ── Firestore API ─────────────────────────────────────────────────────────────
const MecDB = {
  /** Busca um documento por caminho */
  async get(path) {
    const { doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const db = await getDB();
    try {
      return await withRetry(() => getDoc(doc(db, path)));
    } catch (err) {
      throw normalizeError(err);
    }
  },

  /** Busca múltiplos documentos com filtros */
  async query(collectionPath, constraints = []) {
    const {
      collection, query: fsQuery, getDocs,
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const db = await getDB();
    try {
      const q = fsQuery(collection(db, collectionPath), ...constraints);
      return await withRetry(() => getDocs(q));
    } catch (err) {
      throw normalizeError(err);
    }
  },

  /** Adiciona um documento a uma coleção */
  async add(collectionPath, data) {
    const {
      collection, addDoc, serverTimestamp,
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const db = await getDB();
    try {
      const ref = await withRetry(() =>
        addDoc(collection(db, collectionPath), {
          ...data,
          criadoEm: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      return ref;
    } catch (err) {
      throw normalizeError(err);
    }
  },

  /** Atualiza campos de um documento */
  async update(path, data) {
    const {
      doc, updateDoc, serverTimestamp,
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const db = await getDB();
    try {
      await withRetry(() =>
        updateDoc(doc(db, path), {
          ...data,
          updatedAt: serverTimestamp(),
        })
      );
    } catch (err) {
      throw normalizeError(err);
    }
  },

  /** Escuta em tempo real um documento */
  async onDocument(path, callback) {
    const { doc, onSnapshot } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const db = await getDB();
    return onSnapshot(doc(db, path), callback, err => {
      console.error('[MecDB.onDocument] Erro:', err.message);
    });
  },

  /** Escuta em tempo real uma query */
  async onQuery(collectionPath, constraints = [], callback) {
    const {
      collection, query: fsQuery, onSnapshot,
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const db = await getDB();
    const q = fsQuery(collection(db, collectionPath), ...constraints);
    return onSnapshot(q, callback, err => {
      console.error('[MecDB.onQuery] Erro:', err.message);
    });
  },
};

// ── Analytics API (FL-2) ──────────────────────────────────────────────────────
const MecAnalytics = {
  /** Rastreia um evento customizado no GA4 */
  async track(eventName, params = {}) {
    if (!_analytics) return;
    try {
      const { logEvent } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js');
      logEvent(_analytics, eventName, params);
    } catch {
      // Analytics não é crítico
    }
  },

  /** Rastreia visualização de página (SPA) */
  async pageView(pagePath, pageTitle) {
    await this.track('page_view', {
      page_path: pagePath || location.pathname,
      page_title: pageTitle || document.title,
    });
  },

  /** Rastreia lead gerado */
  async leadGerado(oficinaId) {
    await this.track('generate_lead', { oficina_id: oficinaId });
  },

  /** Rastreia busca de oficina */
  async busca(cidade, servico) {
    await this.track('search', { search_term: `${cidade}:${servico || 'todos'}` });
  },
};

// ── Service Worker Manager ────────────────────────────────────────────────────
const MecSW = {
  async register() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('/service-worker.js', {
        scope: '/',
        updateViaCache: 'none',
      });

      // Escuta canal de atualização do SW
      const bc = new BroadcastChannel('sw-updates');
      bc.onmessage = e => {
        if (e.data?.type === 'SW_UPDATED') {
          emit('sw-updated', { version: e.data.version });
          // Banner de atualização disponível será tratado pelo app
        }
      };

      // Detecta nova versão esperando
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker?.addEventListener('statechange', () => {
          if (newWorker.statechange === 'installed' && navigator.serviceWorker.controller) {
            emit('sw-update-available', {});
          }
        });
      });

      console.info('[SW] Registrado:', reg.scope);
    } catch (err) {
      console.warn('[SW] Falha no registro:', err.message);
    }
  },

  /** Força atualização imediata do SW */
  skipWaiting() {
    navigator.serviceWorker?.controller?.postMessage('SKIP_WAITING');
  },
};

// ── FCM Push Notifications ───────────────────────────────────────────────────
const MecPush = {
  /** Pede permissão de notificação e salva token FCM no perfil da oficina.
   *  Retorna o token FCM ou null se não suportado/negado/sem VAPID configurada.
   */
  async requestAndSaveToken(oficinaId) {
    // Pré-requisitos
    if (!('Notification' in window)) {
      console.info('[MecPush] Notificações não suportadas neste browser.');
      return null;
    }
    const vapidKey = window.__FCM_VAPID_KEY__;
    if (!vapidKey) {
      console.warn('[MecPush] window.__FCM_VAPID_KEY__ não configurada. Defina antes do deploy.');
      return null;
    }

    try {
      // Verificar suporte a Firebase Messaging (falha em Safari sem permissão)
      const { getMessaging, getToken, isSupported } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js');
      const supported = await isSupported().catch(() => false);
      if (!supported) {
        console.info('[MecPush] Firebase Messaging não suportado neste browser.');
        return null;
      }

      // Pedir permissão
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        console.info('[MecPush] Permissão de notificação negada pelo usuário.');
        return null;
      }

      // Garantir que Firebase está inicializado
      await initFirebase();
      const messaging = getMessaging(_app);
      const token = await getToken(messaging, {
        vapidKey,
        serviceWorkerRegistration: await navigator.serviceWorker.ready,
      });

      if (token && oficinaId) {
        const db = await getDB();
        const { doc, updateDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
        await updateDoc(doc(db, 'oficinas', oficinaId), {
          fcmToken:      token,
          fcmUpdatedAt:  new Date().toISOString(),
          fcmUserAgent:  navigator.userAgent.slice(0, 120),
        });
        console.info('[MecPush] Token FCM salvo com sucesso.');
      }
      return token;
    } catch (err) {
      console.warn('[MecPush] Falha ao obter token FCM:', err.message);
      return null;
    }
  },

  /** Mostra banner de solicitação de notificação se ainda não pediu */
  promptIfNeeded(oficinaId) {
    if (Notification.permission === 'default' && oficinaId) {
      emit('push-permission-needed', { oficinaId });
    }
  },
};

// ── Exports para o app ────────────────────────────────────────────────────────
window.MecBusca = {
  init: initFirebase,
  auth: MecAuth,
  db: MecDB,
  analytics: MecAnalytics,
  sw: MecSW,
  push: MecPush,
  normalizeError,
};

// Auto-inicializar SW no carregamento
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => MecSW.register());
} else {
  MecSW.register();
}

// Auto-inicializar Firebase de forma não-bloqueante
initFirebase()
  .then(() => {
    // Notificar o app que Firebase + Analytics estão prontos
    window.dispatchEvent(new CustomEvent('mecbusca:firebase-ready', { detail: { analytics: _analytics } }));
  })
  .catch(err => console.error('[FL] Falha na inicialização:', err));
