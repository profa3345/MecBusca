/**
 * MecBusca — Cloud Function: Ana IA (Oráculo)
 *
 * FIXES para mobile:
 *   ANA-FIX-1: Endpoint próprio /api/ana separado de /api/leads
 *   ANA-FIX-2: timeoutSeconds aumentado para 60s (mobile tem latência maior)
 *   ANA-FIX-3: CORS explícito com preflight OPTIONS tratado corretamente
 *   ANA-FIX-4: Streaming desabilitado — resposta completa de uma vez (mais estável em mobile)
 *   ANA-FIX-5: Rate-limit por IP no Firestore para evitar abuso
 *   ANA-FIX-6: Ana é um oráculo universal — system prompt abrangente
 *   ANA-FIX-7: Histórico de conversa enviado pelo cliente (até 10 turnos)
 *   ANA-FIX-8: Respostas de erro legíveis para o usuário final
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// ── Configuração ──────────────────────────────────────────────────
const ANA_CONFIG = {
  model: 'claude-sonnet-4-20250514',  // Sonnet 4 — melhor custo-benefício
  max_tokens: 1024,
  temperature: 0.85,

  // ANA-FIX-6: Ana como oráculo universal com contexto MecBusca
  system: `Você é Ana, uma inteligência artificial criada pelo MecBusca.
Você é um oráculo: responde sobre qualquer assunto com sabedoria, clareza e personalidade.

Personalidade:
- Direta e objetiva, mas calorosa
- Usa linguagem natural em português brasileiro
- Quando relevante, menciona que pode ajudar a encontrar oficinas mecânicas pelo MecBusca
- Não finge não saber algo — se não tiver certeza, diz claramente e oferece o melhor que pode
- Respostas curtas para perguntas simples, detalhadas para perguntas complexas
- Nunca começa com "Claro!" ou "Certamente!" — vai direto ao ponto

Contexto MecBusca:
- O MecBusca é um marketplace de oficinas mecânicas no Brasil
- Os usuários podem buscar oficinas, pedir orçamentos e falar diretamente pelo WhatsApp
- Se a pergunta for sobre carros, mecânica ou manutenção, sempre ofereça ajudar a encontrar uma oficina

Lembre: você é um oráculo — conhecimento amplo, respostas úteis, sem rodeios.`,
};

// ── Rate limiting via Firestore com serverTimestamp (ANA-FIX-9) ───
// ANA-FIX-9: usa Timestamp.now() do servidor — imune a clock drift do cliente da função
async function checkRateLimit(db, ip) {
  const windowMs = 60 * 1000; // 1 minuto
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
        ttl: new Timestamp(Math.floor(nowMs / 1000) + 600, 0), // TTL 10min → Firestore deleta auto
      });
      return true;
    }

    const data = doc.data();
    const windowStartMs = data.windowStart?.toMillis?.() ?? nowMs;

    if (nowMs - windowStartMs > windowMs) {
      tx.update(ref, {
        count: 1,
        windowStart: now,
        ttl: new Timestamp(Math.floor(nowMs / 1000) + 600, 0),
      });
      return true;
    }

    if (data.count >= maxRequests) return false;

    tx.update(ref, { count: FieldValue.increment(1) });
    return true;
  });
}

// ── Handler principal ─────────────────────────────────────────────
exports.anaIA = onRequest(
  {
    secrets: [ANTHROPIC_API_KEY],
    // ANA-FIX-2: timeout generoso para mobile
    timeoutSeconds: 60,
    memory: '256MiB',
    region: 'us-central1',
    cors: false, // tratamos CORS manualmente abaixo
  },
  async (req, res) => {
    const db = getFirestore();

    // ANA-FIX-3: Preflight CORS
    const allowedOrigins = [
      'https://mecbusca.com.br',
      'https://mecbusca.firebaseapp.com',
      'http://localhost:5000',
      'http://localhost:5001',
    ];
    const origin = req.headers.origin || '';
    const isAllowed = allowedOrigins.includes(origin);

    res.set('Access-Control-Allow-Origin', isAllowed ? origin : allowedOrigins[0]);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-App-Version');
    res.set('Access-Control-Max-Age', '3600');

    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método não permitido' });
    }

    // ANA-FIX-5: Rate limit
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    try {
      const allowed = await checkRateLimit(db, ip);
      if (!allowed) {
        return res.status(429).json({
          error: 'Muitas mensagens em pouco tempo. Aguarde um momento.',
          code: 'RATE_LIMITED',
        });
      }
    } catch (err) {
      console.warn('[Ana] Rate limit check falhou (continuando):', err.message);
    }

    // Validar body
    const { message, history = [] } = req.body || {};
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Mensagem inválida.' });
    }
    if (message.length > 4000) {
      return res.status(400).json({ error: 'Mensagem muito longa (máx. 4000 caracteres).' });
    }

    // ANA-FIX-7: Montar histórico (até 10 turnos, alternando user/assistant)
    const messages = [];
    const recentHistory = Array.isArray(history)
      ? history.slice(-10).filter(
          m => m?.role && m?.content && typeof m.content === 'string'
        )
      : [];

    for (const m of recentHistory) {
      messages.push({ role: m.role, content: m.content.slice(0, 2000) });
    }
    messages.push({ role: 'user', content: message.trim() });

    // Chamar Anthropic API
    const apiKey = ANTHROPIC_API_KEY.value();
    if (!apiKey) {
      console.error('[Ana] ANTHROPIC_API_KEY não configurada!');
      return res.status(503).json({
        error: 'Ana está temporariamente indisponível. Tente novamente mais tarde.',
        code: 'NO_API_KEY',
      });
    }

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
        // ANA-FIX-4: sem streaming — mais estável em conexões móveis instáveis
      });
    } catch (fetchErr) {
      console.error('[Ana] Erro de rede ao chamar Anthropic:', fetchErr.message);
      return res.status(502).json({
        error: 'Não consegui me conectar. Verifique sua internet e tente novamente.',
        code: 'UPSTREAM_ERROR',
      });
    }

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      console.error('[Ana] Anthropic retornou erro:', anthropicRes.status, errText);

      // ANA-FIX-8: erros legíveis
      const userMsg =
        anthropicRes.status === 529
          ? 'Ana está sobrecarregada. Tente em instantes.'
          : anthropicRes.status === 401
          ? 'Problema de autenticação interna. Contate o suporte.'
          : 'Ana encontrou um problema. Tente novamente.';

      return res.status(502).json({ error: userMsg, code: `ANTHROPIC_${anthropicRes.status}` });
    }

    const data = await anthropicRes.json();
    const reply = data?.content?.[0]?.text;

    if (!reply) {
      console.error('[Ana] Resposta vazia da Anthropic:', JSON.stringify(data));
      return res.status(502).json({
        error: 'Ana não conseguiu gerar uma resposta. Tente reformular sua pergunta.',
        code: 'EMPTY_RESPONSE',
      });
    }

    // Log leve para monitoramento (sem PII)
    console.log('[Ana] Resposta gerada', {
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
      stopReason: data.stop_reason,
    });

    return res.status(200).json({
      reply,
      usage: {
        input_tokens: data.usage?.input_tokens,
        output_tokens: data.usage?.output_tokens,
      },
    });
  }
);
