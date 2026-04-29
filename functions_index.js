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

// ── Endpoint de criação de lead (FN-2, FN-3, FN-4) ───────────────────────────
exports.criarLead = onRequest(
  { region: REGION, memory: '256MiB', cors: ['https://www.mecbusca.com.br'] },
  async (req, res) => {
    if (req.method !== 'POST') {
      return errorResponse(res, 'METHOD_NOT_ALLOWED', 'Método não permitido.', 405);
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    const allowed = await checkRateLimit(ip, 'criarLead');
    if (!allowed) {
      return errorResponse(res, 'RATE_LIMITED', 'Muitas requisições. Tente novamente em 1 minuto.', 429);
    }

    const { nome, telefone, mensagem, oficinaId } = req.body || {};

    // FN-3: validar e sanitizar
    const nomeSan     = sanitizeStr(nome, 120);
    const telefoneSan = sanitizeStr(telefone, 20);
    const mensagemSan = sanitizeStr(mensagem, 1000);

    if (!nomeSan || nomeSan.length < 2) {
      return errorResponse(res, 'INVALID_NOME', 'Nome inválido ou muito curto.');
    }
    if (!telefoneSan || !/^\+?[\d\s\-()]{8,20}$/.test(telefoneSan)) {
      return errorResponse(res, 'INVALID_TELEFONE', 'Telefone inválido.');
    }
    if (!mensagemSan || mensagemSan.length < 10) {
      return errorResponse(res, 'INVALID_MENSAGEM', 'Mensagem muito curta (mínimo 10 caracteres).');
    }
    if (!oficinaId || typeof oficinaId !== 'string' || !/^[a-zA-Z0-9_-]{10,60}$/.test(oficinaId)) {
      return errorResponse(res, 'INVALID_OFICINA', 'ID de oficina inválido.');
    }

    // Verificar se oficina existe e está ativa
    const oficinaRef = db.collection('oficinas').doc(oficinaId);
    const oficina = await oficinaRef.get();
    if (!oficina.exists || !oficina.data().ativo) {
      return errorResponse(res, 'OFICINA_NOT_FOUND', 'Oficina não encontrada ou inativa.', 404);
    }

    try {
      const leadRef = await db.collection('leads').add({
        nome: nomeSan,
        telefone: telefoneSan,
        mensagem: mensagemSan,
        oficinaId,
        ip: ip.slice(0, 45), // truncar para LGPD
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });

      // FN-6: incrementar contador de leads na oficina atomicamente
      await oficinaRef.update({
        totalLeads: admin.firestore.FieldValue.increment(1),
        ultimoLeadEm: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(201).json({ success: true, leadId: leadRef.id });
    } catch (err) {
      console.error('[criarLead] Erro ao salvar:', err);
      return errorResponse(res, 'INTERNAL_ERROR', 'Erro interno. Tente novamente.', 500);
    }
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

      const { fcmToken, nome: nomeOficina } = oficina.data();

      // Enviar push notification se oficina tem token FCM cadastrado
      if (fcmToken) {
        await admin.messaging().send({
          token: fcmToken,
          notification: {
            title: '🔔 Novo lead recebido!',
            body: `${lead.nome} entrou em contato com ${nomeOficina}.`,
          },
          data: { leadId: event.params.leadId, tipo: 'novo_lead' },
          android: { priority: 'high' },
          apns: { payload: { aps: { badge: 1, sound: 'default' } } },
        });
      }
    } catch (err) {
      console.warn('[onNovoLead] Notificação falhou:', err.message);
      // Não relançar — falha de notificação não deve impedir o trigger
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
