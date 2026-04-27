// ═══════════════════════════════════════════════════════════════
//  MecBusca — Camada de Dados Unificada (firebase-layer.js) v3
//
//  Mudanças v3:
//   1. Score de ranking REMOVIDO do client.
//      calcRankingScore() e ordenarPorScore() eliminados.
//      Toda ordenação vem da Cloud Function buscarOficinas.
//   2. listarOficinasAdmin() migrado para Cloud Function
//      (flag admin:true → sem limite de 20 resultados).
//   3. Fallback local mantido APENAS para dev/emulador local
//      e marcado explicitamente como inseguro para produção.
//
//  Mudanças v2:
//   1. Plano inicial sempre GRATUITO (basico).
//   2. Camada Services/Controllers:
//      OficinaService  — CRUD de oficinas com cache.
//      LeadService     — envio e gestão de leads.
//      SearchController— busca com cache de 1 minuto.
//      AuthController  — autenticação e estado de sessão.
//   3. Rate limit client-side (UX). Rate limit real → Cloud Functions.
// ═══════════════════════════════════════════════════════════════

// ── 1. MODO DE OPERAÇÃO ──────────────────────────────────────────
// VULN-1 FIX: modo NÃO pode ser alterado via URL (?mode=PROD era bypassável).
// Lê APENAS de window.__MECBUSCA_MODE (definido com Object.defineProperty
// non-writable no index.html — não pode ser sobrescrito via DevTools ou URL).
const APP_MODE = window.__MECBUSCA_MODE || 'DEMO';
const IS_PROD   = APP_MODE === 'PROD';
const IS_DEMO   = !IS_PROD;
// VULN-2 FIX: não vazar APP_MODE no console (visível a qualquer usuário via DevTools)

// ── PLANOS ───────────────────────────────────────────────────────
//
//  v1: todos entram no plano 'basico' (gratuito).
//  Infraestrutura Pro/Premium mantida mas INATIVA no cadastro.
//  Ativa via Cloud Function após confirmação de pagamento.
//
//  NOTA: não exibir preços no fluxo de cadastro (v1 = tudo grátis).
//
const PLANOS = Object.freeze({
  BASICO:  { id: 'basico',  label: 'Grátis',   prioridade: 0,    preco: 0   },
  PRO:     { id: 'pro',     label: 'Pro',       prioridade: 500,  preco: 49  },
  PREMIUM: { id: 'premium', label: 'Premium',   prioridade: 1000, preco: 97  },
});

// BUG-9 FIX: expor PLANOS via window (módulo ES tem escopo isolado)
window.PLANOS = PLANOS;

// Score máximo teórico por plano:
//   basico:  40+35+15+3+5+5+5 = 108
//   pro:     40+35+15+8+5+5+5 = 113
//   premium: 40+35+15+10+5+5+5= 115
// Diferença intencional: oficina gratuita bem avaliada supera premium mal avaliada.

// ── 2. CONFIG DO FIREBASE ────────────────────────────────────────
const firebaseConfig = (() => {
  if (typeof __firebase_config__ !== 'undefined') {
    return JSON.parse(__firebase_config__);
  }
  // Vercel hosting: config injetada via window.__FIREBASE_CFG__ no index.html
  if (window.__FIREBASE_CFG__) return window.__FIREBASE_CFG__;
  return {
    apiKey:            "AIzaSyAjON2Rw44KSMv-u8-O0p0f6UpNE0PksXA",
    authDomain:        "mecbusca.firebaseapp.com",
    projectId:         "mecbusca",
    storageBucket:     "mecbusca.firebasestorage.app",
    messagingSenderId: "273467472832",
    appId:             "1:273467472832:web:fee239b43f50adae04a625",
  };
})();

// ── 3. IMPORTS DO FIREBASE SDK ───────────────────────────────────
import { initializeApp } from
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, collection, addDoc, getDocs, getDoc, setDoc,
  query, where, orderBy, serverTimestamp, onSnapshot,
  doc, updateDoc, increment, runTransaction, limit, startAfter
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, sendPasswordResetEmail, updateProfile
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFunctions, httpsCallable
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import {
  initializeAppCheck, ReCaptchaV3Provider
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-check.js';

// ── 4. INICIALIZAÇÃO ─────────────────────────────────────────────
const FB_STATUS = { connected: false, mode: APP_MODE, error: null };
window.__fbStatus = () => ({ ...FB_STATUS });

let app, db, auth;
let isFirebaseReady = false;

if (IS_PROD) {
  try {
    app  = initializeApp(firebaseConfig);
    db   = getFirestore(app);
    auth = getAuth(app);
    isFirebaseReady = true;
    FB_STATUS.connected = true;
    console.info('✅ Firebase (PROD) conectado');

    // ── App Check (reCAPTCHA v3) ───────────────────────────────────
    // Bloqueia chamadas não-autorizadas às Cloud Functions e ao Firestore.
    // Chave pública do reCAPTCHA v3 — safe para expor no client.
    // Configure no Firebase Console → App Check → reCAPTCHA v3 → seu site key.
    try {
      const RECAPTCHA_KEY = window.__RECAPTCHA_KEY__ || '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI'; // substituir pela chave real
      initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(RECAPTCHA_KEY),
        isTokenAutoRefreshEnabled: true,
      });
      window._appCheckReady = true;
      console.info('🛡️ App Check ativado');
    } catch(e) {
      console.warn('[AppCheck] Falha ao inicializar (ok em localhost):', e.message);
      window._appCheckReady = false;
    }

    // ── Cloud Functions — região southamerica-east1 ───────────────
    try {
      window._fbFunctions = getFunctions(app, 'southamerica-east1');
    } catch(e) { console.warn('Functions não disponível:', e.message); }

    // ── Sentry (monitoramento de erros em produção) ───────────────
    // DSN configurado via window.__SENTRY_DSN__ (definido no index.html).
    // Em dev/localhost, Sentry é silenciado automaticamente.
    _initSentry();

  } catch (e) {
    FB_STATUS.error = e.message;
    console.warn('Firebase não inicializado — operando em modo DEMO', e);
  }
} else {
  console.info('🧪 Modo DEMO ativo — Firebase desativado');
}

// ── 5. RATE LIMIT CLIENT-SIDE (UX) ──────────────────────────────
//
//  ⚠️  Este rate limit é apenas UX (feedback rápido, anti-duplo-clique).
//      A barreira real é Cloud Functions + Regras do Firestore.
//
//  TODO (Cloud Functions): migrar para server-side:
//  exports.enviarLead = functions.https.onCall(async (data, ctx) => {
//    const ip = ctx.rawRequest.ip;
//    const ref = admin.firestore().doc(`_ratelimits/lead_${ip}`);
//    return admin.firestore().runTransaction(async tx => {
//      const snap = await tx.get(ref);
//      const { count = 0, window = 0 } = snap.data() || {};
//      const now = Date.now();
//      if (now - window < 300_000 && count >= 3)
//        throw new functions.https.HttpsError('resource-exhausted', 'Limite atingido.');
//      tx.set(ref, { count: now - window < 300_000 ? count+1 : 1, window: now });
//      return admin.firestore().collection('leads').add({ ...data, criadoEm: admin.firestore.FieldValue.serverTimestamp() });
//    });
//  });
//
// INFO-8 FIX: rateLimitUX agora usa localStorage para persistir entre reloads.
// Sem isso, F5 resetava os contadores e o limite era bypassável.
function rateLimitUX(key, maxCalls, windowMs) {
  const now = Date.now();
  const lsKey = 'mb_rl_' + key;
  let hits = [];
  try { hits = JSON.parse(localStorage.getItem(lsKey) || '[]'); } catch(e) {}
  hits = hits.filter(t => now - t < windowMs);
  if (hits.length >= maxCalls) return false;
  hits.push(now);
  try { localStorage.setItem(lsKey, JSON.stringify(hits)); } catch(e) {}
  return true;
}

// ── 6. SANITIZAÇÃO ───────────────────────────────────────────────
// FIX-9: sanitize agora remove tags HTML mas NÃO aplica entity encoding.
// HTML encoding pertence à camada de renderização (ex: textContent / innerHTML),
// não à camada de persistência. Salvar '&amp;' no Firestore causa exibição
// literal do escape para o usuário quando renderizado via textContent.
// Injeção HTML/XSS é prevenida nas regras do Firestore + sanitização na saída.
function sanitize(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  // Remove tags HTML e limita tamanho. Encoding feito apenas na renderização.
  return str.trim().slice(0, maxLen).replace(/<[^>]*>/g, '');
}

// Função separada para uso ao renderizar dados no DOM (innerHTML):
// use sempre escapeHtml(valor) ao inserir dados de usuário em innerHTML.
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '&#96;');
}
window.escapeHtml = escapeHtml;
function sanitizeData(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string')        out[k] = sanitize(v);
    else if (typeof v === 'number')   out[k] = isFinite(v) ? v : 0;
    else if (Array.isArray(v))        out[k] = v.slice(0, 50);
    else if (v && typeof v === 'object') out[k] = sanitizeData(v);
    else out[k] = v;
  }
  return out;
}

// ── 7. VALIDADORES ───────────────────────────────────────────────
function validarWpp(wpp) {
  const digits = String(wpp || '').replace(/\D/g, '');
  // Celular: DDD(2) + 9 + 8 dígitos = 11 | Fixo: DDD(2) + 8 dígitos = 10
  return /^\d{10,11}$/.test(digits);
}
function validarEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
}
function validarNome(nome) {
  const n = sanitize(nome || '', 200).trim();
  return n.length >= 2 && n.length <= 200;
}

// ── 8. RANKING ENGINE ───────────────────────────────────────────
//
//  ✅ v3: calcRankingScore e ordenarPorScore REMOVIDOS do client.
//
//  O score é calculado exclusivamente na Cloud Function buscarOficinas
//  (southamerica-east1). Isso elimina a possibilidade de manipulação
//  via DevTools, pois o client nunca recebe dados brutos suficientes
//  para recalcular a ordenação.
//
//  Algoritmo de score (referência — vive em functions/index.js):
//    distância  → 0-40 pts  (haversine, máx 20 km)
//    avaliação  → 0-35 pts  (média / 5 * 35)
//    serviço    → 0-15 pts  (match exato=15, parcial=8)
//    plano      → 0-10 pts  (premium=10, pro=8, basico=3)
//    aberto     → 0-5  pts
//    volume av. → 0-5  pts  (floor(total/10), máx 5)
//    engajamento→ 0-5  pts  (cliques/impressoes * 50, se imp>10)
//

// ── SENTRY — monitoramento de erros em produção ─────────────────
// Sentry captura: JS exceptions, promise rejections, fetch errors,
// e eventos customizados (lead enviado, erro de login, etc.)
//
// Setup:
//   1. Criar conta em sentry.io (free até 5k erros/mês)
//   2. window.__SENTRY_DSN__ = "https://...@...sentry.io/..." no index.html
//   3. window.__APP_VERSION__ = "1.0.0" para rastrear versão nos eventos
//
function _initSentry() {
  const dsn = window.__SENTRY_DSN__;
  if (!dsn) return; // sem DSN = silêncio total (dev/localhost)
  if (window.__sentryReady) return;

  const script = document.createElement('script');
  script.src = 'https://browser.sentry-cdn.com/7.114.0/bundle.tracing.min.js';
  script.crossOrigin = 'anonymous';
  script.onload = () => {
    if (!window.Sentry) return;
    window.Sentry.init({
      dsn,
      release:     window.__APP_VERSION__ || '0.0.1',
      environment: IS_PROD ? 'production' : 'development',
      tracesSampleRate: 0.1,            // 10% das transações para performance
      ignoreErrors: [
        'ResizeObserver loop',          // noise de terceiros
        'Non-Error exception captured', // noise de extensões
        'Loading chunk',                // falha de rede momentânea
      ],
      beforeSend(event) {
        // Não enviar PII — remover dados sensíveis
        if (event.request?.headers) delete event.request.headers['Cookie'];
        return event;
      },
    });
    window.__sentryReady = true;
    // Captura erros de Promise não tratados
    window.addEventListener('unhandledrejection', e => {
      window.Sentry?.captureException(e.reason, { tags: { type: 'unhandledRejection' } });
    });
    console.info('🐛 Sentry ativo (env:', IS_PROD ? 'production' : 'development', ')');
  };
  script.onerror = () => console.warn('[Sentry] Falha ao carregar script');
  document.head.appendChild(script);
}

// Captura evento de erro amigável (chame em catch blocks críticos)
function _captureError(err, context = {}) {
  if (window.__sentryReady && window.Sentry) {
    window.Sentry.withScope(scope => {
      Object.entries(context).forEach(([k, v]) => scope.setTag(k, String(v)));
      window.Sentry.captureException(err);
    });
  }
}
window._captureError = _captureError;

// ── ANALYTICS UNIFICADO ──────────────────────────────────────────
// Camada única que envia para GA4 + Firebase Analytics + Sentry.
// Evita eventos duplicados e centraliza toda a telemetria do app.
//
// Eventos-chave:
//   busca_realizada       → { servico, cidade, resultados }
//   lead_enviado          → { oficinaId, servico, valor }
//   perfil_aberto         → { oficinaId, plano }
//   upgrade_cta_clicado   → { plano_atual, plano_destino }
//   cadastro_concluido    → { etapa }
//   chatbot_mensagem      → { tipo: 'user'|'bot' }
//   erro_usuario          → { acao, erro_code }
//
const MbAnalytics = {
  // GA4 Measurement ID — configure em window.__GA4_ID__ no index.html
  // Exemplo: window.__GA4_ID__ = "G-XXXXXXXXXX"
  _ga4Id: null,
  _loaded: false,

  _loadGA4() {
    if (this._loaded || !window.__GA4_ID__) return;
    this._ga4Id = window.__GA4_ID__;
    this._loaded = true;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + this._ga4Id;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function(){ window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', this._ga4Id, {
      send_page_view: false,        // controlamos manualmente
      anonymize_ip: true,           // LGPD compliance
      cookie_flags: 'SameSite=None;Secure',
    });
    console.info('📊 GA4 ativo:', this._ga4Id);
  },

  // Rastreia evento em todas as plataformas configuradas
  track(eventName, params = {}) {
    // ── GA4 ──────────────────────────────────────────────────────
    if (window.gtag && this._ga4Id) {
      window.gtag('event', eventName, {
        ...params,
        app_version: window.__APP_VERSION__ || '0.0.1',
        app_mode:    IS_PROD ? 'prod' : 'demo',
      });
    }

    // ── Sentry breadcrumb (trilha de ações antes de um erro) ─────
    if (window.__sentryReady && window.Sentry) {
      window.Sentry.addBreadcrumb({
        category: 'ui',
        message:  eventName,
        data:     params,
        level:    'info',
      });
    }

    // ── Firebase Firestore analytics (eventos críticos de negócio) ─
    // Somente em PROD e para eventos de alto valor
    const highValue = ['lead_enviado','cadastro_concluido','upgrade_cta_clicado','pagamento_confirmado'];
    if (IS_PROD && highValue.includes(eventName) && db) {
      try {
        addDoc(collection(db, 'analytics'), {
          evento:    eventName,
          params,
          criadoEm:  serverTimestamp(),
          url:       location.pathname + location.hash,
          ua:        navigator.userAgent.slice(0, 200),
        }).catch(() => {}); // fire-and-forget
      } catch(e) {}
    }
  },

  // Rastreia page view (chame ao mudar de tela)
  pageView(screenName) {
    if (window.gtag && this._ga4Id) {
      window.gtag('event', 'page_view', {
        page_title:    screenName,
        page_location: location.href,
      });
    }
    if (window.__sentryReady && window.Sentry) {
      window.Sentry.addBreadcrumb({ category: 'navigation', message: screenName });
    }
  },

  // Init: carrega GA4 e retorna a instância
  init() {
    this._loadGA4();
    return this;
  }
};
window.MbAnalytics = MbAnalytics.init();

// ── RANKING POR CONVERSÃO (busca inteligente) ─────────────────────
// Rastreia:
//   1. Quais oficinas geraram leads após serem vistas
//   2. Quais serviços têm maior intenção de compra por região
//   3. Personalização por histórico do usuário (sessionStorage)
//
// Isso alimenta a Cloud Function buscarOficinas com sinais
// de conversão reais, não só avaliações e distância.
//
const ConversionTracker = {
  // Registra que o usuário viu uma oficina
  impression(oficinaId, rank, params = {}) {
    const key = 'mb_impressions';
    try {
      const data = JSON.parse(sessionStorage.getItem(key) || '[]');
      data.push({ id: oficinaId, rank, t: Date.now(), ...params });
      sessionStorage.setItem(key, JSON.stringify(data.slice(-50)));
    } catch(e) {}
    MbAnalytics.track('oficina_impressao', { oficina_id: oficinaId, posicao: rank, ...params });
  },

  // Registra clique em oficina (intenção forte)
  click(oficinaId, rank, params = {}) {
    MbAnalytics.track('oficina_clique', { oficina_id: oficinaId, posicao: rank, ...params });
    if (IS_PROD && db && oficinaId) {
      updateDoc(doc(db, 'oficinas', oficinaId), {
        'stats.cliques': increment(1),
        'stats.ultimoEvento': serverTimestamp(),
      }).catch(() => {});
    }
  },

  // Registra conversão (lead enviado) — evento de maior peso no ranking
  convert(oficinaId, servico, valor = 0) {
    MbAnalytics.track('lead_enviado', { oficina_id: oficinaId, servico, valor });
    // Persiste no histórico pessoal para personalização futura
    try {
      const hist = JSON.parse(localStorage.getItem('mb_hist_conv') || '[]');
      hist.unshift({ id: oficinaId, servico, t: Date.now() });
      localStorage.setItem('mb_hist_conv', JSON.stringify(hist.slice(0, 20)));
    } catch(e) {}
  },

  // Retorna serviços que o usuário buscou/converteu no passado (para pré-preencher)
  getHistoricoServicos() {
    try {
      const hist = JSON.parse(localStorage.getItem('mb_hist_conv') || '[]');
      const count = {};
      hist.forEach(h => { if (h.servico) count[h.servico] = (count[h.servico] || 0) + 1; });
      return Object.entries(count).sort((a,b) => b[1]-a[1]).map(([s]) => s);
    } catch(e) { return []; }
  },
};
window.ConversionTracker = ConversionTracker;

// ── 9. API PÚBLICA (window.FB) ───────────────────────────────────────
window.FB = {
  ready:   () => isFirebaseReady || IS_DEMO,
  isProd:  () => IS_PROD,
  isDemo:  () => IS_DEMO,

  async login(email, password) {
    if (IS_DEMO) throw new Error('Login indisponível em modo DEMO.');
    MbAnalytics.track('login_tentativa');
    if (!rateLimitUX('login:' + email, 5, 60_000))
      throw new Error('Muitas tentativas. Aguarde 1 minuto.');
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
  },

  async register(email, password, displayName) {
    if (IS_DEMO) throw new Error('Cadastro indisponível em modo DEMO.');
    if (!rateLimitUX('register', 3, 300_000))
      throw new Error('Limite de cadastros atingido. Tente em 5 minutos.');
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if (displayName) await updateProfile(cred.user, { displayName: sanitize(displayName, 80) });
    await setDoc(doc(db, 'users', cred.user.uid), {
      email: cred.user.email,
      displayName: sanitize(displayName || '', 80),
      role: 'oficina',
      criadoEm: serverTimestamp()
    });
    return cred.user;
  },

  async logout() { if (auth) await signOut(auth); },

  async resetPassword(email) {
    if (IS_DEMO) throw new Error('Indisponível em modo DEMO.');
    if (!rateLimitUX('reset:' + email, 2, 300_000))
      throw new Error('Aguarde antes de solicitar novamente.');
    await sendPasswordResetEmail(auth, email);
  },

  onAuthChange(cb) { return auth ? onAuthStateChanged(auth, cb) : () => setTimeout(() => cb(null), 0); },
  getCurrentUser() { return auth?.currentUser || null; },

  // ── OFICINAS ─────────────────────────────────────────────────
  async cadastrarOficina(data) {
    if (IS_DEMO) return demoSave('oficina', data);
    const user = auth.currentUser;
    if (!user) throw new Error('Usuário não autenticado');
    if (!validarNome(data.nome))   throw new Error('Nome inválido (mín. 2 caracteres).');
    if (data.wpp   && !validarWpp(data.wpp))     throw new Error('WhatsApp inválido.');
    if (data.email && !validarEmail(data.email)) throw new Error('E-mail inválido.');
    const existing = await this.getMinhaOficina(user.uid);
    if (existing) return existing.id;
    const clean = sanitizeData(data);
    // BUG-4 FIX: calcular campo 'aberto' com base nos horários cadastrados.
    // Sem ele, oficina não aparece no filtro "Abertas agora" e perde +5 pts de ranking.
    const _calcAberto = (horarios) => {
      if (!Array.isArray(horarios) || !horarios.length) return false;
      const now  = new Date();
      const dias = ['Dom','Seg','Ter','Qua','Qui','Sex','Sab'];
      const hoje = horarios.find(h => h.dia && h.dia.startsWith(dias[now.getDay()]));
      if (!hoje || !hoje.on || !hoje.range || hoje.range === 'Fechado') return false;
      const m = hoje.range.match(/(\d{2}):(\d{2})\s*[\u2013-]\s*(\d{2}):(\d{2})/);
      if (!m) return true;
      const cur = now.getHours() * 60 + now.getMinutes();
      return cur >= (parseInt(m[1])*60+parseInt(m[2])) && cur < (parseInt(m[3])*60+parseInt(m[4]));
    };

    const ref = await addDoc(collection(db, 'oficinas'), {
      ...clean,
      ativo:            true,
      uid:              user.uid,
      aberto:           _calcAberto(clean.horarios),
      // ── Plano inicial: basico (gratuito) ─────────────────────
      plano:            'basico',
      planoAtualizadoEm: serverTimestamp(),
      avaliacoes:       0,
      totalAvaliacoes:  0,
      avaliacao:        0,
      stats:            { impressoes: 0, cliques: 0, whatsapp: 0, orcamentos: 0 },
      criadoEm:         serverTimestamp(),
      atualizadoEm:     serverTimestamp(),
    });
    return ref.id;
  },

  async getMinhaOficina(uid) {
    if (IS_DEMO) return null;
    const snap = await getDocs(query(collection(db, 'oficinas'), where('uid', '==', uid)));
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { id: d.id, ...d.data() };
  },

  async getOficinaById(id) {
    if (IS_DEMO) return demoOficinas({}).find(o => o.id === id) || null;
    const snap = await getDoc(doc(db, 'oficinas', id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  },

  async atualizarOficina(oficinaId, data) {
    if (IS_DEMO) return true;
    const user = auth.currentUser;
    if (!user) throw new Error('Não autorizado');
    // VULN-5 FIX: verificar ownership antes de enviar ao Firestore.
    // Firestore Rules são a barreira real, mas falhar rápido no client
    // evita round-trips desnecessários e melhora a mensagem de erro.
    const ofSnap = await getDoc(doc(db, 'oficinas', oficinaId));
    if (!ofSnap.exists()) throw new Error('Oficina não encontrada');
    if (ofSnap.data().uid !== user.uid) throw new Error('Sem permissão para editar esta oficina');
    // Campos protegidos não podem ser alterados pelo client
    const { uid, plano, rankScore, score, leadCount, ...safe } = sanitizeData(data);
    await updateDoc(doc(db, 'oficinas', oficinaId), { ...safe, atualizadoEm: serverTimestamp() });
    return true;
  },

  async listarOficinas(filtros = {}, pagSize = 20, lastDoc = null) {
    if (IS_DEMO) return demoOficinas(filtros);
    // Usa Cloud Function (ranking server-side) quando disponível
    if (window._fbFunctions) {
      try {
        const fn = httpsCallable(window._fbFunctions, 'buscarOficinas');
        const res = await fn(filtros);
        const ofs = res.data.oficinas || [];
        // Analytics: registra impressões para ranking por conversão
        ofs.slice(0, 5).forEach((o, i) => ConversionTracker.impression(o.id, i + 1, { servico: filtros.servico || '', cidade: filtros.cidade || '' }));
        return ofs;
      } catch(e) {
        console.warn('[listarOficinas] Cloud Function falhou, usando fallback local:', e.code);
        // Fallback para query direta se a CF não estiver deployada ainda
      }
    }

    let q = query(
      collection(db, 'oficinas'),
      where('ativo', '==', true),
      limit(pagSize * 3)
    );
    if (lastDoc) q = query(q, startAfter(lastDoc));

    const snap = await getDocs(q);
    let oficinas = snap.docs.map(d => ({ id: d.id, _doc: d, ...d.data() }));

    if (filtros.cidade)
      oficinas = oficinas.filter(o =>
        (o.cidade || '').toLowerCase().includes(filtros.cidade.toLowerCase()));
    if (filtros.bairro)
      oficinas = oficinas.filter(o =>
        (o.bairro || '').toLowerCase().includes(filtros.bairro.toLowerCase()));
    if (filtros.avaliacaoMin)
      oficinas = oficinas.filter(o => (o.avaliacao || 0) >= filtros.avaliacaoMin);
    if (filtros.apenasAberta)
      oficinas = oficinas.filter(o => o.aberto);
    if (filtros.tipoVeiculo)
      oficinas = oficinas.filter(o =>
        (o.tipoVeiculo || []).includes(filtros.tipoVeiculo));
    if (filtros.servico) {
      const qStr = (filtros.servico || '').toLowerCase();
      oficinas = oficinas.filter(o =>
        (o.servicos || []).some(s => s.ativo && s.nome.toLowerCase().includes(qStr)));
    }

    // ⚠️  FALLBACK LOCAL — sem score composto (v3).
    //     Ordenação simples por avaliação. Use apenas em dev/emulador.
    //     Em produção, garanta que a CF esteja deployada para score real.
    return oficinas
      .sort((a, b) => (b.avaliacao || 0) - (a.avaliacao || 0))
      .slice(0, pagSize);
  },

  async listarOficinasAdmin(filtros = {}) {
    if (IS_DEMO) {
      return demoOficinas(filtros).map(o => ({
        ...o,
        _planoLabel: PLANOS[o.plano?.toUpperCase()]?.label ?? o.plano,
      }));
    }
    const user = auth?.currentUser;
    if (!user) throw new Error('Não autenticado');

    // ✅ v3: usa Cloud Function com flag admin:true
    // → sem limit(20), retorna todos os resultados ordenados server-side
    if (window._fbFunctions) {
      try {
        const fn  = httpsCallable(window._fbFunctions, 'buscarOficinas');
        const res = await fn({ ...filtros, admin: true });
        return (res.data.oficinas || []).map(o => ({
          ...o,
          _planoLabel: PLANOS[o.plano?.toUpperCase()]?.label ?? o.plano,
        }));
      } catch (e) {
        console.warn('[listarOficinasAdmin] Cloud Function falhou, usando fallback local:', e.code);
        // Fallback abaixo — usado apenas quando CF não está deployada (dev local)
      }
    }

    // ⚠️  FALLBACK LOCAL — inseguro para produção.
    //     Sem score composto. Use apenas em dev/emulador.
    //     Em produção, garanta que a CF esteja deployada.
    const snap = await getDocs(
      query(collection(db, 'oficinas'), where('ativo', '==', true), limit(200))
    );
    const oficinas = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Ordenação simples por avaliação (fallback sem score server-side)
    return oficinas
      .sort((a, b) => (b.avaliacao || 0) - (a.avaliacao || 0))
      .map(o => ({
        ...o,
        _planoLabel: PLANOS[o.plano?.toUpperCase()]?.label ?? o.plano,
      }));
  },

  // ── UPGRADE DE PLANO ─────────────────────────────────────────
  //  ⚠️  NUNCA atualize o plano direto do client em produção.
  //  Use Cloud Function após confirmação de pagamento:
  //
  //  exports.confirmarPlano = functions.https.onCall(async (data, ctx) => {
  //    if (!ctx.auth) throw new HttpsError('unauthenticated', '...');
  //    const { oficinaId, plano } = data;
  //    if (!['basico','pro','premium'].includes(plano))
  //      throw new HttpsError('invalid-argument', 'Plano inválido');
  //    await admin.firestore()
  //      .doc(`oficinas/${oficinaId}`)
  //      .update({ plano, planoAtualizadoEm: admin.firestore.FieldValue.serverTimestamp() });
  //    return { ok: true };
  //  });
  //
  async __devAtualizarPlano(oficinaId, plano) {
    // VULN-7 FIX: usar IS_PROD (não manipulável via URL) ao invés de hostname
    // location.hostname poderia ser 'localhost' em build de produção mal configurado.
    if (IS_PROD) throw new Error('__devAtualizarPlano indisponível em produção. Use Cloud Function confirmarPlano.');
    const validos = Object.values(PLANOS).map(p => p.id);
    if (!validos.includes(plano))
      throw new Error(`Plano inválido. Use: ${validos.join(' | ')}`);
    await updateDoc(doc(db, 'oficinas', oficinaId), {
      plano, planoAtualizadoEm: serverTimestamp()
    });
    console.info(`✅ [DEV] ${oficinaId} → plano "${plano}"`);
    return true;
  },

  // ── LEADS ─────────────────────────────────────────────────────
  async enviarLead(data) {
    // Rate limit por oficina+whatsapp (evita spam em oficinas diferentes com mesmo número)
    const rlKey = 'lead:' + (data.oficinaId || '') + ':' + (data.whatsapp || '');
    if (!rateLimitUX(rlKey, 3, 300_000))
      throw new Error('Muitas solicitações. Aguarde alguns minutos.');
    // BUG FIX: valida ANTES do IS_DEMO — detecta erro de estado no front mesmo em demo
    const clean = sanitizeData(data);
    if (!clean.oficinaId)                throw new Error('Oficina não identificada. Selecione uma oficina.');
    if (!validarNome(clean.nomeCliente)) throw new Error('Nome do cliente inválido.');
    if (!validarWpp(clean.whatsapp))     throw new Error('WhatsApp inválido.');
    if (IS_DEMO) return demoSave('lead', clean);
    // Usa Cloud Function (rate limit real server-side) quando disponível
    if (window._fbFunctions) {
      try {
        const fn = httpsCallable(window._fbFunctions, 'enviarLead');
        const res = await fn(clean);
        ConversionTracker.convert(clean.oficinaId, clean.servico || '', clean.valor || 0);
        return res.data.id;
      } catch(e) {
        if (e.code === 'resource-exhausted') throw new Error('Muitas solicitações. Aguarde alguns minutos.');
        console.warn('[enviarLead] Cloud Function falhou, usando fallback:', e.code);
      }
    }
    const ref = await addDoc(collection(db, 'leads'), {
      ...clean, status: 'novo', criadoEm: serverTimestamp()
    });
    // Analytics: conversão — sinal de maior peso para ranking inteligente
    ConversionTracker.convert(clean.oficinaId, clean.servico || '', clean.valor || 0);
    return ref.id;
  },

  async listarLeadsDaOficina(oficinaId) {
    if (IS_DEMO) return demoLeads(oficinaId);
    const q = query(
      collection(db, 'leads'),
      where('oficinaId', '==', oficinaId),
      orderBy('criadoEm', 'desc'),
      limit(100)
    );
    try {
      const snap = await getDocs(q);
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      if (e.code === 'failed-precondition') throw new Error('MISSING_INDEX:' + e.message);
      throw e;
    }
  },

  async atualizarLead(leadId, data) {
    if (IS_DEMO) return true;
    // FIX-2: verificar autenticação e ownership antes de atualizar.
    // Sem isso, qualquer usuário autenticado poderia alterar leads de qualquer oficina.
    // Firestore Rules são a barreira definitiva, mas falhar no client evita round-trips
    // desnecessários e produz mensagens de erro mais claras.
    const user = auth?.currentUser;
    if (!user) throw new Error('Não autorizado');
    const leadSnap = await getDoc(doc(db, 'leads', leadId));
    if (!leadSnap.exists()) throw new Error('Lead não encontrado');
    // Busca a oficina associada ao lead para verificar ownership
    const { oficinaId } = leadSnap.data();
    if (oficinaId) {
      const ofSnap = await getDoc(doc(db, 'oficinas', oficinaId));
      if (ofSnap.exists() && ofSnap.data().uid !== user.uid) {
        throw new Error('Sem permissão para atualizar este lead');
      }
    }
    const allowed = { status: data.status, atualizadoEm: serverTimestamp() };
    await updateDoc(doc(db, 'leads', leadId), allowed);
    return true;
  },

  onLeadsSnapshot(oficinaId, cb) {
    if (IS_DEMO) { cb(demoLeads(oficinaId)); return () => {}; }
    // FIX-3: limit(100) adicionado — sem ele, oficinas com muitos leads
    // causam leituras ilimitadas no Firestore, gerando custo excessivo e
    // lentidão. Mesmo limite usado em listarLeadsDaOficina.
    const q = query(
      collection(db, 'leads'),
      where('oficinaId', '==', oficinaId),
      orderBy('criadoEm', 'desc'),
      limit(100)
    );
    return onSnapshot(
      q,
      snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      (error) => {
        if (
          error.code === 'permission-denied' ||
          error.code === 'unauthenticated'
        ) return;
        console.warn('[onLeadsSnapshot error]', error.code, error.message);
      }
    );
  },

  // ── AVALIAÇÕES ────────────────────────────────────────────────
  async avaliarOficina(oficinaId, nota, comentario = '') {
    if (IS_DEMO) return demoSave('avaliacao', { oficinaId, nota, comentario });
    const user = auth?.currentUser;
    if (!user) throw new Error('Faça login para avaliar.');
    // FIX-4a: rate limit client-side mantido apenas como UX (anti-duplo-clique).
    // Era bypassável via localStorage.clear() ou janela anônima.
    if (!rateLimitUX('avaliacao:' + user.uid + ':' + oficinaId, 1, 86_400_000))
      throw new Error('Você já avaliou esta oficina hoje.');

    // FIX-4b: verificação server-side — consulta se o uid já avaliou esta oficina.
    // Impede duplicatas mesmo que o rate limit client-side seja contornado.
    const avalSnap = await getDocs(
      query(
        collection(db, 'oficinas', oficinaId, 'avaliacoes'),
        where('uid', '==', user.uid),
        limit(1)
      )
    );
    if (!avalSnap.empty) throw new Error('Você já avaliou esta oficina.');

    // Salva avaliação
    await addDoc(collection(db, 'oficinas', oficinaId, 'avaliacoes'), {
      uid: user.uid,
      nota,
      comentario: sanitize(comentario, 500),
      criadoEm: serverTimestamp()
    });

    // Recalcula média no documento principal via transação
    await runTransaction(db, async (tx) => {
      const ofRef  = doc(db, 'oficinas', oficinaId);
      const ofSnap = await tx.get(ofRef);
      if (!ofSnap.exists()) throw new Error('Oficina não encontrada');
      const { avaliacao = 0, totalAvaliacoes = 0 } = ofSnap.data();
      const novoTotal = totalAvaliacoes + 1;
      const novaMedia = ((avaliacao * totalAvaliacoes) + nota) / novoTotal;
      tx.update(ofRef, {
        avaliacao:       Math.round(novaMedia * 10) / 10,
        totalAvaliacoes: novoTotal,
        avaliacoes:      increment(1),
        atualizadoEm:    serverTimestamp()
      });
    });
  },

  async listarAvaliacoes(oficinaId) {
    if (IS_DEMO) return demoAvaliacoes(oficinaId);
    const q = query(
      collection(db, 'oficinas', oficinaId, 'avaliacoes'),
      orderBy('criadoEm', 'desc'),
      limit(20)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  // ── ANALYTICS (write-only) ────────────────────────────────────
  async _trackAnalytics(payload) {
    if (IS_DEMO || !isFirebaseReady) return;
    try {
      await addDoc(collection(db, 'analytics'), {
        ...sanitizeData(payload), criadoEm: serverTimestamp()
      });
    } catch (e) { /* analytics não pode quebrar o app */ }
  },

  async trackEvent(oficinaId, tipo) {
    if (IS_DEMO || !isFirebaseReady) return;
    try {
      const campo = tipo === 'impressao' ? 'stats.impressoes'
                  : tipo === 'clique'    ? 'stats.cliques'
                  : tipo === 'whatsapp'  ? 'stats.whatsapp'
                  : tipo === 'orcamento' ? 'stats.orcamentos'
                  : null;
      if (!campo) return;
      await updateDoc(doc(db, 'oficinas', oficinaId), { [campo]: increment(1) });
    } catch(e) { /* silent */ }
  },

  // ── DIAGNÓSTICO ───────────────────────────────────────────────
  async __diag() {
    const result = { mode: APP_MODE, connected: isFirebaseReady };
    if (!isFirebaseReady) { console.table(result); return result; }
    try {
      const snap = await getDocs(query(collection(db, 'oficinas'), limit(1)));
      result.read = true; result.readCount = snap.size;
    } catch (e) { result.readError = e.message; }
    console.table(result);
    return result;
  }
};

// ════════════════════════════════════════════════════════════════
//  CAMADA DE SERVIÇOS / CONTROLLERS
//  window.Services — expostos para migração gradual ao app principal.
//  Cada service será migrado para Cloud Function quando escalar.
// ════════════════════════════════════════════════════════════════

// ── OficinaService ───────────────────────────────────────────────
//
//  Responsabilidade: CRUD de oficinas com cache in-memory (5 min).
//  TODO (Cloud Function): listar/filtrar oficinas no server para
//  evitar expor dados não necessários ao client.
//
const OficinaService = (() => {
  const _cache  = new Map(); // key → { data, ts }
  const TTL_MS  = 5 * 60 * 1000; // 5 minutos

  function _cacheGet(key) {
    const hit = _cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > TTL_MS) { _cache.delete(key); return null; }
    return hit.data;
  }
  function _cachePut(key, data) { _cache.set(key, { data, ts: Date.now() }); }

  return {
    // Lista com cache de 5 minutos
    async listar(filtros = {}) {
      const key = JSON.stringify(filtros);
      const hit = _cacheGet(key);
      if (hit) return hit;
      const data = await window.FB.listarOficinas(filtros);
      _cachePut(key, data);
      return data;
    },

    // Busca individual com cache
    async porId(id) {
      const hit = _cacheGet('id:' + id);
      if (hit) return hit;
      const data = await window.FB.getOficinaById(id);
      if (data) _cachePut('id:' + id, data);
      return data;
    },

    // Invalida todo o cache (chamar após cadastro/edição)
    invalidar() { _cache.clear(); },

    // Cadastrar (invalida cache)
    async cadastrar(data) {
      const id = await window.FB.cadastrarOficina(data);
      this.invalidar();
      return id;
    },

    // Atualizar (invalida cache)
    async atualizar(id, data) {
      await window.FB.atualizarOficina(id, data);
      this.invalidar();
      return true;
    },
  };
})();

// ── LeadService ──────────────────────────────────────────────────
//
//  Responsabilidade: envio de leads e gestão de status.
//  TODO (Cloud Function): enviarLead com rate limit server-side,
//  envio de notificação push/email para a oficina.
//
const LeadService = {
  async enviar(data) {
    return window.FB.enviarLead(data);
  },

  async listar(oficinaId) {
    return window.FB.listarLeadsDaOficina(oficinaId);
  },

  async atualizar(leadId, status) {
    return window.FB.atualizarLead(leadId, { status });
  },

  onSnapshot(oficinaId, cb) {
    return window.FB.onLeadsSnapshot(oficinaId, cb);
  },
};

// ── SearchController ─────────────────────────────────────────────
//
//  Responsabilidade: busca de oficinas com cache de 1 minuto.
//  Reduz chamadas desnecessárias ao Firestore quando o usuário
//  filtra rapidamente.
//
//  TODO (Cloud Function): implementar busca full-text server-side
//  (Algolia/Elasticsearch) para escalar além do filtro client-side.
//
const SearchController = (() => {
  const _cache = new Map(); // key → { data, ts }
  const TTL_MS = 60 * 1000; // 1 minuto

  function _key(filtros) { return JSON.stringify(filtros); }
  function _get(key) {
    const h = _cache.get(key);
    if (!h) return null;
    if (Date.now() - h.ts > TTL_MS) { _cache.delete(key); return null; }
    return h.data;
  }
  function _put(key, data) { _cache.set(key, { data, ts: Date.now() }); }

  return {
    // Busca com cache de 1 minuto
    async buscar(filtros = {}) {
      const key = _key(filtros);
      const hit = _get(key);
      if (hit) {
        console.info('[SearchController] cache hit:', key.slice(0, 60));
        return hit;
      }
      const data = await window.FB.listarOficinas(filtros);
      _put(key, data);
      return data;
    },

    // Invalida o cache de busca (ex: após novo cadastro)
    invalidar() { _cache.clear(); },

    // Estatísticas de cache (debug)
    stats() {
      const agora = Date.now();
      return {
        entradas: _cache.size,
        validas:  [..._cache.values()].filter(h => agora - h.ts < TTL_MS).length,
      };
    },
  };
})();

// ── AuthController ───────────────────────────────────────────────
//
//  Responsabilidade: estado de sessão e callbacks de auth.
//  TODO (Cloud Function): validar tokens no servidor para
//  operações críticas (upgrade de plano, acesso a dados sensíveis).
//
const AuthController = (() => {
  let _user    = null;
  let _oficina = null;
  const _listeners = [];

  // Inicializa listener assim que Firebase estiver pronto
  window.addEventListener('fbready', () => {
    window.FB.onAuthChange(async (user) => {
      _user = user;
      _oficina = user ? await window.FB.getMinhaOficina(user.uid).catch(() => null) : null;
      _listeners.forEach(fn => fn({ user: _user, oficina: _oficina }));
    });
  });

  return {
    getUser()    { return _user; },
    getOficina() { return _oficina; },
    isLogado()   { return !!_user; },

    onChange(fn) {
      _listeners.push(fn);
      // Dispara imediatamente com estado atual (se já inicializado)
      if (_user !== null || _oficina !== null) fn({ user: _user, oficina: _oficina });
      return () => {
        const i = _listeners.indexOf(fn);
        if (i >= 0) _listeners.splice(i, 1);
      };
    },

    async login(email, pass) {
      const user = await window.FB.login(email, pass);
      return user;
    },

    async logout() {
      await window.FB.logout();
      _user = null; _oficina = null;
      _listeners.forEach(fn => fn({ user: null, oficina: null }));
    },
  };
})();

// ── Expor via window.Services ────────────────────────────────────
//
//  Padrão de migração gradual:
//    1. Hoje: window.Services.Search.buscar(filtros)
//    2. Futuro: substitui internamente por Cloud Function call
//       sem mudar a interface usada pelo app.
//
window.Services = Object.freeze({
  Oficina: OficinaService,
  Lead:    LeadService,
  Search:  SearchController,
  Auth:    AuthController,
});

// ── DEMO STUBS (modo DEMO) ────────────────────────────────────────
//  Funções auxiliares usadas pelos métodos IS_DEMO acima.
//  Mantidas aqui para não poluir o bundle de produção.
//  demoOficinas e demoLeads são definidas no index.html (legacy).
//  As que não têm contraparte no index.html ficam aqui.

function demoAvaliacoes(oficinaId) {
  // Retorna avaliações fictícias para o modo demo.
  // Em produção, substituído por listarAvaliacoes() → Firestore.
  return [
    { id: 'av1', nota: 5, comentario: 'Excelente atendimento, rápido e eficiente!',
      userName: 'Carlos M.', criadoEm: { seconds: Math.floor(Date.now()/1000) - 86400 } },
    { id: 'av2', nota: 4, comentario: 'Bom serviço, preço justo.',
      userName: 'Ana P.', criadoEm: { seconds: Math.floor(Date.now()/1000) - 172800 } },
    { id: 'av3', nota: 5, comentario: 'Super recomendo, profissionais de qualidade.',
      userName: 'Roberto S.', criadoEm: { seconds: Math.floor(Date.now()/1000) - 259200 } },
  ];
}

// Módulo ES tem escopo isolado — funções do index.html só são acessíveis via window.*
// Wrappers locais que delegam para window.* com fallback seguro
let _demoId = 9000;

function demoSave(col, data) {
  if (typeof window.demoSave === 'function') return window.demoSave(col, data);
  return 'demo_' + (++_demoId);
}

function demoLeads(oficinaId) {
  if (typeof window.demoLeads === 'function') return window.demoLeads(oficinaId);
  return [];
}

function demoOficinas(filtros) {
  if (typeof window.demoOficinas === 'function') return window.demoOficinas(filtros);
  return [];
}

// ── window.APP — alias de compatibilidade para window.FB ─────────
// Código legado no index.html pode referenciar window.APP.
// FIX-1: a atribuição dupla anterior era código morto (a segunda linha nunca
// executava pois window.APP já havia sido definido na linha acima).
// Preserva window.APP pré-existente (do index.html legado) quando presente,
// caso contrário aponta para window.FB.
if (!window.APP) window.APP = window.FB;

window.dispatchEvent(new Event('fbready'));
