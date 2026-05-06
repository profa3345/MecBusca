/**
 * MecBusca — api/reivindicar-solicitar.js
 * Vercel Serverless Function — POST /api/reivindicar-solicitar
 *
 * Fluxo:
 *   1. Recebe { slug, telefone }
 *   2. Verifica se oficina existe no Firestore e está pendente
 *   3. Gera OTP de 6 dígitos e salva em _otps/{slug}
 *   4. Envia OTP via Z-API WhatsApp
 *
 * Variáveis de ambiente (Vercel Dashboard → Settings → Environment Variables):
 *   FIREBASE_PROJECT_ID      — ex: mecbusca
 *   FIREBASE_CLIENT_EMAIL    — service account email
 *   FIREBASE_PRIVATE_KEY     — service account private key (com \n reais)
 *   ZAPI_INSTANCE_ID         — ID da instância Z-API
 *   ZAPI_TOKEN               — Token Z-API
 */

'use strict';

const ALLOWED_ORIGINS = [
  'https://mecbusca.vercel.app',
  'https://mecbusca.com.br',
  'https://www.mecbusca.com.br',
  'http://localhost:3000',
  'http://localhost:5000',
];

const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutos

// ── Rate limit em memória (por instância Vercel) ──────────────────
const rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now    = Date.now();
  const window = 60_000;
  const max    = 5; // máx 5 tentativas por minuto por IP
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
let _db = null;
function getDb() {
  if (_db) return _db;

  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Vercel armazena \n como literal — converter de volta
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  _db = admin.firestore();
  return _db;
}

// ── Gerar OTP ─────────────────────────────────────────────────────
function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Enviar WhatsApp via Z-API ─────────────────────────────────────
async function sendZAPI(phone, message) {
  const instanceId = process.env.ZAPI_INSTANCE_ID;
  const token      = process.env.ZAPI_TOKEN;

  if (!instanceId || !token) {
    throw new Error('ZAPI_INSTANCE_ID ou ZAPI_TOKEN não configurados.');
  }

  // Garante formato com DDI 55
  const number = phone.replace(/\D/g, '');
  const intl   = number.startsWith('55') ? number : `55${number}`;

  const res = await fetch(
    `https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`,
    {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': token,
      },
      body: JSON.stringify({ phone: intl, message }),
    }
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Z-API ${res.status}: ${txt}`);
  }
  return res.json();
}

// ── Handler principal ─────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
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

  const { slug, telefone } = body;

  if (!slug || typeof slug !== 'string') {
    return res.status(400).json({ error: 'Slug inválido.' });
  }
  const tel = (telefone || '').replace(/\D/g, '');
  if (tel.length < 10 || tel.length > 11) {
    return res.status(400).json({ error: 'Telefone inválido. Informe DDD + número.' });
  }

  const db = getDb();

  // Buscar oficina
  let oficina;
  try {
    const snap = await db.collection('oficinas').doc(slug).get();
    if (!snap.exists) return res.status(404).json({ error: 'Oficina não encontrada.' });
    oficina = snap.data();
  } catch (e) {
    console.error('[reivindicar-solicitar] Firestore erro:', e.message);
    return res.status(503).json({ error: 'Erro ao buscar oficina. Tente novamente.' });
  }

  if (oficina.reivindicado) {
    return res.status(409).json({
      error: 'Este perfil já foi reivindicado. Faça login para acessar o painel.',
    });
  }
  if (oficina.status !== 'pendente_confirmacao') {
    return res.status(409).json({
      error: 'Este perfil não está disponível para reivindicação.',
    });
  }

  // Valida telefone (últimos 8 dígitos devem coincidir)
  const telCadastrado = (oficina.telefone || oficina.whatsapp || '').replace(/\D/g, '');
  if (telCadastrado && tel.slice(-8) !== telCadastrado.slice(-8)) {
    return res.status(403).json({
      error: 'Telefone não coincide com o cadastrado. Use o número da oficina.',
    });
  }

  // Gerar OTP e salvar no Firestore
  const otp    = generateOTP();
  const expiry = new Date(Date.now() + OTP_EXPIRY_MS).toISOString();

  try {
    await db.collection('_otps').doc(`otp_${slug}`).set({
      otp,
      slug,
      telefone: tel,
      expiry,
      tentativas: 0,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[reivindicar-solicitar] Erro ao salvar OTP:', e.message);
    return res.status(503).json({ error: 'Erro interno. Tente novamente.' });
  }

  // Enviar WhatsApp
  const mensagem =
    `🔐 *MecBusca — Verificação*\n\n` +
    `Seu código de verificação é:\n\n*${otp}*\n\n` +
    `Válido por 10 minutos.\n\n` +
    `Não compartilhe este código com ninguém.`;

  try {
    await sendZAPI(tel, mensagem);
  } catch (e) {
    console.error('[reivindicar-solicitar] Z-API falhou:', e.message);
    // Em desenvolvimento, retorna OTP no log para facilitar testes
    if (process.env.NODE_ENV !== 'production') {
      console.log('[DEV] OTP gerado:', otp);
    }
    return res.status(502).json({
      error: 'Erro ao enviar WhatsApp. Verifique o número e tente novamente.',
    });
  }

  console.log(`[reivindicar-solicitar] OTP enviado: slug=${slug} tel=***${tel.slice(-4)}`);
  return res.status(200).json({
    ok: true,
    message: `Código enviado para o WhatsApp terminado em ${tel.slice(-4)}`,
  });
};
