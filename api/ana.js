/**
 * MecBusca — api/ana.js
 * Vercel Serverless Function — endpoint /api/ana
 *
 * FIXES aplicados:
 *   FIX-1: Convertido para CommonJS puro (sem export default / ESM)
 *          Evita transpilação automática da Vercel que pode corromper o body
 *   FIX-2: Log detalhado do erro da Groq (status + body) para facilitar debug
 *   FIX-3: Fallback de modelo: tenta mixtral se llama3 falhar com 400
 *   FIX-4: Validação explícita de GROQ_API_KEY com mensagem clara no log
 *   FIX-5: Body parseado defensivamente (Vercel às vezes não parseia JSON auto)
 *
 * Variável de ambiente (Vercel Dashboard → Settings → Environment Variables):
 *   GROQ_API_KEY = gsk_...
 *
 * Obter chave GRATUITA: https://console.groq.com → API Keys → Create API Key
 */

'use strict';

const ALLOWED_ORIGINS = [
  'https://mecbusca.vercel.app',
  'https://mecbusca.com.br',
  'https://www.mecbusca.com.br',
  'http://localhost:3000',
  'http://localhost:5000',
];

const ANA_SYSTEM_PROMPT = `Você é Ana, uma inteligência artificial criada pelo MecBusca.
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
- Se a pergunta for sobre carros, mecânica ou manutenção, ofereça ajudar a encontrar uma oficina`;

// FIX-3: lista de modelos em ordem de preferência (fallback automático)
const GROQ_MODELS = [
  'llama3-8b-8192',
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
];
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Rate limit simples em memória (por instância Vercel)
const rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const maxReqs = 20;
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return true;
  }
  if (entry.count >= maxReqs) return false;
  entry.count++;
  rateLimitMap.set(ip, entry);
  return true;
}

function sanitize(str, max = 4000) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim().slice(0, max);
}

// FIX-5: parseia body defensivamente (garante JSON mesmo sem header correto)
function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

// Tenta chamar Groq com um modelo específico
async function callGroq(apiKey, model, messages) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 1024,
      temperature: 0.85,
    }),
  });
  return res;
}

// FIX-1: CommonJS puro — sem export default
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Version');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  // Rate limit
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Muitas mensagens. Aguarde um momento.' });
  }

  // FIX-5: parse body defensivo
  const body = parseBody(req);
  const { message, history = [] } = body;

  if (!message?.trim()) return res.status(400).json({ error: 'Mensagem inválida.' });
  if (message.length > 4000) return res.status(400).json({ error: 'Mensagem muito longa.' });

  // Montar histórico (formato OpenAI / Groq)
  const messages = [
    { role: 'system', content: ANA_SYSTEM_PROMPT },
    ...(Array.isArray(history)
      ? history
          .slice(-10)
          .filter(m => ['user', 'assistant'].includes(m?.role) && typeof m?.content === 'string')
          .map(m => ({ role: m.role, content: sanitize(m.content, 2000) }))
      : []),
    { role: 'user', content: sanitize(message) },
  ];

  // FIX-4: verificar chave com log claro
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('[Ana] ERRO CRÍTICO: GROQ_API_KEY não está configurada nas env vars da Vercel!');
    console.error('[Ana] Acesse: Vercel Dashboard → seu projeto → Settings → Environment Variables');
    return res.status(503).json({ error: 'Ana indisponível. Tente mais tarde.' });
  }

  // FIX-3: tenta cada modelo em sequência até um funcionar
  let lastError = null;
  for (const model of GROQ_MODELS) {
    let groqRes;
    try {
      groqRes = await callGroq(apiKey, model, messages);
    } catch (e) {
      console.error(`[Ana] fetch error com modelo ${model}:`, e.message);
      lastError = 'Erro de conexão com a Groq.';
      continue;
    }

    if (groqRes.ok) {
      const data = await groqRes.json();
      const reply = data?.choices?.[0]?.message?.content;
      if (!reply) {
        return res.status(502).json({ error: 'Resposta vazia. Tente reformular.' });
      }
      console.log('[Ana] ok', { model, in: data.usage?.prompt_tokens, out: data.usage?.completion_tokens });
      return res.status(200).json({ reply });
    }

    // FIX-2: log detalhado do erro para debug
    const status = groqRes.status;
    let errBody = '';
    try { errBody = await groqRes.text(); } catch {}
    console.error(`[Ana] Groq erro ${status} com modelo ${model}:`, errBody);

    if (status === 401) {
      // Chave inválida — inutíl tentar outros modelos
      return res.status(502).json({ error: 'Chave da Groq inválida. Verifique GROQ_API_KEY.' });
    }
    if (status === 429) {
      return res.status(429).json({ error: 'Ana sobrecarregada. Tente em instantes.' });
    }
    // status 400 ou 503 → tenta próximo modelo
    lastError = `Groq ${status}`;
  }

  // Todos os modelos falharam
  console.error('[Ana] Todos os modelos Groq falharam. Último erro:', lastError);
  return res.status(502).json({ error: 'Ana encontrou um problema. Tente novamente.' });
};
