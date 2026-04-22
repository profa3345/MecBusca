// ═══════════════════════════════════════════════════════════════
//  MecBusca — Camada de Dados Unificada (firebase-layer.js) v2
//
//  Mudanças v2:
//   1. Plano inicial sempre GRATUITO (basico).
//      Sem citação de preços no cadastro — monetização futura.
//   2. Camada Services/Controllers:
//      OficinaService  — CRUD de oficinas com cache.
//      LeadService     — envio e gestão de leads.
//      SearchController— busca com cache de 1 minuto.
//      AuthController  — autenticação e estado de sessão.
//      Expostos via window.Services para migração gradual.
//   3. Score calculado no client (v1). TODO: migrar para Cloud Function.
//   4. Rate limit client-side (UX). Rate limit real → Cloud Functions.
// ═══════════════════════════════════════════════════════════════

// ── 1. MODO DE OPERAÇÃO ──────────────────────────────────────────
const _urlMode  = new URLSearchParams(location.search).get('mode');
const APP_MODE  = (
  window.__MECBUSCA_MODE ||
  _urlMode?.toUpperCase() ||
  'DEMO'
);
const IS_PROD   = APP_MODE === 'PROD';
const IS_DEMO   = !IS_PROD;
console.info(`[MecBusca] Modo: ${APP_MODE}`);

// ── PLANOS ───────────────────────────────────────────────────────
//
//  v1: todos entram no plano 'basico' (gratuito).
//  Infraestrutura Pro/Premium mantida mas INATIVA no cadastro.
//  Ativa via Cloud Function após confirmação de pagamento.
//
//  NOTA: não exibir preços no fluxo de cadastro (v1 = tudo grátis).
//
export const PLANOS = Object.freeze({
  BASICO:  { id: 'basico',  label: 'Grátis',   prioridade: 0,    preco: 0   },
  PRO:     { id: 'pro',     label: 'Pro',       prioridade: 500,  preco: 49  },
  PREMIUM: { id: 'premium', label: 'Premium',   prioridade: 1000, preco: 97  },
});

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
const _rateLimits = {};
function rateLimitUX(key, maxCalls, windowMs) {
  const now = Date.now();
  if (!_rateLimits[key]) _rateLimits[key] = [];
  _rateLimits[key] = _rateLimits[key].filter(t => now - t < windowMs);
  if (_rateLimits[key].length >= maxCalls) return false;
  _rateLimits[key].push(now);
  return true;
}

// ── 6. SANITIZAÇÃO ───────────────────────────────────────────────
function sanitize(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen).replace(/<[^>]*>/g, '');
}
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
//  TODO (segurança): migrar calcRankingScore para Cloud Function.
//  Risco atual: usuário pode manipular o score via devtools.
//  Mitigação v1: o score só determina ordenação visual, não preços.
//
function calcRankingScore(o, distKm = 10, query = '') {
  const distScore = Math.max(0, 40 - (Math.min(distKm, 20) / 20) * 40);
  const avalScore = ((o.avaliacao || 0) / 5) * 35;
  const q = query.toLowerCase().trim();
  const svcs = (o.servicos || []).filter(s => s.ativo);
  const svcScore = q
    ? svcs.some(s => s.nome.toLowerCase() === q)                                    ? 15
    : svcs.some(s => s.nome.toLowerCase().includes(q) || q.includes(s.nome.toLowerCase())) ? 8
    : 0
    : 0;
  const plano = (o.plano || 'basico').toLowerCase();
  const planScore = plano === 'premium' ? 10 : plano === 'pro' ? 8 : plano === 'basico' ? 3 : 0;
  const openBoost  = o.aberto ? 5 : 0;
  const avalBoost  = Math.min(5, Math.floor((o.totalAvaliacoes || 0) / 10));
  const imp = o.stats?.impressoes || 0;
  const cli = o.stats?.cliques    || 0;
  const engBoost   = imp > 10 ? Math.min(5, Math.round((cli / imp) * 50)) : 0;
  return Math.round((distScore + avalScore + svcScore + planScore + openBoost + avalBoost + engBoost) * 10) / 10;
}

function ordenarPorScore(oficinas, distFn, query = '') {
  return oficinas
    .map(o => ({ ...o, _score: calcRankingScore(o, distFn(o), query) }))
    .sort((a, b) => {
      const diff = b._score - a._score;
      if (Math.abs(diff) < 2) {
        const tier = { premium: 2, pro: 1, basico: 0 };
        const ta = tier[a.plano] ?? 0;
        const tb = tier[b.plano] ?? 0;
        if (tb !== ta) return tb - ta;
      }
      return diff;
    });
}

// ── 9. API PÚBLICA (window.FB) ───────────────────────────────────
window.FB = {
  ready:   () => isFirebaseReady || IS_DEMO,
  isProd:  () => IS_PROD,
  isDemo:  () => IS_DEMO,

  async login(email, password) {
    if (IS_DEMO) throw new Error('Login indisponível em modo DEMO.');
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

  onAuthChange(cb) { return auth ? onAuthStateChanged(auth, cb) : () => cb(null); },
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
    const ref = await addDoc(collection(db, 'oficinas'), {
      ...clean,
      ativo:            true,
      uid:              user.uid,
      // ── Plano inicial: basico (gratuito) ─────────────────────
      // Nunca mude o plano diretamente do client em produção.
      // Use a Cloud Function confirmarPlano após pagamento confirmado.
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
    const clean = sanitizeData(data);
    await updateDoc(doc(db, 'oficinas', oficinaId), { ...clean, atualizadoEm: serverTimestamp() });
    return true;
  },

  async listarOficinas(filtros = {}, pagSize = 20, lastDoc = null) {
    if (IS_DEMO) return demoOficinas(filtros);

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

    const userLat = filtros.lat;
    const userLng = filtros.lng;
    const distFn  = (o) => {
      if (userLat && userLng && o.lat && o.lng) {
        const R = 6371;
        const dLat = (o.lat - userLat) * Math.PI / 180;
        const dLng = (o.lng - userLng) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 +
                  Math.cos(userLat * Math.PI/180) *
                  Math.cos(o.lat   * Math.PI/180) *
                  Math.sin(dLng/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      }
      return parseFloat((o.distancia || '10').replace(',', '.'));
    };

    const ranked = ordenarPorScore(oficinas, distFn, filtros.servico || '');
    return ranked.slice(0, pagSize);
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
    const snap = await getDocs(
      query(collection(db, 'oficinas'), where('ativo', '==', true), limit(200))
    );
    const oficinas = snap.docs.map(d => ({ id: d.id, _doc: d, ...d.data() }));
    const distFn = (o) => parseFloat((o.distancia || '10').replace(',', '.'));
    return ordenarPorScore(oficinas, distFn, '')
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
    const isLocal = ['localhost','127.0.0.1','0.0.0.0'].includes(location.hostname);
    if (!isLocal) throw new Error('__devAtualizarPlano só funciona em localhost.');
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
    if (!rateLimitUX('lead:' + data.whatsapp, 3, 300_000))
      throw new Error('Muitas solicitações. Aguarde alguns minutos.');
    if (IS_DEMO) return demoSave('lead', data);
    const clean = sanitizeData(data);
    if (!validarNome(clean.nomeCliente)) throw new Error('Nome do cliente inválido.');
    if (!validarWpp(clean.whatsapp))     throw new Error('WhatsApp inválido.');
    const ref = await addDoc(collection(db, 'leads'), {
      ...clean, status: 'novo', criadoEm: serverTimestamp()
    });
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
    const allowed = { status: data.status, atualizadoEm: serverTimestamp() };
    await updateDoc(doc(db, 'leads', leadId), allowed);
    return true;
  },

  onLeadsSnapshot(oficinaId, cb) {
    if (IS_DEMO) { cb(demoLeads(oficinaId)); return () => {}; }
    const q = query(
      collection(db, 'leads'),
      where('oficinaId', '==', oficinaId),
      orderBy('criadoEm', 'desc')
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
    if (!rateLimitUX('avaliacao:' + user.uid + ':' + oficinaId, 1, 86_400_000))
      throw new Error('Você já avaliou esta oficina hoje.');

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

window.dispatchEvent(new Event('fbready'));
