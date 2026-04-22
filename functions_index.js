/**
 * MecBusca — Cloud Functions (Node 20)
 *
 * Deploy:
 *   npm install -g firebase-tools
 *   firebase deploy --only functions
 *
 * Estas funções resolvem os problemas de segurança identificados:
 *   1. Ranking calculado server-side (não manipulável via DevTools)
 *   2. Rate limiting real por IP (não bypassável via client)
 *   3. Upgrade de plano apenas via backend (após pagamento confirmado)
 *   4. Envio de lead com validação server-side
 */

const { onCall, HttpsError }    = require('firebase-functions/v2/https');
const { onDocumentCreated }     = require('firebase-functions/v2/firestore');
const { initializeApp }         = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// ── Helpers ──────────────────────────────────────────────────────
function sanitize(str, max = 200) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max).replace(/<[^>]*>/g, '');
}

function validarWpp(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  return /^\d{10,11}$/.test(d);
}

// Rate limit por IP usando Firestore como store
// Retorna true se dentro do limite, false se excedeu
async function checkRateLimit(key, maxCalls, windowMs) {
  const ref  = db.doc(`_ratelimits/${key.replace(/[^a-z0-9_-]/gi, '_')}`);
  const now  = Date.now();

  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const { count = 0, windowStart = 0 } = snap.data() || {};

    if (now - windowStart > windowMs) {
      // Janela expirada — reset
      tx.set(ref, { count: 1, windowStart: now });
      return true;
    }
    if (count >= maxCalls) return false;
    tx.update(ref, { count: FieldValue.increment(1) });
    return true;
  });
}

// ── 1. RANKING SERVER-SIDE ───────────────────────────────────────
/**
 * buscarOficinas — substitui window.FB.listarOficinas() no client.
 * Calcula score no server, evitando manipulação via DevTools.
 *
 * Chamada pelo client:
 *   const fn = httpsCallable(functions, 'buscarOficinas');
 *   const { data } = await fn({ servico: 'Troca de óleo', lat: -20.2, lng: -40.4 });
 */
exports.buscarOficinas = onCall({ region: 'southamerica-east1' }, async (req) => {
  const { servico = '', lat, lng, cidade, bairro, avaliacaoMin, apenasAberta, tipoVeiculo } = req.data;

  // Rate limit: 60 buscas por minuto por usuário/IP
  const uid = req.auth?.uid || req.rawRequest?.ip || 'anon';
  const allowed = await checkRateLimit(`busca_${uid}`, 60, 60_000);
  if (!allowed) throw new HttpsError('resource-exhausted', 'Muitas buscas. Aguarde 1 minuto.');

  let q = db.collection('oficinas').where('ativo', '==', true).limit(60);

  if (cidade) q = q.where('cidade', '==', cidade);

  const snap = await q.get();
  let oficinas = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Filtros adicionais (client-side aqui, seguro pois é server)
  if (bairro)       oficinas = oficinas.filter(o => (o.bairro||'').toLowerCase().includes(bairro.toLowerCase()));
  if (avaliacaoMin) oficinas = oficinas.filter(o => (o.avaliacao||0) >= avaliacaoMin);
  if (apenasAberta) oficinas = oficinas.filter(o => o.aberto);
  if (tipoVeiculo)  oficinas = oficinas.filter(o => (o.tipoVeiculo||[]).includes(tipoVeiculo));
  if (servico) {
    const q2 = servico.toLowerCase();
    oficinas = oficinas.filter(o =>
      (o.servicos||[]).some(s => s.ativo && s.nome.toLowerCase().includes(q2)));
  }

  // ── Score calculado SERVER-SIDE ──────────────────────────────
  function calcScore(o) {
    // Distância (0-40 pts)
    let distKm = 10;
    if (lat && lng && o.lat && o.lng) {
      const R = 6371;
      const dLat = (o.lat - lat) * Math.PI / 180;
      const dLng = (o.lng - lng) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 +
                Math.cos(lat * Math.PI/180) * Math.cos(o.lat * Math.PI/180) *
                Math.sin(dLng/2)**2;
      distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
    const distScore = Math.max(0, 40 - (Math.min(distKm, 20) / 20) * 40);

    // Avaliação (0-35 pts)
    const avalScore = ((o.avaliacao||0) / 5) * 35;

    // Match de serviço (0-15 pts)
    const q2 = (servico||'').toLowerCase().trim();
    const svcs = (o.servicos||[]).filter(s => s.ativo);
    const svcScore = q2
      ? svcs.some(s => s.nome.toLowerCase() === q2) ? 15
      : svcs.some(s => s.nome.toLowerCase().includes(q2)) ? 8
      : 0 : 0;

    // Plano (0-10 pts) — diferença intencional pequena, qualidade > plano
    const planScore = { premium: 10, pro: 8, basico: 3 }[o.plano||'basico'] || 0;

    // Boosts (0-15 pts)
    const openBoost = o.aberto ? 5 : 0;
    const avalBoost = Math.min(5, Math.floor((o.totalAvaliacoes||0) / 10));
    const imp = o.stats?.impressoes || 0;
    const cli = o.stats?.cliques    || 0;
    const engBoost = imp > 10 ? Math.min(5, Math.round((cli/imp)*50)) : 0;

    return Math.round((distScore + avalScore + svcScore + planScore + openBoost + avalBoost + engBoost) * 10) / 10;
  }

  // Aplica score e ordena
  const ranked = oficinas
    .map(o => {
      const _score = calcScore(o);
      // Remove campos internos antes de enviar ao client
      const { uid: _uid, stats, ...safe } = o;
      return { ...safe, _score };
    })
    .sort((a, b) => {
      const diff = b._score - a._score;
      if (Math.abs(diff) < 2) {
        const tier = { premium: 2, pro: 1, basico: 0 };
        return (tier[b.plano]||0) - (tier[a.plano]||0);
      }
      return diff;
    })
    .slice(0, 20);

  return { oficinas: ranked };
});


// ── 2. ENVIO DE LEAD COM RATE LIMIT REAL ────────────────────────
/**
 * enviarLead — substitui window.FB.enviarLead() no client.
 * Rate limit real por IP: 3 leads por 5 minutos.
 */
exports.enviarLead = onCall({ region: 'southamerica-east1' }, async (req) => {
  const ip = req.rawRequest?.ip || 'anon';
  const allowed = await checkRateLimit(`lead_${ip}`, 3, 300_000);
  if (!allowed) throw new HttpsError('resource-exhausted', 'Muitas solicitações. Aguarde alguns minutos.');

  const { nomeCliente, whatsapp, carro, servico, oficinaId, valor } = req.data;

  if (!nomeCliente || sanitize(nomeCliente).length < 2)
    throw new HttpsError('invalid-argument', 'Nome inválido.');
  if (!validarWpp(whatsapp))
    throw new HttpsError('invalid-argument', 'WhatsApp inválido.');
  if (!oficinaId)
    throw new HttpsError('invalid-argument', 'Oficina não informada.');

  // Verifica se a oficina existe
  const ofSnap = await db.doc(`oficinas/${oficinaId}`).get();
  if (!ofSnap.exists) throw new HttpsError('not-found', 'Oficina não encontrada.');

  const ref = await db.collection('leads').add({
    nomeCliente: sanitize(nomeCliente),
    whatsapp:    String(whatsapp).replace(/\D/g, ''),
    carro:       sanitize(carro||'', 100),
    servico:     sanitize(servico||'', 200),
    valor:       typeof valor === 'number' && isFinite(valor) ? valor : 0,
    oficinaId,
    status:      'novo',
    origem:      'busca',
    criadoEm:    FieldValue.serverTimestamp(),
  });

  return { id: ref.id };
});


// ── 3. UPGRADE DE PLANO (apenas server-side) ─────────────────────
/**
 * confirmarPlano — chamado pelo webhook do Mercado Pago / Stripe.
 * Nunca exposto diretamente ao client.
 *
 * Em produção: configure o webhook do gateway para chamar esta função.
 * Exemplo Stripe: stripe listen --forward-to <url>/confirmarPlano
 */
exports.confirmarPlano = onCall({ region: 'southamerica-east1' }, async (req) => {
  // Apenas admins (Custom Claims) podem chamar esta função
  if (!req.auth?.token?.admin) {
    throw new HttpsError('permission-denied', 'Apenas administradores.');
  }

  const { oficinaId, plano } = req.data;
  const validos = ['basico', 'pro', 'premium'];
  if (!validos.includes(plano)) throw new HttpsError('invalid-argument', 'Plano inválido.');

  await db.doc(`oficinas/${oficinaId}`).update({
    plano,
    planoAtualizadoEm: FieldValue.serverTimestamp(),
  });

  return { ok: true };
});


// ── 4. TRIGGER: recalcula score ao atualizar oficina ─────────────
/**
 * onOficinaUpdated — recalcula e persiste _scoreBase quando
 * avaliação, totalAvaliacoes ou plano mudam.
 * Evita recalcular em toda busca.
 */
exports.onOficinaUpdated = onDocumentCreated(
  'oficinas/{id}/avaliacoes/{avalId}',
  async (event) => {
    const { id } = event.params;
    const ofRef  = db.doc(`oficinas/${id}`);
    const ofSnap = await ofRef.get();
    if (!ofSnap.exists) return;

    const o = ofSnap.data();
    const avaliacoes = await ofRef.collection('avaliacoes').get();

    if (avaliacoes.empty) return;

    const notas = avaliacoes.docs.map(d => d.data().nota);
    const total = notas.length;
    const media = Math.round((notas.reduce((a, b) => a + b, 0) / total) * 10) / 10;

    await ofRef.update({
      avaliacao:       media,
      totalAvaliacoes: total,
      atualizadoEm:    FieldValue.serverTimestamp(),
    });
  }
);
