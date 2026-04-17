// ═══════════════════════════════════════════════════════════════
//  MecBusca — Camada de Dados Unificada (firebase-layer.js)
//
//  Mudanças principais:
//   1. Modo DEMO/PROD explícito — uma constante, zero ambiguidade.
//   2. Rate limit migrado para Cloud Functions (server-side).
//      O rate limit client-side permanece como UX (feedback rápido),
//      mas não é a barreira de segurança.
//   3. Nenhuma chave de API ou config sensível no bundle.
//      Use variáveis de ambiente no build ou __FIREBASE_CONFIG__
//      injetado pelo hosting (ver nota).
//   4. Separação clara: funções públicas vs. autenticadas.
//   5. Sistema de planos + ranking por score (v2).
//      Planos: 'basico' (free) | 'pro' | 'premium'
//      Score = proximidade(40) + avaliação(35) + serviço(15) +
//              plano(10) + engajamento(5) + aberto(5) + vol_aval(5)
//      listarOficinas() ordena por score após filtros.
//      listarOficinasAdmin() expõe scores para debug.
// ═══════════════════════════════════════════════════════════════

// ── 1. MODO DE OPERAÇÃO ──────────────────────────────────────────
//
//  DEMO  → nenhuma chamada ao Firestore; dados fictícios locais.
//  PROD  → Firebase real; requer projeto configurado.
//
//  Como ativar PROD:
//    • Defina window.__MECBUSCA_MODE = 'PROD' ANTES deste script, ou
//    • Use a variável de build __MODE__ injetada pelo bundler, ou
//    • Adicione ?mode=prod na URL (só em ambientes de staging).
//
const _urlMode  = new URLSearchParams(location.search).get('mode');
const APP_MODE  = (
  window.__MECBUSCA_MODE ||
  _urlMode?.toUpperCase() ||
  'DEMO'   // ← padrão seguro: nunca quebra sem Firebase configurado
);
const IS_PROD   = APP_MODE === 'PROD';
const IS_DEMO   = !IS_PROD;

console.info(`[MecBusca] Modo: ${APP_MODE}`);

// ── PLANOS ───────────────────────────────────────────────────────
//
//  Use estes valores em qualquer lugar do app (evita strings soltas).
//
//  Firestore: campo `plano` em cada documento da coleção `oficinas`.
//  Valores válidos: 'basico' | 'pro' | 'premium'
//  Padrão no cadastro: 'basico' (gratuito, nunca null/undefined).
//
export const PLANOS = Object.freeze({
  BASICO:  { id: 'basico',  label: 'Grátis',   prioridade: 0,    preco: 0  },
  PRO:     { id: 'pro',     label: 'Pro',       prioridade: 500,  preco: 49 },
  PREMIUM: { id: 'premium', label: 'Premium',   prioridade: 1000, preco: 97 },
});

// Score máximo teórico por plano (para calibração de pesos):
//   basico:  40+35+15+3+5+5+5 = 108
//   pro:     40+35+15+8+5+5+5 = 113
//   premium: 40+35+15+10+5+5+5 = 115
// A diferença de plano (~2–7pts) é intencional: uma oficina gratuita
// muito bem avaliada e próxima AINDA supera uma premium mal avaliada.
// Isso garante credibilidade no ranking para os usuários finais.

// ── 2. CONFIG DO FIREBASE ────────────────────────────────────────
//
//  Opção A (recomendada para produção):
//    Injete a config via Firebase Hosting "__firebase_config__"
//    (https://firebase.google.com/docs/hosting/reserved-urls)
//    window.__firebase_config__ é preenchido automaticamente.
//
//  Opção B (desenvolvimento):
//    Coloque a config aqui ou em um arquivo .env não commitado.
//
//  NUNCA commite apiKey real em repositório público.
//  A apiKey do Firebase não é um segredo de servidor — ela identifica
//  o projeto — mas as REGRAS do Firestore é que protegem os dados.
//
const firebaseConfig = (() => {
  // Opção A: config injetada pelo Firebase Hosting
  if (typeof __firebase_config__ !== 'undefined') {
    return JSON.parse(__firebase_config__);
  }
  // Opção B: fallback de desenvolvimento (substitua pelos valores reais)
  return {
    apiKey:            import.meta?.env?.VITE_FB_API_KEY     || '',
    authDomain:        import.meta?.env?.VITE_FB_AUTH_DOMAIN  || '',
    projectId:         import.meta?.env?.VITE_FB_PROJECT_ID   || '',
    storageBucket:     import.meta?.env?.VITE_FB_STORAGE      || '',
    messagingSenderId: import.meta?.env?.VITE_FB_SENDER_ID    || '',
    appId:             import.meta?.env?.VITE_FB_APP_ID       || '',
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
//  ⚠️  Este rate limit protege apenas a experiência do usuário
//      (evita duplo-clique, feedback imediato).
//      A barreira real de segurança são as Regras do Firestore
//      + Cloud Functions com rate limit server-side.
//
//  Para rate limit server-side, implante a Cloud Function abaixo:
//
//  exports.enviarLead = functions.https.onCall(async (data, ctx) => {
//    const ip = ctx.rawRequest.ip;
//    const ref = admin.firestore().doc(`_ratelimits/lead_${ip}`);
//    return admin.firestore().runTransaction(async tx => {
//      const snap = await tx.get(ref);
//      const { count = 0, window = 0 } = snap.data() || {};
//      const now = Date.now();
//      if (now - window < 300_000 && count >= 3)
//        throw new functions.https.HttpsError('resource-exhausted', 'Limite atingido.');
//      tx.set(ref, { count: now - window < 300_000 ? count + 1 : 1, window: now });
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
  return /^\d{2}9\d{8}$/.test(digits);
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
//  Mesmo algoritmo do index.html (calcRankingScore), mas aqui é a
//  fonte canônica — o index.html pode importar ou inline-copiar.
//
//  Parâmetros:
//    o        — objeto oficina do Firestore (campos abaixo)
//    distKm   — distância do usuário em km (0 se desconhecida)
//    query    — string de busca do usuário (ex: "troca de oleo")
//
//  Campos usados de `o`:
//    plano           'basico'|'pro'|'premium'  (padrão: 'basico')
//    avaliacao       0–5
//    totalAvaliacoes número inteiro
//    servicos        [{ nome, ativo }]
//    aberto          boolean
//    stats           { impressoes, cliques }
//
function calcRankingScore(o, distKm = 10, query = '') {
  // Proximidade — peso 40. Distância 0km = 40pts, 20km+ = 0pts.
  const distScore = Math.max(0, 40 - (Math.min(distKm, 20) / 20) * 40);

  // Avaliação — peso 35.
  const avalScore = ((o.avaliacao || 0) / 5) * 35;

  // Match de serviço — peso 15.
  const q = query.toLowerCase().trim();
  const svcs = (o.servicos || []).filter(s => s.ativo);
  const svcScore = q
    ? svcs.some(s => s.nome.toLowerCase() === q)          ? 15
    : svcs.some(s => s.nome.toLowerCase().includes(q) ||
                     q.includes(s.nome.toLowerCase()))    ? 8
    : 0
    : 0;

  // Plano — peso 10.
  //   premium: 10pts | pro: 8pts | basico: 3pts | sem plano: 0pts
  const plano = (o.plano || 'basico').toLowerCase();
  const planScore = plano === 'premium' ? 10
                  : plano === 'pro'     ? 8
                  : plano === 'basico'  ? 3
                  : 0;

  // Bônus: está aberto agora — peso 5.
  const openBoost = o.aberto ? 5 : 0;

  // Bônus: volume de avaliações (reputação) — max 5pts.
  const avalBoost = Math.min(5, Math.floor((o.totalAvaliacoes || 0) / 10));

  // Bônus: engajamento (CTR cliques/impressões) — max 5pts.
  // Só entra quando há dados reais suficientes (>10 impressões).
  const imp = o.stats?.impressoes || 0;
  const cli = o.stats?.cliques    || 0;
  const engBoost = imp > 10 ? Math.min(5, Math.round((cli / imp) * 50)) : 0;

  return Math.round(
    (distScore + avalScore + svcScore + planScore + openBoost + avalBoost + engBoost) * 10
  ) / 10;
}

// Ordena array de oficinas por score (desc). Muta o array original.
function ordenarPorScore(oficinas, distFn, query = '') {
  return oficinas
    .map(o => ({ ...o, _score: calcRankingScore(o, distFn(o), query) }))
    .sort((a, b) => {
      const diff = b._score - a._score;
      // Desempate dentro de 2pts: premium > pro > basico
      if (Math.abs(diff) < 2) {
        const tier = { premium: 2, pro: 1, basico: 0 };
        const ta = tier[a.plano] ?? 0;
        const tb = tier[b.plano] ?? 0;
        if (tb !== ta) return tb - ta;
      }
      return diff;
    });
}

// ── 9. API PÚBLICA ───────────────────────────────────────────────
window.FB = {
  ready:   () => isFirebaseReady || IS_DEMO,
  isProd:  () => IS_PROD,
  isDemo:  () => IS_DEMO,

  // ── AUTH ───────────────────────────────────────────────────────
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

  async logout() {
    if (auth) await signOut(auth);
  },

  async resetPassword(email) {
    if (IS_DEMO) throw new Error('Indisponível em modo DEMO.');
    if (!rateLimitUX('reset:' + email, 2, 300_000))
      throw new Error('Aguarde antes de solicitar novamente.');
    await sendPasswordResetEmail(auth, email);
  },

  onAuthChange(cb) { return auth ? onAuthStateChanged(auth, cb) : () => cb(null); },
  getCurrentUser() { return auth?.currentUser || null; },

  // ── OFICINAS ───────────────────────────────────────────────────
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
      ativo:           true,
      uid:             user.uid,
      // Plano inicial sempre 'basico' (gratuito).
      // Atualizado por Cloud Function após pagamento confirmado.
      plano:           'basico',
      planoAtualizadoEm: serverTimestamp(),
      avaliacoes:      0,
      totalAvaliacoes: 0,
      avaliacao:       0,
      stats:           { impressoes: 0, cliques: 0, whatsapp: 0, orcamentos: 0 },
      criadoEm:        serverTimestamp(),
      atualizadoEm:    serverTimestamp(),
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

    // Busca paginada no Firestore.
    // Filtros compound (cidade + plano) exigiriam índice composto —
    // mantemos filtros client-side para evitar custos de índice no free tier.
    let q = query(
      collection(db, 'oficinas'),
      where('ativo', '==', true),
      limit(pagSize * 3)   // busca 3× para compensar filtros client-side
    );
    if (lastDoc) q = query(q, startAfter(lastDoc));

    const snap = await getDocs(q);
    let oficinas = snap.docs.map(d => ({ id: d.id, _doc: d, ...d.data() }));

    // ── Filtros client-side ────────────────────────────────────────
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
      const q = (filtros.servico || '').toLowerCase();
      oficinas = oficinas.filter(o =>
        (o.servicos || []).some(s =>
          s.ativo && s.nome.toLowerCase().includes(q)));
    }

    // ── Ranking por score ──────────────────────────────────────────
    //
    //  distFn: retorna a distância em km para cada oficina.
    //  Se o usuário compartilhou localização → distância real via Haversine.
    //  Se não → usa o campo `distancia` gravado no Firestore (fallback).
    //
    const userLat = filtros.lat;
    const userLng = filtros.lng;
    const distFn  = (o) => {
      if (userLat && userLng && o.lat && o.lng) {
        // Haversine inline (evita dependência externa)
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

    // Respeita o pagSize original após filtros
    return ranked.slice(0, pagSize);
  },

  // ── LISTAR OFICINAS (admin/debug) ───────────────────────────────
  //
  //  Igual ao listarOficinas mas retorna _score e _planoLabel
  //  para facilitar calibração do ranking. Restrito a usuários
  //  com role='admin' via Regras do Firestore.
  //
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

  // ── UPGRADE DE PLANO ────────────────────────────────────────────
  //
  //  ⚠️  Não atualize o plano direto do client em produção.
  //      Use uma Cloud Function invocada após confirmação de pagamento
  //      (webhook do Stripe / Mercado Pago), assim:
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
  //  Este método client-side serve apenas para DEV / testes de staging.
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

  // ── LEADS ──────────────────────────────────────────────────────
  //
  //  ⚠️  MUDANÇA CRÍTICA:
  //  O campo `whatsapp` do CLIENTE não é mais retornado ao browser
  //  diretamente. A leitura de leads é restrita ao dono da oficina
  //  pelas Regras do Firestore (firestore.rules).
  //
  async enviarLead(data) {
    // UX rate limit (não é a barreira de segurança)
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
    // As Regras do Firestore já garantem que só o dono lê.
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
    // Só campos de status permitidos (reforço no client; regra real no Firestore)
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
    return onSnapshot(q, snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  },

  // ── ANALYTICS (write-only) ─────────────────────────────────────
  async _trackAnalytics(payload) {
    if (IS_DEMO || !isFirebaseReady) return;
    try {
      await addDoc(collection(db, 'analytics'), {
        ...sanitizeData(payload), criadoEm: serverTimestamp()
      });
    } catch (e) { /* analytics não pode quebrar o app */ }
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

window.dispatchEvent(new Event('fbready'));
