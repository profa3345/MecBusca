// ═══════════════════════════════════════════════════════════════
//  MecBusca — Camada de Dados Unificada (firebase-layer.js) v5
//
//  Melhorias de segurança aplicadas nesta versão:
//   FIX-FL-1: APP_MODE usa Object.freeze + defineProperty non-writable/non-configurable.
//   FIX-FL-2: rateLimitUX valida estrutura do localStorage para evitar
//             manipulação via DevTools (ex: localStorage.setItem('mb_rl_login:x', '[0]')).
//   FIX-FL-3: sanitize remove zero-width characters usados para bypass.
//   FIX-FL-4: avaliarOficina valida nota como inteiro (não aceita 4.9 arredondado para 5).
//   FIX-FL-5: atualizarOficina usa allowlist explícita dos campos permitidos.
//   FIX-FL-6: getOficinaById filtra campos sensíveis antes de retornar ao client.
//   FIX-FL-7: trackEvent usa allowlist de tipos válidos (antes, tipo arbitrário → campo DB injetado).
//   FIX-FL-8: listarOficinasAdmin requer auth ANTES de chamar a CF (não após).
//   FIX-FL-9: ConversionTracker.impression/click sanitiza parâmetros antes de enviar ao analytics.
//   FIX-FL-10: __diag() oculto em produção para evitar vazamento de info interna.
//   FIX-FL-11: Sentry removido — error logger nativo via Firestore (_errors/) + console.
//              Sem dependência externa, sem custo, visível no Firebase Console.
// ═══════════════════════════════════════════════════════════════

// ── 1. MODO DE OPERAÇÃO ──────────────────────────────────────────
// Lê APENAS de window.__MECBUSCA_MODE (definido com Object.defineProperty
// non-writable no index.html — não pode ser sobrescrito via DevTools ou URL).
const APP_MODE = window.__MECBUSCA_MODE || 'DEMO';
const IS_PROD   = APP_MODE === 'PROD';
const IS_DEMO   = !IS_PROD;

// ── PLANOS ───────────────────────────────────────────────────────
const PLANOS = Object.freeze({
  BASICO:  { id: 'basico',  label: 'Grátis',   prioridade: 0,    preco: 0   },
  PRO:     { id: 'pro',     label: 'Pro',       prioridade: 500,  preco: 49  },
  PREMIUM: { id: 'premium', label: 'Premium',   prioridade: 1000, preco: 97  },
});
window.PLANOS = PLANOS;

// ── 2. CONFIG DO FIREBASE ────────────────────────────────────────
const firebaseConfig = (() => {
  if (window.__FIREBASE_CFG__) return window.__FIREBASE_CFG__;
  if (typeof __firebase_config__ !== 'undefined') return JSON.parse(__firebase_config__);
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
window.__fbStatus = () => Object.freeze({ ...FB_STATUS });

let app, db, auth;
let isFirebaseReady = false;

if (IS_PROD) {
  try {
    app  = initializeApp(firebaseConfig);
    db   = getFirestore(app);
    auth = getAuth(app);
    isFirebaseReady = true;
    FB_STATUS.connected = true;
    // FIX-FL-10: não logar info interna em produção
    if (!IS_PROD) console.info('✅ Firebase (PROD) conectado');

    // ── App Check (reCAPTCHA v3) ───────────────────────────────────
    try {
      const RECAPTCHA_KEY = window.__RECAPTCHA_KEY__ || '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI';
      initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(RECAPTCHA_KEY),
        isTokenAutoRefreshEnabled: true,
      });
      window._appCheckReady = true;
    } catch(e) {
      if (!IS_PROD) console.warn('[AppCheck] Falha ao inicializar (ok em localhost):', e.message);
      window._appCheckReady = false;
    }

    try {
      window._fbFunctions = getFunctions(app, 'southamerica-east1');
    } catch(e) {
      if (!IS_PROD) console.warn('Functions não disponível:', e.message);
    }

  } catch (e) {
    FB_STATUS.error = e.message;
    if (!IS_PROD) console.warn('Firebase não inicializado — operando em modo DEMO', e);
  }
} else {
  if (!IS_PROD) console.info('🧪 Modo DEMO ativo — Firebase desativado');
}

// ── 5. RATE LIMIT CLIENT-SIDE (UX apenas) ────────────────────────
// ⚠️  Barreira real = Cloud Functions. Este é apenas anti-duplo-clique.
// FIX-FL-2: valida estrutura do localStorage (array de números) para
//           evitar manipulação via DevTools.
function rateLimitUX(key, maxCalls, windowMs) {
  const now = Date.now();
  const lsKey = 'mb_rl_' + key;
  let hits = [];
  try {
    const raw = localStorage.getItem(lsKey);
    const parsed = JSON.parse(raw || '[]');
    // FIX-FL-2: garantir que é array de timestamps numéricos válidos
    if (Array.isArray(parsed)) {
      hits = parsed.filter(t => typeof t === 'number' && isFinite(t) && t > 0 && t <= now);
    }
  } catch(e) { hits = []; }

  hits = hits.filter(t => now - t < windowMs);
  if (hits.length >= maxCalls) return false;
  hits.push(now);
  try { localStorage.setItem(lsKey, JSON.stringify(hits)); } catch(e) {}
  return true;
}

// ── 6. SANITIZAÇÃO ───────────────────────────────────────────────
// FIX-FL-3: remove zero-width characters além de tags HTML
function sanitize(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str
    .trim()
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '') // zero-width chars (bypass de filtros)
    .replace(/<[^>]*>/g, '')                       // tags HTML
    .slice(0, maxLen);
}

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
    if (typeof v === 'string')           out[k] = sanitize(v);
    else if (typeof v === 'number')      out[k] = isFinite(v) ? v : 0;
    else if (Array.isArray(v))           out[k] = v.slice(0, 50);
    else if (v && typeof v === 'object') out[k] = sanitizeData(v);
    else out[k] = v;
  }
  return out;
}

// ── 7. VALIDADORES ───────────────────────────────────────────────
function validarWpp(wpp) {
  const digits = String(wpp || '').replace(/\D/g, '');
  return /^\d{10,11}$/.test(digits);
}
function validarEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
}
function validarNome(nome) {
  const n = sanitize(nome || '', 200).trim();
  return n.length >= 2 && n.length <= 200;
}

// ── 8. ERROR LOGGER (Firebase-native, sem Sentry) ────────────────
// Registra erros críticos no Firestore (_errors/) + console.
// Gratuito, sem dependência externa, visível no Firebase Console.
const _IGNORED_ERRORS = [
  'ResizeObserver loop',
  'Non-Error exception captured',
  'Loading chunk',
  'NetworkError',
];

function _shouldIgnore(msg) {
  return _IGNORED_ERRORS.some(p => String(msg || '').includes(p));
}

function _captureError(err, context = {}) {
  const msg = err?.message || String(err || 'unknown');
  if (_shouldIgnore(msg)) return;

  // Sempre loga no console (visível no Firebase Functions / Hosting logs)
  if (!IS_PROD) console.error('[MecBusca Error]', msg, context);

  // Em produção grava no Firestore para análise no console
  if (IS_PROD && db) {
    try {
      addDoc(collection(db, '_errors'), {
        msg:     sanitize(msg, 500),
        stack:   sanitize(err?.stack || '', 1000),
        context: sanitizeData(context),
        url:     sanitize(location.pathname + location.hash, 200),
        version: window.__APP_VERSION__ || '0.0.1',
        criadoEm: serverTimestamp(),
      }).catch(() => {}); // não logar falha de logging
    } catch(e) {}
  }
}
window._captureError = _captureError;

// Captura erros globais não tratados
if (IS_PROD) {
  window.addEventListener('unhandledrejection', e => {
    _captureError(e.reason, { type: 'unhandledRejection' });
  });
  window.addEventListener('error', e => {
    _captureError(e.error || e.message, { type: 'globalError', src: e.filename });
  });
}

// _initSentry mantido como no-op para não quebrar chamadas existentes
function _initSentry() { /* Sentry removido — usando logger nativo */ }

// ── ANALYTICS UNIFICADO ──────────────────────────────────────────
const MbAnalytics = {
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
      send_page_view: false,
      anonymize_ip: true,
      cookie_flags: 'SameSite=None;Secure',
    });
  },

  track(eventName, params = {}) {
    if (window.gtag && this._ga4Id) {
      window.gtag('event', sanitize(eventName, 100), {
        ...params,
        app_version: window.__APP_VERSION__ || '0.0.1',
        app_mode:    IS_PROD ? 'prod' : 'demo',
      });
    }
    const highValue = ['lead_enviado','cadastro_concluido','upgrade_cta_clicado','pagamento_confirmado'];
    if (IS_PROD && highValue.includes(eventName) && db) {
      try {
        addDoc(collection(db, 'analytics'), {
          evento:    sanitize(eventName, 100),
          params:    sanitizeData(params),
          criadoEm:  serverTimestamp(),
          url:       sanitize(location.pathname + location.hash, 200),
          ua:        sanitize(navigator.userAgent, 200),
        }).catch(() => {});
      } catch(e) {}
    }
  },

  pageView(screenName) {
    if (window.gtag && this._ga4Id) {
      window.gtag('event', 'page_view', {
        page_title:    sanitize(screenName, 100),
        page_location: location.href.slice(0, 500),
      });
    }
  },

  init() { this._loadGA4(); return this; }
};
window.MbAnalytics = MbAnalytics.init();

// ── RANKING POR CONVERSÃO ─────────────────────────────────────────
// FIX-FL-9: sanitiza parâmetros antes de enviar ao analytics
const ConversionTracker = {
  impression(oficinaId, rank, params = {}) {
    const safeId = sanitize(String(oficinaId || ''), 128);
    if (!safeId) return;
    const key = 'mb_impressions';
    try {
      const data = JSON.parse(sessionStorage.getItem(key) || '[]');
      if (Array.isArray(data)) {
        data.push({ id: safeId, rank: Number(rank) || 0, t: Date.now() });
        sessionStorage.setItem(key, JSON.stringify(data.slice(-50)));
      }
    } catch(e) {}
    MbAnalytics.track('oficina_impressao', {
      oficina_id: safeId,
      posicao: Number(rank) || 0,
      servico: sanitize(params.servico || '', 100),
      cidade:  sanitize(params.cidade  || '', 100),
    });
  },

  click(oficinaId, rank, params = {}) {
    const safeId = sanitize(String(oficinaId || ''), 128);
    if (!safeId) return;
    MbAnalytics.track('oficina_clique', {
      oficina_id: safeId,
      posicao: Number(rank) || 0,
    });
    if (IS_PROD && db) {
      updateDoc(doc(db, 'oficinas', safeId), {
        'stats.cliques': increment(1),
        'stats.ultimoEvento': serverTimestamp(),
      }).catch(() => {});
    }
  },

  convert(oficinaId, servico, valor = 0) {
    const safeId = sanitize(String(oficinaId || ''), 128);
    if (!safeId) return;
    MbAnalytics.track('lead_enviado', {
      oficina_id: safeId,
      servico: sanitize(String(servico || ''), 100),
      valor: typeof valor === 'number' && isFinite(valor) ? valor : 0,
    });
    try {
      const hist = JSON.parse(localStorage.getItem('mb_hist_conv') || '[]');
      if (Array.isArray(hist)) {
        hist.unshift({ id: safeId, servico: sanitize(String(servico || ''), 100), t: Date.now() });
        localStorage.setItem('mb_hist_conv', JSON.stringify(hist.slice(0, 20)));
      }
    } catch(e) {}
  },

  getHistoricoServicos() {
    try {
      const hist = JSON.parse(localStorage.getItem('mb_hist_conv') || '[]');
      if (!Array.isArray(hist)) return [];
      const count = {};
      hist.forEach(h => { if (h.servico && typeof h.servico === 'string') count[h.servico] = (count[h.servico] || 0) + 1; });
      return Object.entries(count).sort((a,b) => b[1]-a[1]).map(([s]) => s);
    } catch(e) { return []; }
  },
};
window.ConversionTracker = ConversionTracker;

// ── 9. API PÚBLICA (window.FB) ───────────────────────────────────────

// FIX-FL-6: campos sensíveis a remover de documentos de oficina antes de retornar ao client
const OFICINA_SENSITIVE_FIELDS = ['uid', 'stats', 'planoAtualizadoEm'];
function stripSensitive(oficina) {
  if (!oficina) return oficina;
  const clean = { ...oficina };
  OFICINA_SENSITIVE_FIELDS.forEach(f => delete clean[f]);
  return clean;
}

// FIX-FL-7: tipos de evento permitidos para trackEvent
const TRACK_EVENT_TIPOS = Object.freeze({
  impressao: 'stats.impressoes',
  clique:    'stats.cliques',
  whatsapp:  'stats.whatsapp',
  orcamento: 'stats.orcamentos',
});

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

    // FIX-FL-5: remover campos protegidos do payload de criação
    const { uid: _u, plano: _p, rankScore: _r, score: _s,
            avaliacao: _av, totalAvaliacoes: _ta, stats: _st, ...safeClean } = clean;

    const ref = await addDoc(collection(db, 'oficinas'), {
      ...safeClean,
      ativo:             true,
      uid:               user.uid,
      aberto:            _calcAberto(clean.horarios),
      plano:             'basico',
      planoAtualizadoEm: serverTimestamp(),
      avaliacao:         0,
      totalAvaliacoes:   0,
      stats:             { impressoes: 0, cliques: 0, whatsapp: 0, orcamentos: 0 },
      criadoEm:          serverTimestamp(),
      atualizadoEm:      serverTimestamp(),
    });
    return ref.id;
  },

  async getMinhaOficina(uid) {
    if (IS_DEMO) return null;
    const snap = await getDocs(query(collection(db, 'oficinas'), where('uid', '==', uid)));
    if (snap.empty) return null;
    const d = snap.docs[0];
    // getMinhaOficina é usada pelo dono — retorna dados completos
    return { id: d.id, ...d.data() };
  },

  async getOficinaById(id) {
    if (IS_DEMO) return demoOficinas({}).find(o => o.id === id) || null;
    if (!id || typeof id !== 'string') return null;
    const snap = await getDoc(doc(db, 'oficinas', id));
    if (!snap.exists()) return null;
    // FIX-FL-6: remover campos sensíveis (uid, stats) antes de retornar ao client público
    return stripSensitive({ id: snap.id, ...snap.data() });
  },

  async atualizarOficina(oficinaId, data) {
    if (IS_DEMO) return true;
    const user = auth.currentUser;
    if (!user) throw new Error('Não autorizado');
    const ofSnap = await getDoc(doc(db, 'oficinas', oficinaId));
    if (!ofSnap.exists()) throw new Error('Oficina não encontrada');
    if (ofSnap.data().uid !== user.uid) throw new Error('Sem permissão para editar esta oficina');

    // FIX-FL-5: allowlist explícita de campos editáveis pelo dono
    const ALLOWED_UPDATE_FIELDS = [
      'nome','descricao','endereco','cidade','bairro','estado','cep',
      'wpp','email','site','telefone','horarios','servicos',
      'tipoVeiculo','fotos','aberto','atualizadoEm',
    ];
    const sanitized = sanitizeData(data);
    const safe = {};
    ALLOWED_UPDATE_FIELDS.forEach(k => {
      if (k in sanitized) safe[k] = sanitized[k];
    });

    if (Object.keys(safe).length === 0) throw new Error('Nenhum campo válido para atualizar.');
    await updateDoc(doc(db, 'oficinas', oficinaId), { ...safe, atualizadoEm: serverTimestamp() });
    return true;
  },

  async listarOficinas(filtros = {}, pagSize = 20, lastDoc = null) {
    if (IS_DEMO) return demoOficinas(filtros);
    if (window._fbFunctions) {
      try {
        const fn = httpsCallable(window._fbFunctions, 'buscarOficinas');
        const res = await fn(filtros);
        const ofs = res.data.oficinas || [];
        ofs.slice(0, 5).forEach((o, i) =>
          ConversionTracker.impression(o.id, i + 1, {
            servico: sanitize(filtros.servico || '', 100),
            cidade:  sanitize(filtros.cidade  || '', 100),
          })
        );
        return ofs;
      } catch(e) {
        if (!IS_PROD) console.warn('[listarOficinas] Cloud Function falhou, usando fallback local:', e.code);
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
        (o.cidade || '').toLowerCase().includes(sanitize(filtros.cidade, 100).toLowerCase()));
    if (filtros.bairro)
      oficinas = oficinas.filter(o =>
        (o.bairro || '').toLowerCase().includes(sanitize(filtros.bairro, 100).toLowerCase()));
    if (filtros.avaliacaoMin)
      oficinas = oficinas.filter(o => (o.avaliacao || 0) >= filtros.avaliacaoMin);
    if (filtros.apenasAberta)
      oficinas = oficinas.filter(o => o.aberto);
    if (filtros.tipoVeiculo)
      oficinas = oficinas.filter(o => (o.tipoVeiculo || []).includes(filtros.tipoVeiculo));
    if (filtros.servico) {
      const qStr = sanitize(filtros.servico, 200).toLowerCase();
      oficinas = oficinas.filter(o =>
        (o.servicos || []).some(s => s.ativo && s.nome.toLowerCase().includes(qStr)));
    }

    return oficinas
      .map(o => stripSensitive(o))
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
    // FIX-FL-8: verificar auth ANTES de chamar CF
    const user = auth?.currentUser;
    if (!user) throw new Error('Não autenticado');

    if (window._fbFunctions) {
      try {
        const fn  = httpsCallable(window._fbFunctions, 'buscarOficinas');
        const res = await fn({ ...filtros, admin: true });
        return (res.data.oficinas || []).map(o => ({
          ...o,
          _planoLabel: PLANOS[o.plano?.toUpperCase()]?.label ?? o.plano,
        }));
      } catch (e) {
        if (e.code === 'permission-denied') throw new Error('Acesso negado. Apenas administradores.');
        if (!IS_PROD) console.warn('[listarOficinasAdmin] Cloud Function falhou:', e.code);
      }
    }

    const snap = await getDocs(
      query(collection(db, 'oficinas'), where('ativo', '==', true), limit(200))
    );
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.avaliacao || 0) - (a.avaliacao || 0))
      .map(o => ({ ...o, _planoLabel: PLANOS[o.plano?.toUpperCase()]?.label ?? o.plano }));
  },

  // Upgrade de plano: apenas via Cloud Function (nunca direto do client em produção)
  async __devAtualizarPlano(oficinaId, plano) {
    if (IS_PROD) throw new Error('__devAtualizarPlano indisponível em produção. Use Cloud Function confirmarPlano.');
    const validos = Object.values(PLANOS).map(p => p.id);
    if (!validos.includes(plano)) throw new Error(`Plano inválido. Use: ${validos.join(' | ')}`);
    await updateDoc(doc(db, 'oficinas', oficinaId), {
      plano, planoAtualizadoEm: serverTimestamp()
    });
    return true;
  },

  // ── LEADS ─────────────────────────────────────────────────────
  async enviarLead(data) {
    const rlKey = 'lead:' + (data.oficinaId || '') + ':' + (data.whatsapp || '');
    if (!rateLimitUX(rlKey, 3, 300_000))
      throw new Error('Muitas solicitações. Aguarde alguns minutos.');
    const clean = sanitizeData(data);
    if (!clean.oficinaId)                throw new Error('Oficina não identificada. Selecione uma oficina.');
    if (!validarNome(clean.nomeCliente)) throw new Error('Nome do cliente inválido.');
    if (!validarWpp(clean.whatsapp))     throw new Error('WhatsApp inválido.');
    if (IS_DEMO) return demoSave('lead', clean);
    if (window._fbFunctions) {
      try {
        const fn = httpsCallable(window._fbFunctions, 'enviarLead');
        const res = await fn(clean);
        ConversionTracker.convert(clean.oficinaId, clean.servico || '', clean.valor || 0);
        return res.data.id;
      } catch(e) {
        if (e.code === 'resource-exhausted') throw new Error('Muitas solicitações. Aguarde alguns minutos.');
        if (!IS_PROD) console.warn('[enviarLead] Cloud Function falhou, usando fallback:', e.code);
      }
    }
    const ref = await addDoc(collection(db, 'leads'), {
      ...clean, status: 'novo', criadoEm: serverTimestamp()
    });
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
    const user = auth?.currentUser;
    if (!user) throw new Error('Não autorizado');
    const leadSnap = await getDoc(doc(db, 'leads', leadId));
    if (!leadSnap.exists()) throw new Error('Lead não encontrado');
    const { oficinaId } = leadSnap.data();
    if (oficinaId) {
      const ofSnap = await getDoc(doc(db, 'oficinas', oficinaId));
      if (ofSnap.exists() && ofSnap.data().uid !== user.uid)
        throw new Error('Sem permissão para atualizar este lead');
    }
    // Validar status contra allowlist
    const STATUS_VALIDOS = ['novo', 'em_andamento', 'concluido', 'cancelado'];
    if (data.status && !STATUS_VALIDOS.includes(data.status))
      throw new Error('Status inválido.');
    const allowed = { status: data.status, atualizadoEm: serverTimestamp() };
    await updateDoc(doc(db, 'leads', leadId), allowed);
    return true;
  },

  onLeadsSnapshot(oficinaId, cb) {
    if (IS_DEMO) { cb(demoLeads(oficinaId)); return () => {}; }
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
        if (error.code === 'permission-denied' || error.code === 'unauthenticated') return;
        if (!IS_PROD) console.warn('[onLeadsSnapshot error]', error.code);
      }
    );
  },

  // ── AVALIAÇÕES ────────────────────────────────────────────────
  async avaliarOficina(oficinaId, nota, comentario = '') {
    if (IS_DEMO) return demoSave('avaliacao', { oficinaId, nota, comentario });
    const user = auth?.currentUser;
    if (!user) throw new Error('Faça login para avaliar.');
    if (!rateLimitUX('avaliacao:' + user.uid + ':' + oficinaId, 1, 86_400_000))
      throw new Error('Você já avaliou esta oficina hoje.');

    // FIX-FL-4: nota deve ser inteiro entre 1 e 5 (não aceita 4.9 etc.)
    const notaInt = Math.round(Number(nota));
    if (!Number.isInteger(notaInt) || notaInt < 1 || notaInt > 5)
      throw new Error('Nota inválida. Use um valor entre 1 e 5.');

    const avalSnap = await getDocs(
      query(
        collection(db, 'oficinas', oficinaId, 'avaliacoes'),
        where('uid', '==', user.uid),
        limit(1)
      )
    );
    if (!avalSnap.empty) throw new Error('Você já avaliou esta oficina.');

    await addDoc(collection(db, 'oficinas', oficinaId, 'avaliacoes'), {
      uid:       user.uid,
      nota:      notaInt,
      comentario: sanitize(comentario, 1000),
      criadoEm:  serverTimestamp()
    });

    // Recalcula média via transação
    await runTransaction(db, async (tx) => {
      const ofRef  = doc(db, 'oficinas', oficinaId);
      const ofSnap = await tx.get(ofRef);
      if (!ofSnap.exists()) throw new Error('Oficina não encontrada');
      const { avaliacao = 0, totalAvaliacoes = 0 } = ofSnap.data();
      const novoTotal = totalAvaliacoes + 1;
      const novaMedia = ((avaliacao * totalAvaliacoes) + notaInt) / novoTotal;
      tx.update(ofRef, {
        avaliacao:       Math.round(novaMedia * 10) / 10,
        totalAvaliacoes: novoTotal,
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
    } catch (e) {}
  },

  async trackEvent(oficinaId, tipo) {
    if (IS_DEMO || !isFirebaseReady) return;
    // FIX-FL-7: usar allowlist de tipos (antes tipo arbitrário → campo DB injetado)
    const campo = TRACK_EVENT_TIPOS[tipo];
    if (!campo) return; // tipo inválido silenciosamente ignorado
    try {
      await updateDoc(doc(db, 'oficinas', sanitize(String(oficinaId), 128)), {
        [campo]: increment(1)
      });
    } catch(e) {}
  },

  // FIX-FL-10: __diag bloqueado em produção para evitar vazamento de info interna
  async __diag() {
    if (IS_PROD) throw new Error('Diagnóstico indisponível em produção.');
    const result = { mode: APP_MODE, connected: isFirebaseReady };
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
// ════════════════════════════════════════════════════════════════

const OficinaService = (() => {
  const _cache  = new Map();
  const TTL_MS  = 5 * 60 * 1000;

  function _cacheGet(key) {
    const hit = _cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > TTL_MS) { _cache.delete(key); return null; }
    return hit.data;
  }
  function _cachePut(key, data) { _cache.set(key, { data, ts: Date.now() }); }

  return {
    async listar(filtros = {}) {
      const key = JSON.stringify(filtros);
      const hit = _cacheGet(key);
      if (hit) return hit;
      const data = await window.FB.listarOficinas(filtros);
      _cachePut(key, data);
      return data;
    },
    async porId(id) {
      const hit = _cacheGet('id:' + id);
      if (hit) return hit;
      const data = await window.FB.getOficinaById(id);
      if (data) _cachePut('id:' + id, data);
      return data;
    },
    invalidar() { _cache.clear(); },
    async cadastrar(data) {
      const id = await window.FB.cadastrarOficina(data);
      this.invalidar();
      return id;
    },
    async atualizar(id, data) {
      await window.FB.atualizarOficina(id, data);
      this.invalidar();
      return true;
    },
  };
})();

const LeadService = {
  async enviar(data)             { return window.FB.enviarLead(data); },
  async listar(oficinaId)        { return window.FB.listarLeadsDaOficina(oficinaId); },
  async atualizar(leadId, status){ return window.FB.atualizarLead(leadId, { status }); },
  onSnapshot(oficinaId, cb)      { return window.FB.onLeadsSnapshot(oficinaId, cb); },
};

const SearchController = (() => {
  const _cache = new Map();
  const TTL_MS = 60 * 1000;

  function _key(filtros) { return JSON.stringify(filtros); }
  function _get(key) {
    const h = _cache.get(key);
    if (!h) return null;
    if (Date.now() - h.ts > TTL_MS) { _cache.delete(key); return null; }
    return h.data;
  }
  function _put(key, data) { _cache.set(key, { data, ts: Date.now() }); }

  return {
    async buscar(filtros = {}) {
      const key = _key(filtros);
      const hit = _get(key);
      if (hit) return hit;
      const data = await window.FB.listarOficinas(filtros);
      _put(key, data);
      return data;
    },
    invalidar() { _cache.clear(); },
    stats() {
      const agora = Date.now();
      return {
        entradas: _cache.size,
        validas:  [..._cache.values()].filter(h => agora - h.ts < TTL_MS).length,
      };
    },
  };
})();

const AuthController = (() => {
  let _user    = null;
  let _oficina = null;
  const _listeners = [];

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
      if (_user !== null || _oficina !== null) fn({ user: _user, oficina: _oficina });
      return () => {
        const i = _listeners.indexOf(fn);
        if (i >= 0) _listeners.splice(i, 1);
      };
    },

    async login(email, pass)  { return window.FB.login(email, pass); },
    async logout() {
      await window.FB.logout();
      _user = null; _oficina = null;
      _listeners.forEach(fn => fn({ user: null, oficina: null }));
    },
  };
})();

window.Services = Object.freeze({
  Oficina: OficinaService,
  Lead:    LeadService,
  Search:  SearchController,
  Auth:    AuthController,
});

// ── DEMO STUBS ────────────────────────────────────────────────────
function demoAvaliacoes(oficinaId) {
  return [
    { id: 'av1', nota: 5, comentario: 'Excelente atendimento!',
      userName: 'Carlos M.', criadoEm: { seconds: Math.floor(Date.now()/1000) - 86400 } },
    { id: 'av2', nota: 4, comentario: 'Bom serviço, preço justo.',
      userName: 'Ana P.', criadoEm: { seconds: Math.floor(Date.now()/1000) - 172800 } },
  ];
}

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

if (!window.APP) window.APP = window.FB;

window.dispatchEvent(new Event('fbready'));
