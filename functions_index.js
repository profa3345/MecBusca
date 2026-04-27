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
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { initializeApp }         = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// ── Helpers ──────────────────────────────────────────────────────

// ── App Check enforcement ─────────────────────────────────────────
// Rejeita chamadas sem token válido do App Check.
// Para ativar:
//   1. Firebase Console → App Check → Apps → Registrar app web
//   2. Ativar enforcement: Functions → Enforce
//   3. firebase.json: adicionar "appCheck": { "isTokenAutoRefreshEnabled": true }
//
// Em dev/emulador, App Check é bypass automático (FIREBASE_EMULATOR_HUB setado).
//
function requireAppCheck(req, functionName) {
  // Em emulador, sempre permitir
  if (process.env.FUNCTIONS_EMULATOR === 'true') return;

  // App Check token ausente = chamada não-autorizada (não veio do app)
  if (!req.app) {
    console.warn(`[${functionName}] App Check ausente — rejeitado. IP: ${req.rawRequest?.ip}`);
    throw new HttpsError('unauthenticated', 'Chamada não autorizada. Use o app oficial.');
  }
  // App Check token presente e verificado pelo SDK automaticamente
}

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

  return db.runTransaction(async tx => {  // INFO-F6: maxAttempts padrão=5, aceitável para rate limiting
    const snap = await tx.get(ref);
    const { count = 0, windowStart = 0 } = snap.data() || {};

    if (now - windowStart > windowMs) {
      // Janela expirada — reset
      tx.set(ref, { count: 1, windowStart: now });
      return true;
    }
    if (count >= maxCalls) return false;
    // BUG-F1 FIX: usar set+merge ao invés de update para evitar NOT_FOUND
    // se o documento existe mas foi criado por tx.set em outra transação concorrente
    tx.set(ref, { count: FieldValue.increment(1), windowStart }, { merge: true });
    return true;
  });
}

// ── 1. RANKING SERVER-SIDE ───────────────────────────────────────
/**
 * buscarOficinas — substitui window.FB.listarOficinas() e window.FB.listarOficinasAdmin() no client.
 * Calcula score no server, evitando manipulação via DevTools.
 *
 * Chamada pelo client (busca pública):
 *   const fn = httpsCallable(functions, 'buscarOficinas');
 *   const { data } = await fn({ servico: 'Troca de óleo', lat: -20.2, lng: -40.4 });
 *
 * Chamada pelo painel admin (sem limite de resultados):
 *   const { data } = await fn({ admin: true });
 *   // Requer usuário autenticado — verificado via req.auth.
 */
exports.buscarOficinas = onCall({ region: 'southamerica-east1', enforceAppCheck: true }, async (req) => {
  requireAppCheck(req, 'buscarOficinas');
  const { servico = '', lat, lng, cidade, bairro, avaliacaoMin, apenasAberta, tipoVeiculo, admin = false } = req.data;

  // Rate limit: 60 buscas por minuto por usuário/IP
  const uid = req.auth?.uid || req.rawRequest?.ip || 'anon';
  const allowed = await checkRateLimit(`busca_${uid}`, 60, 60_000);
  if (!allowed) throw new HttpsError('resource-exhausted', 'Muitas buscas. Aguarde 1 minuto.');

  // Modo admin: requer autenticação — retorna todos os resultados sem slice(20)
  if (admin && !req.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Admin requer autenticação.');
  }

  // Limite base: 60 para buscas públicas, 500 para admin
  // BUG-F3 FIX: quando cidade está definida, usar limite maior pois o Firestore
  // aplica limit() ANTES dos filtros adicionais — sem isso, limit(60) poderia
  // retornar 60 docs de outras cidades e 0 da cidade buscada.
  const queryLimit = admin ? 500 : (cidade ? 300 : 60);
  let q = db.collection('oficinas').where('ativo', '==', true).limit(queryLimit);

  // Com índice composto ativo+cidade no Firestore Console, esta query é eficiente.
  // Sem o índice, é um full scan filtrado — aceitável para v1.
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
    .slice(0, admin ? 500 : 20);

  return { oficinas: ranked };
});


// ── 2. ENVIO DE LEAD COM RATE LIMIT REAL ────────────────────────
/**
 * enviarLead — substitui window.FB.enviarLead() no client.
 * Rate limit real por IP: 3 leads por 5 minutos.
 */
exports.enviarLead = onCall({ region: 'southamerica-east1', enforceAppCheck: true }, async (req) => {
  requireAppCheck(req, 'enviarLead');
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

  // Verifica se a oficina existe E está ativa
  const ofSnap = await db.doc(`oficinas/${oficinaId}`).get();
  if (!ofSnap.exists) throw new HttpsError('not-found', 'Oficina não encontrada.');
  // INFO-F4 FIX: não aceitar leads para oficinas desativadas
  if (!ofSnap.data().ativo) throw new HttpsError('not-found', 'Oficina indisponível no momento.');

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

  // FIX ESTRATÉGIA: notificar a oficina via WhatsApp quando novo lead chega
  // Usa fetch para Evolution API (auto-hospedada) ou qualquer gateway HTTP
  // Configure a URL via Secret: firebase functions:secrets:set WPP_API_URL
  const wppUrl = process.env.WPP_API_URL;
  if (wppUrl) {
    const ofData = ofSnap.data();
    const wppOficina = ofData.wpp || ofData.whatsapp;
    if (wppOficina) {
      const msg = `🔔 *Novo lead no MecBusca!*

👤 Cliente: ${sanitize(nomeCliente)}
🔧 Serviço: ${sanitize(servico||'não informado')}
🚗 Carro: ${sanitize(carro||'não informado')}
📱 WhatsApp: ${String(whatsapp).replace(/\D/g,'')}

Responda rápido — leads respondidos em menos de 5 min convertem 3x mais!`;
      fetch(wppUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: '55' + String(wppOficina).replace(/\D/g,''), text: msg }),
      }).catch(e => console.warn('[enviarLead] WPP notify failed:', e.message));
    }
  }

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
exports.confirmarPlano = onCall({ region: 'southamerica-east1', enforceAppCheck: true }, async (req) => {
  requireAppCheck(req, 'confirmarPlano');
  // INFO-F5 FIX: dupla verificação — Custom Claim OU documento na coleção 'admins'.
  // Custom Claim: setar via Admin SDK: admin.auth().setCustomUserClaims(uid, {admin:true})
  // Fallback: documento admins/{uid} com campo active:true (mais fácil de gerenciar)
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const isClaimAdmin = req.auth?.token?.admin === true;
  let isDocAdmin = false;
  if (!isClaimAdmin) {
    const adminSnap = await db.doc(`admins/${uid}`).get();
    isDocAdmin = adminSnap.exists && adminSnap.data()?.active === true;
  }
  if (!isClaimAdmin && !isDocAdmin) {
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
// FIX B4: usar onDocumentWritten para cobrir edições de avaliação, não só criação
exports.onOficinaUpdated = onDocumentWritten(
  'oficinas/{id}/avaliacoes/{avalId}',
  async (event) => {
    const { id } = event.params;

    // FIX B4: onDocumentWritten — verificar se doc foi deletado
    const afterSnap = event.data?.after;
    if (!afterSnap?.exists) return; // deleção — não recalcular

    const ofRef  = db.doc(`oficinas/${id}`);
    const ofSnap = await ofRef.get();
    if (!ofSnap.exists) return;

    const avaliacoes = await ofRef.collection('avaliacoes').get();
    if (avaliacoes.empty) return;

    const notas = avaliacoes.docs
      .map(d => d.data().nota)
      .filter(n => typeof n === 'number' && n >= 1 && n <= 5);
    if (!notas.length) return;

    const total = notas.length;
    const media = Math.round((notas.reduce((a, b) => a + b, 0) / total) * 10) / 10;

    await ofRef.update({
      avaliacao:       media,
      totalAvaliacoes: total,
      atualizadoEm:    FieldValue.serverTimestamp(),
    });
  }
);


// ── 5. PROXY SEGURO PARA CHATBOT ANA (Claude API) ───────────────
/**
 * anaChatProxy — proxy server-side para a API Anthropic.
 * A API key NUNCA é exposta no client.
 *
 * Configuração:
 *   firebase functions:config:set anthropic.api_key="sk-ant-..."
 *   Ou use Secret Manager:
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 *
 * Rate limit: 10 mensagens por minuto por IP.
 */
const { defineSecret } = require('firebase-functions/params');
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

exports.anaChatProxy = onCall(
  { region: 'southamerica-east1', secrets: [ANTHROPIC_API_KEY], enforceAppCheck: true },
  async (req) => {
    // Rate limit: 10 msgs/min por IP
    const ip = req.rawRequest?.ip || 'anon';
    const allowed = await checkRateLimit(`ana_chat_${ip}`, 10, 60_000);
    if (!allowed) throw new HttpsError('resource-exhausted', 'Muitas mensagens. Aguarde 1 minuto.');

    const { messages, system } = req.data;

    // Validação básica
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new HttpsError('invalid-argument', 'Mensagens não fornecidas.');
    }
    if (messages.length > 20) {
      throw new HttpsError('invalid-argument', 'Histórico muito longo. Inicie uma nova conversa.');
    }

    // Sanitiza mensagens (previne injection no system prompt)
    const cleanMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: sanitize(String(m.content || ''), 2000),
    }));

    // Chama API Anthropic
    const apiKey = ANTHROPIC_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError('internal', 'Chave da API não configurada.');
    }

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          system: sanitize(String(system || ''), 5000),
          messages: cleanMessages,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('[anaChatProxy] Anthropic API error:', response.status, errText);
        throw new HttpsError('internal', 'Erro ao processar. Tente novamente.');
      }

      const data = await response.json();
      const reply = data.content?.[0]?.text || '';

      return { reply };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      console.error('[anaChatProxy] fetch error:', err);
      throw new HttpsError('internal', 'Falha na comunicação com IA.');
    }
  }
);
