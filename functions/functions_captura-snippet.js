// ═══════════════════════════════════════════════════════════════
//  ADICIONAR ao functions/index.js — Sistema de Captura + Reivindicação
//
//  1. Copie functions/reivindicar.js para sua pasta functions/
//
//  2. Adicione ao topo do functions/index.js:
//     const { reivindicarSolicitar, reivindicarConfirmar } = require('./reivindicar');
//
//  3. Adicione ao bloco de exports:
//     exports.reivindicarSolicitar = reivindicarSolicitar;
//     exports.reivindicarConfirmar = reivindicarConfirmar;
//     exports.oficinaPreview       = oficinaPreview;
//
//  4. Adicione as rotas no firebase.json → hosting → rewrites:
//     { "source": "/api/reivindicar/solicitar", "function": "reivindicarSolicitar" },
//     { "source": "/api/reivindicar/confirmar", "function": "reivindicarConfirmar" },
//     { "source": "/api/oficinas/:slug/preview", "function": "oficinaPreview" },
//     { "source": "/reivindicar/**", "destination": "/reivindicar.html" },
//     { "source": "/admin/oficinas", "destination": "/reivindicar.html" },
//
//  5. Adicione as secrets necessárias:
//     firebase functions:secrets:set ZAPI_INSTANCE_ID
//     firebase functions:secrets:set ZAPI_TOKEN
//
//  6. Deploy:
//     firebase deploy --only functions,hosting
// ═══════════════════════════════════════════════════════════════

// ── Preview público da oficina (para exibir na página de reivindicação) ───────
// Expõe apenas campos não-sensíveis de uma oficina pendente
const { onRequest: onReq2 } = require('firebase-functions/v2/https');
const { getFirestore: getFS2 } = require('firebase-admin/firestore');

const REGION2 = 'southamerica-east1';
const ALLOWED2 = [
  'https://mecbusca.com.br',
  'https://www.mecbusca.com.br',
  'https://mecbusca.firebaseapp.com',
  'http://localhost:5000',
];

exports.oficinaPreview = onReq2(
  { region: REGION2, memory: '256MiB', timeoutSeconds: 10, cors: false },
  async (req, res) => {
    const db = getFS2();
    const origin = req.headers.origin || '';
    res.set('Access-Control-Allow-Origin', ALLOWED2.includes(origin) ? origin : ALLOWED2[0]);
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    // Extrai slug da URL: /api/oficinas/:slug/preview
    const parts = req.path.split('/').filter(Boolean);
    const slug = parts[parts.indexOf('oficinas') + 1];
    if (!slug) return res.status(400).json({ error: 'Slug ausente' });

    const snap = await db.collection('oficinas').doc(slug).get();
    if (!snap.exists) return res.status(404).json({ error: 'Não encontrada' });

    const d = snap.data();
    // Só expõe dados públicos — NUNCA expõe uid, email, ou dados sensíveis
    return res.status(200).json({
      nome:       d.nome,
      cidade:     d.cidade,
      estado:     d.estado,
      telefone:   d.telefone ? d.telefone.slice(-4).padStart(d.telefone.length, '*') : null,
      categorias: d.categorias,
      status:     d.status,
      reivindicado: d.reivindicado,
      avaliacaoGoogle: d.avaliacaoGoogle,
    });
  }
);

// ── Firestore Security Rules — adicionar ao firestore.rules ──────────────────
/*
// Adicione estas regras ao seu firestore.rules existente:

match /oficinas/{slug} {
  // Leitura pública apenas de campos não-sensíveis (via function preview — não direto)
  allow read: if false; // tudo via Cloud Function

  // Escrita apenas por owner autenticado
  allow update: if request.auth != null
    && request.auth.uid == resource.data.uid
    && request.auth.token.role == 'oficina';

  // Admin pode tudo
  allow read, write: if request.auth != null
    && request.auth.token.role == 'admin';
}

match /_otps/{docId} {
  // OTPs nunca são acessíveis pelo cliente
  allow read, write: if false;
}

match /_ratelimits/{docId} {
  // Rate limits nunca são acessíveis pelo cliente
  allow read, write: if false;
}
*/

// ── Índices Firestore — adicionar ao firestore.indexes.json ─────────────────
/*
Adicione ao array "indexes" no firestore.indexes.json:

{
  "collectionGroup": "oficinas",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "status",        "order": "ASCENDING" },
    { "fieldPath": "zapEnviadoAt",  "order": "ASCENDING" },
    { "fieldPath": "reivindicado",  "order": "ASCENDING" }
  ]
},
{
  "collectionGroup": "oficinas",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "origem",     "order": "ASCENDING" },
    { "fieldPath": "status",     "order": "ASCENDING" },
    { "fieldPath": "capturedAt", "order": "DESCENDING" }
  ]
},
{
  "collectionGroup": "oficinas",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "place_id", "order": "ASCENDING" }
  ]
}
*/

// ── npm packages necessários — adicionar ao functions/package.json ────────────
/*
Adicione em "dependencies":
  "node-fetch": "^3.3.2"

E instale:
  cd functions && npm install node-fetch
*/
