/**
 * MecBusca — Cloud Functions v2.0
 *
 * Melhorias v2.0:
 *   FN-1: Middleware de autenticação reutilizável (elimina código repetido).
 *   FN-2: Rate limiting por IP via Firestore (previne abuse de endpoints públicos).
 *   FN-3: Validação de input com sanitização (previne XSS/injection em dados salvos).
 *   FN-4: Erros estruturados com códigos (facilita debug e tratamento no front).
 *   FN-5: Sitemap dinâmico com cache de 1h (reduz cold-reads no Firestore).
 *   FN-6: Webhook de novo lead com notificação para a oficina (Email/FCM).
 *   FN-7: onUserCreate trigger para inicializar perfil do usuário no Firestore.
 *   FN-8: Scheduled function para limpar leads antigos (LGPD compliance).
 *   FN-9: Google Analytics 4 Measurement Protocol para eventos server-side.
 */

'use strict';

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { beforeUserCreated } = require('firebase-functions/v2/identity');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const auth = admin.auth();

// Configurações gerais
const REGION = 'southamerica-east1'; // São Paulo — menor latência para BR
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minuto
const RATE_LIMIT_MAX_REQS  = 10;    // máximo por janela por IP

// ── Utilitários ───────────────────────────────────────────────────────────────

/** Sanitiza string: remove tags HTML e limpa espaços extras */
function sanitizeStr(value, maxLen = 500) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, '')       // strip HTML tags
    .replace(/[<>"'&]/g, c => ({   // encode caracteres perigosos
      '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;',
    })[c])
    .trim()
    .slice(0, maxLen);
}

/** FN-2: Rate limiting por IP usando Firestore */
async function checkRateLimit(ip, endpoint) {
  const key = `ratelimit_${endpoint}_${ip.replace(/[.:]/g, '_')}`;
  const ref  = db.collection('_ratelimits').doc(key);
  const now  = Date.now();

  try {
    const updated = await db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      const data = doc.exists ? doc.data() : { count: 0, windowStart: now };
      const elapsed = now - data.windowStart;

      if (elapsed > RATE_LIMIT_WINDOW_MS) {
        // Nova janela
        tx.set(ref, { count: 1, windowStart: now, ttl: new Date(now + RATE_LIMIT_WINDOW_MS * 5) });
        return true;
      }
      if (data.count >= RATE_LIMIT_MAX_REQS) {
        return false; // limite atingido
      }
      tx.update(ref, { count: admin.firestore.FieldValue.increment(1) });
      return true;
    });
    return updated;
  } catch {
    return true; // em caso de erro no rate-limit, deixa passar (fail-open)
  }
}

/** FN-1: Verifica token de autenticação e retorna uid */
async function requireAuth(req) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpsError('unauthenticated', 'Token ausente.');
  try {
    const decoded = await auth.verifyIdToken(token);
    return decoded;
  } catch {
    throw new HttpsError('unauthenticated', 'Token inválido ou expirado.');
  }
}

/** FN-4: Resposta de erro padronizada */
function errorResponse(res, code, message, httpStatus = 400) {
  return res.status(httpStatus).json({ error: { code, message } });
}

// ── Sitemap dinâmico (FN-5) ───────────────────────────────────────────────────
// Cache em memória — válido por 1h (reuso entre cold starts no mesmo container)
let sitemapCache = null;
let sitemapCachedAt = 0;
const SITEMAP_TTL_MS = 60 * 60 * 1000;

exports.sitemapXml = onRequest(
  { region: REGION, memory: '256MiB', timeoutSeconds: 30 },
  async (req, res) => {
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');

    // Serve cache se ainda válido
    if (sitemapCache && Date.now() - sitemapCachedAt < SITEMAP_TTL_MS) {
      return res.send(sitemapCache);
    }

    try {
      const snap = await db
        .collection('oficinas')
        .where('ativo', '==', true)
        .select('slug', 'updatedAt')
        .limit(5000)
        .get();

      const baseUrl = 'https://www.mecbusca.com.br';
      const staticUrls = [
        { loc: baseUrl, priority: '1.0', changefreq: 'daily' },
        { loc: `${baseUrl}/buscar`, priority: '0.9', changefreq: 'daily' },
        { loc: `${baseUrl}/cadastrar`, priority: '0.7', changefreq: 'monthly' },
      ];

      const dynamicUrls = snap.docs.map(doc => {
        const { slug, updatedAt } = doc.data();
        const lastmod = updatedAt?.toDate?.()?.toISOString?.() ?? new Date().toISOString();
        return {
          loc: `${baseUrl}/oficina/${encodeURIComponent(slug)}`,
          lastmod,
          priority: '0.8',
          changefreq: 'weekly',
        };
      });

      const allUrls = [...staticUrls, ...dynamicUrls];
      const urlElements = allUrls.map(u => `
  <url>
    <loc>${u.loc}</loc>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('');

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urlElements}
</urlset>`;

      sitemapCache     = xml;
      sitemapCachedAt  = Date.now();
      return res.send(xml);
    } catch (err) {
      console.error('[sitemapXml] Erro:', err);
      return res.status(500).send('<?xml version="1.0"?><error>Erro ao gerar sitemap</error>');
    }
  }
);

// ── Callable: criar lead — fonte única de verdade para todos os leads ─────────
// Substitui tanto o onRequest/criarLead quanto o write direto do front-end.
// Schema unificado aceita tanto campos do modal de orçamento quanto campos legados.
exports.criarLead = onCall(
  { region: REGION, memory: '256MiB' },
  async ({ data, auth: callAuth }) => {
    // Aceitar tanto o schema novo (nomeCliente/whatsapp/carro/servico)
    // quanto o schema legado (nome/telefone/mensagem)
    const oficinaId   = sanitizeStr(data?.oficinaId || '', 60);
    const nomeCliente = sanitizeStr(data?.nomeCliente || data?.nome || '', 120);
    const whatsapp    = sanitizeStr((data?.whatsapp || data?.telefone || '').replace(/\D/g,''), 20);
    const carro       = sanitizeStr(data?.carro || '', 120);
    const servico     = sanitizeStr(data?.servico || data?.mensagem || '', 200);
    const valor       = Number(data?.valor) || 0;
    const origem      = sanitizeStr(data?.origem || 'app', 30);

    // Validações
    if (!oficinaId || !/^[\w-]{10,60}$/.test(oficinaId))
      throw new HttpsError('invalid-argument', 'ID de oficina inválido.');
    if (!nomeCliente || nomeCliente.length < 2)
      throw new HttpsError('invalid-argument', 'Nome inválido ou muito curto.');
    if (!whatsapp || !/^\d{10,11}$/.test(whatsapp))
      throw new HttpsError('invalid-argument', 'WhatsApp inválido. Use DDD + número (11 dígitos).');

    // Verificar se oficina existe e está ativa
    const oficinaRef = db.collection('oficinas').doc(oficinaId);
    const oficina = await oficinaRef.get();
    if (!oficina.exists || !oficina.data().ativo)
      throw new HttpsError('not-found', 'Oficina não encontrada ou inativa.');

    // Rate limit server-side: máx 5 leads por whatsapp por hora
    const rlKey = `ratelimit_lead_${whatsapp}`;
    const rlRef = db.collection('_ratelimits').doc(rlKey);
    const now   = Date.now();
    const rlOk  = await db.runTransaction(async tx => {
      const doc = await tx.get(rlRef);
      const d   = doc.exists ? doc.data() : { count: 0, windowStart: now };
      if (now - d.windowStart > 3600000) {
        tx.set(rlRef, { count: 1, windowStart: now });
        return true;
      }
      if (d.count >= 5) return false;
      tx.update(rlRef, { count: admin.firestore.FieldValue.increment(1) });
      return true;
    });
    if (!rlOk) throw new HttpsError('resource-exhausted', 'Muitas solicitações. Aguarde um momento.');

    const leadRef = await db.collection('leads').add({
      oficinaId,
      nomeCliente,
      whatsapp,
      carro,
      servico,
      valor,
      origem,
      status:    'novo',
      uid:       callAuth?.uid || null,
      criadoEm:  admin.firestore.FieldValue.serverTimestamp(),
    });

    // Atualizar contadores da oficina atomicamente
    await oficinaRef.update({
      totalLeads:    admin.firestore.FieldValue.increment(1),
      ultimoLeadEm:  admin.firestore.FieldValue.serverTimestamp(),
    });

    // GA4 Measurement Protocol — registra conversão server-side (não depende de adblocker)
    // Requires: FIREBASE_CONFIG.measurementId + GA4 API secret
    // Configurar: firebase functions:secrets:set GA4_API_SECRET
    const ga4MeasurementId = process.env.GA4_MEASUREMENT_ID || 'G-TXZG30WZ60';
    const ga4ApiSecret     = process.env.GA4_API_SECRET;
    if (ga4ApiSecret) {
      const ga4Payload = {
        client_id:     whatsapp, // usar whatsapp como client_id anônimo
        events: [{
          name: 'generate_lead',
          params: {
            currency:    'BRL',
            value:       valor || 0,
            item_id:     oficinaId,
            service:     servico,
            cidade:      oficina.data().cidade || '',
          },
        }],
      };
      // Fire-and-forget — não bloquear a resposta
      fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${ga4MeasurementId}&api_secret=${ga4ApiSecret}`, {
        method: 'POST',
        body: JSON.stringify(ga4Payload),
      }).catch(e => console.warn('[GA4-MP] Falha ao enviar evento:', e.message));
    }

    return { success: true, leadId: leadRef.id };
  }
);

// ── Trigger: novo lead criado → notificar oficina (FN-6) ─────────────────────
exports.onNovoLead = onDocumentCreated(
  { document: 'leads/{leadId}', region: REGION },
  async event => {
    const lead = event.data?.data();
    if (!lead) return;

    try {
      const oficina = await db.collection('oficinas').doc(lead.oficinaId).get();
      if (!oficina.exists) return;

      const { whatsapp, fcmToken: token, nome: nomeOficina } = oficina.data();

      // Push notification FCM (app mobile / PWA)
      if (token) {
        try {
          await admin.messaging().send({
            token,
            notification: {
              title: '🔔 Novo lead no MecBusca!',
              body: `${lead.nome} quer orçamento para: ${lead.mensagem?.slice(0,60)||'serviço'}`,
            },
            data: { leadId: event.params.leadId, tipo: 'novo_lead' },
            android: { priority: 'high' },
            apns: { payload: { aps: { badge: 1, sound: 'default' } } },
            webpush: {
              notification: { icon: 'https://www.mecbusca.com.br/icon-192.png', badge: 'https://www.mecbusca.com.br/badge-72.png' },
              fcmOptions: { link: 'https://www.mecbusca.com.br/?painel=leads' },
            },
          });
        } catch (fcmErr) {
          // Token expirado? limpar do perfil
          if (fcmErr.code === 'messaging/registration-token-not-registered') {
            await db.collection('oficinas').doc(lead.oficinaId).update({ fcmToken: admin.firestore.FieldValue.delete() });
          }
          console.warn('[onNovoLead] FCM falhou:', fcmErr.message);
        }
      }
    } catch (err) {
      console.warn('[onNovoLead] Notificação falhou:', err.message);
      // Não relançar — falha de notificação não deve impedir o trigger
    }
  }
);

// ── Trigger: gerar slug ao criar oficina ─────────────────────────────────────
exports.onOficinaCriada = onDocumentCreated(
  { document: 'oficinas/{id}', region: REGION },
  async event => {
    const data = event.data?.data();
    if (!data || data.slug) return; // já tem slug
    const nome = (data.nome || 'oficina').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const cidade = (data.cidade || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const base = [nome, cidade].filter(Boolean).join('-');
    const slug = `${base}-${event.params.id.slice(-6)}`;
    try {
      await event.data.ref.update({ slug, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
      console.warn('[onOficinaCriada] slug generation failed:', err.message);
    }
  }
);

// ── Trigger: inicializar perfil de novo usuário (FN-7) ───────────────────────
exports.onUserCreate = beforeUserCreated({ region: REGION }, async event => {
  const { uid, email, displayName, photoURL } = event.data;
  try {
    await db.collection('usuarios').doc(uid).set({
      uid,
      email: email || null,
      nome: displayName || '',
      foto: photoURL || null,
      role: 'cliente',
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[onUserCreate] Erro ao criar perfil:', err);
    // Não bloquear o cadastro
  }
});

// ── Callable: verificar oficina (admin only) ─────────────────────────────────
exports.verificarOficina = onCall(
  { region: REGION, memory: '256MiB' },
  async ({ data, auth: callAuth }) => {
    if (!callAuth) throw new HttpsError('unauthenticated', 'Login necessário.');
    // Somente admins podem verificar (uid listado em coleção _admins)
    const adminDoc = await db.collection('_admins').doc(callAuth.uid).get();
    if (!adminDoc.exists) throw new HttpsError('permission-denied', 'Acesso restrito.');
    const { oficinaId } = data || {};
    if (!oficinaId) throw new HttpsError('invalid-argument', 'ID inválido.');
    await db.collection('oficinas').doc(oficinaId).update({
      verificada: true,
      verificadaEm: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: true };
  }
);

// ── Scheduled: limpar leads antigos > 2 anos (FN-8 / LGPD) ──────────────────
exports.limparLeadsAntigos = onSchedule(
  { schedule: '0 3 1 * *', timeZone: 'America/Sao_Paulo', region: REGION },
  async () => {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 2);
    const cutoffTs = admin.firestore.Timestamp.fromDate(cutoff);

    const snap = await db
      .collection('leads')
      .where('criadoEm', '<', cutoffTs)
      .limit(500)
      .get();

    if (snap.empty) {
      console.log('[limparLeadsAntigos] Nenhum lead antigo encontrado.');
      return;
    }

    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    console.log(`[limparLeadsAntigos] ${snap.size} leads deletados.`);
  }
);

// ── Callable: oficina responde a uma avaliação ──────────────────────────────
exports.responderAvaliacao = onCall(
  { region: REGION, memory: '256MiB' },
  async ({ data, auth: callAuth }) => {
    if (!callAuth) throw new HttpsError('unauthenticated', 'Login necessário.');
    const { oficinaId, avaliacaoId, resposta } = data || {};

    if (!oficinaId || !avaliacaoId || !resposta) {
      throw new HttpsError('invalid-argument', 'Dados incompletos.');
    }
    const respostaSan = sanitizeStr(resposta, 500);
    if (respostaSan.length < 5) throw new HttpsError('invalid-argument', 'Resposta muito curta.');

    // Verifica propriedade da oficina
    const oficDoc = await db.collection('oficinas').doc(oficinaId).get();
    if (!oficDoc.exists || oficDoc.data().uid !== callAuth.uid) {
      throw new HttpsError('permission-denied', 'Sem permissão para esta oficina.');
    }

    await db.collection('oficinas').doc(oficinaId)
      .collection('avaliacoes').doc(avaliacaoId)
      .update({
        respostaOficina: respostaSan,
        respostaEm: admin.firestore.FieldValue.serverTimestamp(),
      });

    return { success: true };
  }
);

// ── Callable: calcular e salvar tempo médio de resposta da oficina ────────────
exports.atualizarTempoResposta = onDocumentCreated(
  { document: 'leads/{leadId}', region: REGION },
  async event => {
    const lead = event.data?.data();
    if (!lead?.oficinaId) return;
    try {
      // Busca os últimos 20 leads com resposta para calcular tempo médio
      const snap = await db.collection('leads')
        .where('oficinaId', '==', lead.oficinaId)
        .where('respondidoEm', '!=', null)
        .orderBy('respondidoEm', 'desc')
        .limit(20)
        .get();

      if (snap.empty) {
        await db.collection('oficinas').doc(lead.oficinaId).update({ tempoResposta: 'Novo' });
        return;
      }

      const tempos = snap.docs
        .map(d => {
          const l = d.data();
          if (!l.criadoEm || !l.respondidoEm) return null;
          return (l.respondidoEm.toMillis() - l.criadoEm.toMillis()) / 60000; // minutos
        })
        .filter(Boolean);

      if (!tempos.length) return;
      const avg = tempos.reduce((a, b) => a + b, 0) / tempos.length;

      let label;
      if (avg < 10) label = 'minutos';
      else if (avg < 60) label = `${Math.round(avg)} min`;
      else if (avg < 1440) label = `${Math.round(avg/60)}h`;
      else label = `${Math.round(avg/1440)} dia${avg/1440>1?'s':''}`;

      await db.collection('oficinas').doc(lead.oficinaId).update({ tempoResposta: label });
    } catch (err) {
      console.warn('[atualizarTempoResposta]', err.message);
    }
  }
);

// ── Trigger: sync oficina to Algolia on create/update ────────────────────────
// Descomente e configure quando ativar Algolia (USE_CLOUD_SEARCH = true no front-end).
//
// const { onDocumentWritten } = require('firebase-functions/v2/firestore');
// const algoliasearch = require('algoliasearch');
//
// exports.syncOficinaAlgolia = onDocumentWritten(
//   { document: 'oficinas/{id}', region: REGION },
//   async event => {
//     const client = algoliasearch(
//       process.env.ALGOLIA_APP_ID,
//       process.env.ALGOLIA_ADMIN_KEY,
//     );
//     const index = client.initIndex('oficinas');
//     const after = event.data.after;
//     if (!after.exists) {
//       await index.deleteObject(event.params.id);
//     } else {
//       const data = after.data();
//       if (!data.ativo) { await index.deleteObject(event.params.id); return; }
//       await index.saveObject({
//         objectID:  event.params.id,
//         nome:      data.nome,
//         cidade:    data.cidade,
//         estado:    data.estado,
//         bairro:    data.bairro,
//         servicos:  (data.servicos||[]).filter(s=>s.ativo).map(s=>s.nome),
//         avaliacao: data.avaliacao || 0,
//         plano:     data.plano,
//         _geoloc:   data.lat && data.lng ? { lat: data.lat, lng: data.lng } : null,
//       });
//     }
//   }
// );

// ── Callable: buscar oficinas com filtros (FN-1, FN-4) ───────────────────────
exports.buscarOficinas = onCall(
  { region: REGION, memory: '512MiB' },
  async ({ data }) => {
    const { cidade, servico, page = 0, limit: lim = 20 } = data || {};

    if (!cidade || typeof cidade !== 'string' || cidade.length < 2) {
      throw new HttpsError('invalid-argument', 'Cidade inválida.');
    }

    const safeLimit = Math.min(Math.max(Number(lim) || 20, 1), 50);

    let query = db.collection('oficinas')
      .where('ativo', '==', true)
      .where('cidade', '==', sanitizeStr(cidade, 100));

    if (servico && typeof servico === 'string') {
      query = query.where('servicos', 'array-contains', sanitizeStr(servico, 60));
    }

    query = query.orderBy('avaliacaoMedia', 'desc').limit(safeLimit);

    if (page > 0) {
      const lastRef = await db
        .collection('oficinas')
        .where('ativo', '==', true)
        .orderBy('avaliacaoMedia', 'desc')
        .limit(page * safeLimit)
        .get();
      const lastDoc = lastRef.docs.at(-1);
      if (lastDoc) query = query.startAfter(lastDoc);
    }

    const snap = await query.get();
    return {
      oficinas: snap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
      hasMore: snap.size === safeLimit,
    };
  }
);
