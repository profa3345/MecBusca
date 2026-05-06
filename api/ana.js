/**
 * MecBusca — api/ana.js
 * Vercel Serverless Function — endpoint /api/ana
 *
 * Deploy: coloque este arquivo em /api/ana.js na raiz do projeto.
 * A Vercel detecta automaticamente e serve como POST https://mecbusca.vercel.app/api/ana
 *
 * Variável de ambiente necessária (Vercel Dashboard → Settings → Environment Variables):
 *   GROQ_API_KEY = gsk_...
 *
 * Como obter a chave GRATUITA:
 *   1. Acesse https://console.groq.com
 *   2. Clique em "API Keys" → "Create API Key"
 *   3. Copie a chave e adicione na Vercel como GROQ_API_KEY
 */

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

// Modelo Groq — llama3-8b-8192 é ultra rápido e gratuito
const GROQ_MODEL = 'llama3-8b-8192';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Rate limit simples em memória (por instância — suficiente para Vercel)
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

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Version');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  // Rate limit
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Muitas mensagens. Aguarde um momento.' });
  }

  // Validação
  const { message, history = [] } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'Mensagem inválida.' });
  if (message.length > 4000) return res.status(400).json({ error: 'Mensagem muito longa.' });

  // Montar histórico no formato OpenAI (compatível com Groq)
  const messages = [
    { role: 'system', content: ANA_SYSTEM_PROMPT },
    ...(Array.isArray(history)
      ? history
          .slice(-10)
          .filter(m => ['user', 'assistant'].includes(m?.role) && typeof m?.content === 'string')
          .map(m => ({
            role: m.role,
            content: sanitize(m.content, 2000),
          }))
      : []),
    { role: 'user', content: sanitize(message) },
  ];

  // Chamar Groq
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('[Ana] GROQ_API_KEY não configurada');
    return res.status(503).json({ error: 'Ana indisponível. Tente mais tarde.' });
  }

  let groqRes;
  try {
    groqRes = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        max_tokens: 1024,
        temperature: 0.85,
      }),
    });
  } catch (e) {
    console.error('[Ana] fetch error:', e.message);
    return res.status(502).json({ error: 'Erro de conexão. Tente novamente.' });
  }

  if (!groqRes.ok) {
    const status = groqRes.status;
    console.error('[Ana] Groq error:', status);
    return res.status(502).json({
      error: status === 429 ? 'Ana sobrecarregada. Tente em instantes.'
           : status === 400 ? 'Requisição inválida. Tente reformular.'
           : 'Ana encontrou um problema. Tente novamente.',
    });
  }

  const data = await groqRes.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) return res.status(502).json({ error: 'Resposta vazia. Tente reformular.' });

  const usage = data?.usage;
  console.log('[Ana] ok', { in: usage?.prompt_tokens, out: usage?.completion_tokens });
  return res.status(200).json({ reply });
}
