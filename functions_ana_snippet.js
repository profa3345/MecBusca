// ═══════════════════════════════════════════════════════════════
//  ADICIONAR no functions/index.js — Ana IA endpoint
//
//  1. Copie o arquivo functions_ana.js para functions/ana.js
//
//  2. No topo do functions/index.js, adicione:
//     const { anaIA } = require('./ana');
//
//  3. No bloco de exports, adicione:
//     exports.anaIA = anaIA;
//
//  4. Deploy:
//     firebase deploy --only functions,hosting
//
//  OU se preferir tudo em um arquivo só, cole o conteúdo abaixo
//  diretamente no functions/index.js:
// ═══════════════════════════════════════════════════════════════

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const ANA_CONFIG = {
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  temperature: 0.85,
  system: `Você é Ana, uma inteligência artificial criada pelo MecBusca.
Você é um oráculo: responde sobre qualquer assunto com sabedoria, clareza e personalidade.

Personalidade:
- Direta e objetiva, mas calorosa
- Usa linguagem natural em português brasileiro
- Quando relevante, menciona que pode ajudar a encontrar oficinas mecânicas pelo MecBusca
- Não finge não saber algo — se não tiver certeza, diz claramente
- Respostas curtas para perguntas simples, detalhadas para perguntas complexas
- Nunca começa com "Claro!" ou "Certamente!" — vai direto ao ponto

Contexto MecBusca:
- Marketplace de oficinas mecânicas no Brasil
- Usuários buscam oficinas, pedem orçamentos e falam pelo WhatsApp
- Se a pergunta for sobre carros, mecânica ou manutenção, ofereça ajudar a encontrar uma oficina`,
};

async function checkRateLimit(db, ip) {
  const windowMs = 60 * 1000;
  const maxRequests = 20;
  const docId = `ana_${ip.replace(/[.:]/g, '_')}`;
  const ref = db.collection('_ratelimits').doc(docId);

  return db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    const now = Timestamp.now();
    const nowMs = now.toMillis();

    if (!doc.exists) {
      tx.set(ref, {
        count: 1,
        windowStart: now,
        ttl: new Timestamp(Math.floor(nowMs / 1000) + 600, 0),
      });
      return true;
    }

    const data = doc.data();
    const windowStartMs = data.windowStart?.toMillis?.() ?? nowMs;

    if (nowMs - windowStartMs > windowMs) {
      tx.update(ref, { count: 1, windowStart: now, ttl: new Timestamp(Math.floor(nowMs / 1000) + 600, 0) });
      return true;
    }

    if (data.count >= maxRequests) return false;
    tx.update(ref, { count: FieldValue.increment(1) });
    return true;
  });
}

exports.anaIA = onRequest(
  {
    secrets: [ANTHROPIC_API_KEY],
    timeoutSeconds: 60,
    memory: '256MiB',
    region: 'us-central1',
    cors: false,
  },
  async (req, res) => {
    const db = getFirestore();

    const allowedOrigins = [
      'https://mecbusca.com.br',
      'https://www.mecbusca.com.br',
      'https://mecbusca.firebaseapp.com',
      'http://localhost:5000',
      'http://localhost:5001',
    ];
    const origin = req.headers.origin || '';
    res.set('Access-Control-Allow-Origin', allowedOrigins.includes(origin) ? origin : allowedOrigins[0]);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-App-Version');
    res.set('Access-Control-Max-Age', '3600');

    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    try {
      const allowed = await checkRateLimit(db, ip);
      if (!allowed) return res.status(429).json({ error: 'Muitas mensagens. Aguarde um momento.' });
    } catch (e) {
      console.warn('[Ana] Rate limit falhou:', e.message);
    }

    const { message, history = [] } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'Mensagem inválida.' });
    if (message.length > 4000) return res.status(400).json({ error: 'Mensagem muito longa.' });

    const messages = [
      ...Array.isArray(history)
        ? history.slice(-10).filter(m => m?.role && typeof m.content === 'string')
            .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }))
        : [],
      { role: 'user', content: message.trim() },
    ];

    const apiKey = ANTHROPIC_API_KEY.value();
    if (!apiKey) return res.status(503).json({ error: 'Ana indisponível. Tente mais tarde.' });

    let anthropicRes;
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANA_CONFIG.model,
          max_tokens: ANA_CONFIG.max_tokens,
          temperature: ANA_CONFIG.temperature,
          system: ANA_CONFIG.system,
          messages,
        }),
      });
    } catch (e) {
      return res.status(502).json({ error: 'Erro de conexão. Tente novamente.' });
    }

    if (!anthropicRes.ok) {
      const status = anthropicRes.status;
      const msg = status === 529 ? 'Ana sobrecarregada. Tente em instantes.'
                : status === 401 ? 'Erro de autenticação. Contate o suporte.'
                : 'Ana encontrou um problema. Tente novamente.';
      return res.status(502).json({ error: msg });
    }

    const data = await anthropicRes.json();
    const reply = data?.content?.[0]?.text;
    if (!reply) return res.status(502).json({ error: 'Resposta vazia. Tente reformular.' });

    console.log('[Ana] ok', { in: data.usage?.input_tokens, out: data.usage?.output_tokens });
    return res.status(200).json({ reply });
  }
);
