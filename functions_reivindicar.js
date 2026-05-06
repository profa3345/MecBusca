/**
 * MecBusca — functions/reivindicar.js
 *
 * Cloud Function: reivindicaOficina
 *
 * Fluxo de reivindicação de perfil "pendente_confirmacao":
 *   1. Oficina acessa /reivindicar/:slug
 *   2. Informa telefone (deve coincidir com o cadastrado)
 *   3. Recebe OTP via WhatsApp (Z-API)
 *   4. Confirma OTP → uid vinculado, status → "ativo"
 *
 * Endpoints:
 *   POST /api/reivindicar/solicitar  — envia OTP WhatsApp
 *   POST /api/reivindicar/confirmar  — valida OTP e ativa perfil
 */

'use strict';

const { onRequest }  = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth }    = require('firebase-admin/auth');

const ZAPI_INSTANCE_ID = defineSecret('ZAPI_INSTANCE_ID');
const ZAPI_TOKEN       = defineSecret('ZAPI_TOKEN');

const REGION  = 'southamerica-east1';
const BASE_URL = 'https://mecbusca.com.br';

const ALLOWED_ORIGINS = [
  'https://mecbusca.com.br',
  'https://www.mecbusca.com.br',
  'https://mecbusca.firebaseapp.com',
  'http://localhost:5000',
];

// OTP: 6 dígitos, expira em 10 minutos
const OTP_EXPIRY_MS = 10 * 60 * 1000;
const OTP_LENGTH    = 6;

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function setCors(req, res) {
  const origin = req.headers.origin || '';
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function sendZAPI(instanceId, token, phone, message) {
  const number = phone.startsWith('55') ? phone : `55${phone}`;
  const body = JSON.stringify({ phone: number, message });

  const { default: fetch } = await import('node-fetch');
  const res = await fetch(
    `https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': token },
      body,
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Z-API ${res.status}: ${txt}`);
  }
  return res.json();
}

// ── Solicitar OTP ─────────────────────────────────────────────────────────────
exports.reivindicarSolicitar = onRequest(
  {
    secrets: [ZAPI_INSTANCE_ID, ZAPI_TOKEN],
    region: REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: false,
  },
  async (req, res) => {
    const db = getFirestore();
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

    const { slug, telefone } = req.body || {};
    if (!slug || !telefone) return res.status(400).json({ error: 'Campos obrigatórios: slug, telefone' });

    const tel = telefone.replace(/\D/g, '');
    if (tel.length < 10 || tel.length > 11) {
      return res.status(400).json({ error: 'Telefone inválido. Informe DDD + número.' });
    }

    // Buscar oficina pelo slug
    const snap = await db.collection('oficinas').doc(slug).get();
    if (!snap.exists) return res.status(404).json({ error: 'Oficina não encontrada.' });

    const oficina = snap.data();
    if (oficina.reivindicado) {
      return res.status(409).json({ error: 'Este perfil já foi reivindicado. Faça login para acessar o painel.' });
    }
    if (oficina.status !== 'pendente_confirmacao') {
      return res.status(409).json({ error: 'Este perfil não está disponível para reivindicação.' });
    }

    // Valida se o telefone bate com o cadastrado (últimos 8 dígitos)
    const telCadastrado = (oficina.telefone || oficina.whatsapp || '').replace(/\D/g, '');
    if (telCadastrado && tel.slice(-8) !== telCadastrado.slice(-8)) {
      return res.status(403).json({
        error: 'Telefone não coincide com o cadastrado. Use o número da oficina.',
      });
    }

    // Gerar e salvar OTP
    const otp     = generateOTP();
    const expiry  = new Date(Date.now() + OTP_EXPIRY_MS);
    const otpDocId = `otp_${slug}`;

    await db.collection('_otps').doc(otpDocId).set({
      otp,
      slug,
      telefone: tel,
      expiry: expiry.toISOString(),
      tentativas: 0,
      createdAt: new Date().toISOString(),
    });

    // Enviar via WhatsApp
    const whatsappTel = tel.length === 11 && tel.startsWith('9', 2) ? tel : oficina.telefone?.replace(/\D/g, '');
    const mensagem = `🔐 *MecBusca — Verificação*\n\nSeu código de verificação é:\n\n*${otp}*\n\nVálido por 10 minutos.\n\nNão compartilhe este código com ninguém.`;

    try {
      await sendZAPI(ZAPI_INSTANCE_ID.value(), ZAPI_TOKEN.value(), whatsappTel || tel, mensagem);
    } catch (e) {
      console.error('[reivindicar] Z-API falhou:', e.message);
      // Fallback: retorna OTP em dev/staging (NUNCA em prod real)
      if (process.env.FUNCTIONS_EMULATOR) {
        return res.status(200).json({ reply: 'OTP enviado (emulador)', otp_debug: otp });
      }
      return res.status(502).json({ error: 'Erro ao enviar WhatsApp. Tente novamente.' });
    }

    console.log(`[reivindicar] OTP enviado para ${slug} → ${tel.slice(-4).padStart(tel.length, '*')}`);
    return res.status(200).json({
      ok: true,
      message: `Código enviado para WhatsApp terminado em ${tel.slice(-4)}`,
    });
  }
);

// ── Confirmar OTP e ativar perfil ─────────────────────────────────────────────
exports.reivindicarConfirmar = onRequest(
  {
    secrets: [ZAPI_INSTANCE_ID, ZAPI_TOKEN],
    region: REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: false,
  },
  async (req, res) => {
    const db   = getFirestore();
    const auth = getAuth();
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

    const { slug, otp, email, senha } = req.body || {};
    if (!slug || !otp || !email || !senha) {
      return res.status(400).json({ error: 'Campos obrigatórios: slug, otp, email, senha' });
    }
    if (otp.length !== OTP_LENGTH || !/^\d+$/.test(otp)) {
      return res.status(400).json({ error: 'Código inválido.' });
    }
    if (senha.length < 6) {
      return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });
    }

    const otpDocId  = `otp_${slug}`;
    const otpRef    = db.collection('_otps').doc(otpDocId);
    const otpSnap   = await otpRef.get();

    if (!otpSnap.exists) {
      return res.status(404).json({ error: 'Código expirado ou não solicitado. Solicite um novo.' });
    }

    const otpData = otpSnap.data();

    // Bloquear após 5 tentativas erradas
    if ((otpData.tentativas || 0) >= 5) {
      return res.status(429).json({ error: 'Muitas tentativas. Solicite um novo código.' });
    }

    // Verificar expiração
    if (new Date() > new Date(otpData.expiry)) {
      await otpRef.delete();
      return res.status(410).json({ error: 'Código expirado. Solicite um novo.' });
    }

    // Verificar OTP
    if (otpData.otp !== otp) {
      await otpRef.update({ tentativas: FieldValue.increment(1) });
      const restantes = 5 - (otpData.tentativas + 1);
      return res.status(403).json({
        error: `Código incorreto. ${restantes} tentativa(s) restante(s).`,
      });
    }

    // OTP válido — criar usuário Firebase Auth
    const officinaSnap = await db.collection('oficinas').doc(slug).get();
    if (!officinaSnap.exists) return res.status(404).json({ error: 'Oficina não encontrada.' });

    const oficina = officinaSnap.data();
    if (oficina.reivindicado) {
      return res.status(409).json({ error: 'Este perfil já foi reivindicado.' });
    }

    let uid;
    try {
      const userRecord = await auth.createUser({
        email,
        password: senha,
        displayName: oficina.nome,
        phoneNumber: otpData.telefone.length === 11 ? `+55${otpData.telefone}` : null,
      });
      uid = userRecord.uid;

      // Definir custom claims de oficina
      await auth.setCustomUserClaims(uid, {
        role: 'oficina',
        slug,
      });
    } catch (e) {
      if (e.code === 'auth/email-already-exists') {
        return res.status(409).json({ error: 'E-mail já cadastrado. Faça login com este e-mail.' });
      }
      console.error('[reivindicar] Erro ao criar usuário:', e.message);
      return res.status(500).json({ error: 'Erro ao criar conta. Tente novamente.' });
    }

    // Atualizar oficina no Firestore — ativar perfil
    const batch = db.batch();
    const oficinaRef = db.collection('oficinas').doc(slug);

    batch.update(oficinaRef, {
      uid,
      status:        'ativo',
      ativo:         true,
      reivindicado:  true,
      confirmadoAt:  new Date().toISOString(),
      updatedAt:     new Date().toISOString(),
      email,
    });

    // Criar documento de perfil do usuário
    const userRef = db.collection('usuarios').doc(uid);
    batch.set(userRef, {
      uid,
      email,
      role:      'oficina',
      slug,
      nome:      oficina.nome,
      cidade:    oficina.cidade,
      criadoEm: new Date().toISOString(),
    });

    // Deletar OTP usado
    batch.delete(otpRef);

    await batch.commit();

    // Notifica oficina por WhatsApp
    const msgBemVindo = `🎉 *Bem-vinda ao MecBusca, ${oficina.nome}!*\n\nSeu perfil foi ativado com sucesso.\n\nAcesse seu painel em:\n${BASE_URL}/painel\n\nDúvidas? Fale com a equipe pelo site. 🚗🔧`;
    sendZAPI(ZAPI_INSTANCE_ID.value(), ZAPI_TOKEN.value(), otpData.telefone, msgBemVindo)
      .catch(e => console.warn('[reivindicar] Msg boas-vindas falhou:', e.message));

    console.log(`[reivindicar] ✅ Perfil ativado: ${slug} → uid=${uid}`);
    return res.status(200).json({
      ok: true,
      uid,
      message: 'Perfil ativado com sucesso! Faça login para acessar o painel.',
    });
  }
);
