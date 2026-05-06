/**
 * MecBusca — api/reivindicar-confirmar.js
 * Vercel Serverless Function — POST /api/reivindicar-confirmar
 *
 * Fluxo:
 *   1. Recebe { slug, otp, email, senha }
 *   2. Valida OTP salvo em _otps/{slug}
 *   3. Cria usuário no Firebase Auth
 *   4. Ativa perfil da oficina no Firestore (status → ativo)
 *   5. Envia WhatsApp de boas-vindas
 *
 * Variáveis de ambiente (Vercel Dashboard → Settings → Environment Variables):
 *   FIREBASE_PROJECT_ID      — ex: mecbusca
 *   FIREBASE_CLIENT_EMAIL    — service account email
 *   FIREBASE_PRIVATE_KEY     — service account private key
 *   ZAPI_INSTANCE_ID         — ID da instância Z-API
 *   ZAPI_TOKEN               — Token Z-API
 *   MECBUSCA_URL             — ex: https://mecbusca.com.br (opcional)
 */

'use strict';

const ALLOWED_ORIGINS = [
  'https://mecbusca.vercel.app',
  'https://mecbusca.com.br',
  'https://www.mecbusca.com.br',
  'http://localhost:3000',
  'http://localhost:5000',
];

const BASE_URL    = process.env.MECBUSCA_URL || 'https://mecbusca.com.br';
const OTP_LENGTH  = 6;

// ── Rate limit em memória ─────────────────────────────────────────
const rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now    = Date.now();
  const window = 60_000;
  const max    = 10;
  const entry  = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > window) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  rateLimitMap.set(ip, entry);
  return true;
}

// ── Firebase Admin (inicialização lazy) ──────────────────────────
let _db   = null;
let _auth = null;

function initFirebase() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin;
}

function getDb() {
  if (_db) return _db;
  const admin = initFirebase();
  _db = admin.firestore();
  return _db;
}

function getAuth() {
  if (_auth) return _auth;
  const admin = initFirebase();
  _auth = admin.auth();
  return _auth;
}

// ── Z-API WhatsApp ────────────────────────────────────────────────
async function sendZAPI(phone, message) {
  const instanceId = process.env.ZAPI_INSTANCE_ID;
  const token      = process.env.ZAPI_TOKEN;
  if (!instanceId || !token) return; // silencia se não configurado

  const number = phone.replace(/\D/g, '');
  const intl   = number.startsWith('55') ? number : `55${number}`;

  await fetch(
    `https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': token },
      body:    JSON.stringify({ phone: intl, message }),
    }
  ).catch(e => console.warn('[reivindicar-confirmar] Z-API boas-vindas falhou:', e.message));
}

// ── Handler principal ─────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método não permitido' });

  // Rate limit
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde um momento.' });
  }

  // Parse body
  const body = typeof req.body === 'object' ? req.body : (() => {
    try { return JSON.parse(req.body); } catch { return {}; }
  })();

  const { slug, otp, email, senha } = body;

  // Validações básicas
  if (!slug || typeof slug !== 'string') {
    return res.status(400).json({ error: 'Slug inválido.' });
  }
  if (!otp || otp.length !== OTP_LENGTH || !/^\d+$/.test(otp)) {
    return res.status(400).json({ error: 'Código inválido. Digite os 6 dígitos.' });
  }
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }
  if (!senha || senha.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });
  }

  const db   = getDb();
  const auth = getAuth();

  // Buscar OTP salvo
  const otpRef  = db.collection('_otps').doc(`otp_${slug}`);
  let otpData;
  try {
    const otpSnap = await otpRef.get();
    if (!otpSnap.exists) {
      return res.status(404).json({
        error: 'Código expirado ou não solicitado. Solicite um novo.',
      });
    }
    otpData = otpSnap.data();
  } catch (e) {
    console.error('[reivindicar-confirmar] Erro ao buscar OTP:', e.message);
    return res.status(503).json({ error: 'Erro interno. Tente novamente.' });
  }

  // Verificar expiração
  if (new Date() > new Date(otpData.expiry)) {
    await otpRef.delete().catch(() => {});
    return res.status(410).json({ error: 'Código expirado. Solicite um novo.' });
  }

  // Verificar tentativas
  if ((otpData.tentativas || 0) >= 5) {
    return res.status(429).json({
      error: 'Muitas tentativas incorretas. Solicite um novo código.',
    });
  }

  // Verificar OTP
  if (otpData.otp !== otp) {
    await otpRef.update({
      tentativas: (otpData.tentativas || 0) + 1,
    }).catch(() => {});
    const restantes = 5 - (otpData.tentativas + 1);
    return res.status(403).json({
      error: `Código incorreto. ${restantes} tentativa(s) restante(s).`,
    });
  }

  // OTP válido — buscar oficina
  let oficina;
  try {
    const snap = await db.collection('oficinas').doc(slug).get();
    if (!snap.exists) return res.status(404).json({ error: 'Oficina não encontrada.' });
    oficina = snap.data();
  } catch (e) {
    console.error('[reivindicar-confirmar] Erro ao buscar oficina:', e.message);
    return res.status(503).json({ error: 'Erro interno. Tente novamente.' });
  }

  if (oficina.reivindicado) {
    return res.status(409).json({ error: 'Este perfil já foi reivindicado.' });
  }

  // Criar usuário no Firebase Auth
  let uid;
  try {
    const telFormatado = otpData.telefone;
    const intlPhone = telFormatado.startsWith('55')
      ? `+${telFormatado}`
      : `+55${telFormatado}`;

    const userRecord = await auth.createUser({
      email,
      password: senha,
      displayName: oficina.nome,
      // phoneNumber só se for celular válido (11 dígitos)
      ...(telFormatado.length === 11 ? { phoneNumber: intlPhone } : {}),
    });
    uid = userRecord.uid;

    // Custom claims: role de oficina
    await auth.setCustomUserClaims(uid, { role: 'oficina', slug });

  } catch (e) {
    if (e.code === 'auth/email-already-exists') {
      return res.status(409).json({
        error: 'E-mail já cadastrado. Faça login com este e-mail para acessar o painel.',
      });
    }
    if (e.code === 'auth/phone-number-already-exists') {
      // Ignora erro de telefone duplicado — cria sem phone
      try {
        const userRecord = await auth.createUser({ email, password: senha, displayName: oficina.nome });
        uid = userRecord.uid;
        await auth.setCustomUserClaims(uid, { role: 'oficina', slug });
      } catch (e2) {
        console.error('[reivindicar-confirmar] Erro ao criar user (fallback):', e2.message);
        return res.status(500).json({ error: 'Erro ao criar conta. Tente novamente.' });
      }
    } else {
      console.error('[reivindicar-confirmar] Erro ao criar user:', e.message);
      return res.status(500).json({ error: 'Erro ao criar conta. Tente novamente.' });
    }
  }

  // Ativar perfil no Firestore (batch)
  try {
    const batch = db.batch();
    const now   = new Date().toISOString();

    // Atualizar oficina
    batch.update(db.collection('oficinas').doc(slug), {
      uid,
      email,
      status:       'ativo',
      ativo:        true,
      reivindicado: true,
      confirmadoAt: now,
      updatedAt:    now,
    });

    // Criar perfil do usuário
    batch.set(db.collection('usuarios').doc(uid), {
      uid,
      email,
      role:     'oficina',
      slug,
      nome:     oficina.nome,
      cidade:   oficina.cidade,
      criadoEm: now,
    });

    // Deletar OTP usado
    batch.delete(otpRef);

    await batch.commit();
  } catch (e) {
    console.error('[reivindicar-confirmar] Erro ao ativar perfil:', e.message);
    // Reverter criação do usuário Auth para não deixar orphan
    await auth.deleteUser(uid).catch(() => {});
    return res.status(503).json({ error: 'Erro ao ativar perfil. Tente novamente.' });
  }

  // WhatsApp de boas-vindas (não bloqueia resposta)
  const msgBemVindo =
    `🎉 *Bem-vinda ao MecBusca, ${oficina.nome}!*\n\n` +
    `Seu perfil foi ativado com sucesso.\n\n` +
    `Acesse seu painel:\n${BASE_URL}/painel\n\n` +
    `Dúvidas? Fale com a equipe pelo site. 🚗🔧`;

  sendZAPI(otpData.telefone, msgBemVindo); // fire-and-forget

  console.log(`[reivindicar-confirmar] ✅ Perfil ativado: slug=${slug} uid=${uid}`);
  return res.status(200).json({
    ok:      true,
    uid,
    message: 'Perfil ativado! Faça login para acessar o painel.',
  });
};
