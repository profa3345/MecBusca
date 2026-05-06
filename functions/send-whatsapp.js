#!/usr/bin/env node
/**
 * MecBusca — scripts/send-whatsapp.js
 *
 * Envia WhatsApp automático para oficinas capturadas com status "pendente_confirmacao"
 * que ainda não foram contatadas (campo zapEnviadoAt === null).
 *
 * USO:
 *   ZAPI_INSTANCE_ID=xxx ZAPI_TOKEN=yyy FIREBASE_PROJECT=mecbusca node send-whatsapp.js
 *   node send-whatsapp.js --dry-run     # simula sem enviar
 *   node send-whatsapp.js --limit 10    # envia para até 10 oficinas
 *   node send-whatsapp.js --cidade Vitória  # filtra por cidade
 *
 * REQUISITOS:
 *   npm install firebase-admin
 *   Z-API: https://app.z-api.io → criar instância → conectar WhatsApp
 *
 * RATE LIMIT Z-API:
 *   Plano gratuito: ~60 msg/min
 *   Este script usa delay de 2s entre mensagens (30 msg/min — seguro)
 */

'use strict';

const https    = require('https');
const path     = require('path');
const fs       = require('fs');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const DRY_RUN    = args.includes('--dry-run');
const VERBOSE    = args.includes('--verbose');
const limitArg   = args[args.indexOf('--limit') + 1];
const cidadeArg  = args[args.indexOf('--cidade') + 1];
const LIMIT      = limitArg ? parseInt(limitArg, 10) : 100;

// ── Configuração ──────────────────────────────────────────────────────────────
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN    = process.env.ZAPI_TOKEN;
const PROJECT_ID    = process.env.FIREBASE_PROJECT || 'mecbusca';
const SA_KEY_FILE   = process.env.GOOGLE_SA_KEY_FILE || null;
const BASE_URL      = process.env.MECBUSCA_URL || 'https://mecbusca.com.br';

const DELAY_MS      = 2000; // 2s entre mensagens

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...a) => console.log('[whatsapp]', ...a);
const warn  = (...a) => console.warn('[whatsapp] ⚠️', ...a);
const err   = (...a) => console.error('[whatsapp] ❌', ...a);

/** Monta a mensagem de WhatsApp para a oficina */
function montarMensagem(oficina) {
  const claimUrl = `${BASE_URL}/reivindicar/${oficina.slug}`;
  const nome = oficina.nome || 'sua oficina';

  return `Olá! 👋

Encontramos *${nome}* e criamos um perfil inicial no *MecBusca*, plataforma de busca de oficinas mecânicas no Brasil.

Nosso objetivo é ajudar novos clientes a encontrarem sua empresa rapidamente 🚗🔧

Seu perfil está em *modo de validação*. Ao confirmar, você poderá:
✅ Aparecer nas buscas do MecBusca
✅ Receber pedidos de orçamento pelo WhatsApp
✅ Adicionar fotos, promoções e serviços
✅ Monitorar avaliações dos clientes

Acesse agora (gratuito):
${claimUrl}

Caso prefira não participar, basta solicitar a remoção pelo mesmo link.

Equipe *MecBusca* 🟢`;
}

/** Envia mensagem via Z-API */
function zapiSend(phone, message) {
  return new Promise((resolve, reject) => {
    // Garante formato internacional sem +
    const number = phone.startsWith('55') ? phone : `55${phone}`;

    const body = JSON.stringify({ phone: number, message });
    const options = {
      hostname: 'api.z-api.io',
      path:     `/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Client-Token':   ZAPI_TOKEN,
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200) resolve(json);
          else reject(new Error(`Z-API ${res.statusCode}: ${data}`));
        } catch {
          reject(new Error(`Parse error: ${data.slice(0, 100)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Firestore ─────────────────────────────────────────────────────────────────
let db = null;

function initFirestore() {
  if (DRY_RUN) { log('DRY RUN — Firestore não será modificado.'); return; }
  const admin = require('firebase-admin');
  if (admin.apps.length) { db = admin.firestore(); return; }

  let credential;
  if (SA_KEY_FILE && fs.existsSync(SA_KEY_FILE)) {
    credential = admin.credential.cert(require(path.resolve(SA_KEY_FILE)));
  } else {
    credential = admin.credential.applicationDefault();
  }
  admin.initializeApp({ credential, projectId: PROJECT_ID });
  db = admin.firestore();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('════════════════════════════════════');
  log('  MecBusca — Envio WhatsApp Auto');
  log('════════════════════════════════════');
  log(`  Modo: ${DRY_RUN ? 'DRY RUN' : 'PRODUÇÃO'}`);
  log(`  Limite: ${LIMIT} mensagens`);
  if (cidadeArg) log(`  Filtro cidade: ${cidadeArg}`);
  log('');

  if (!DRY_RUN) {
    if (!ZAPI_INSTANCE || !ZAPI_TOKEN) {
      err('ZAPI_INSTANCE_ID e ZAPI_TOKEN são obrigatórios!');
      err('Configure em: https://app.z-api.io');
      process.exit(1);
    }
  }

  initFirestore();

  // Buscar oficinas pendentes sem WhatsApp enviado
  let query;
  if (!DRY_RUN) {
    query = db.collection('oficinas')
      .where('status', '==', 'pendente_confirmacao')
      .where('zapEnviadoAt', '==', null)
      .where('reivindicado', '==', false)
      .limit(LIMIT);

    if (cidadeArg) {
      query = query.where('cidade', '==', cidadeArg);
    }
  }

  let oficinas = [];
  if (!DRY_RUN) {
    const snap = await query.get();
    oficinas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } else {
    // No DRY RUN, simula com dados fictícios
    oficinas = [
      { id: 'oficina-turbocar-vitoria-abc123', slug: 'oficina-turbocar-vitoria-abc123',
        nome: 'Oficina TurboCar', telefone: '27999999999', cidade: 'Vitória' },
      { id: 'auto-eletrica-silva-cariacica-def456', slug: 'auto-eletrica-silva-cariacica-def456',
        nome: 'Auto Elétrica Silva', telefone: '27988888888', cidade: 'Cariacica' },
    ].slice(0, LIMIT);
  }

  log(`  Oficinas para contatar: ${oficinas.length}`);
  if (oficinas.length === 0) {
    log('  Nenhuma oficina pendente de contato. Encerrando.');
    return;
  }

  let enviadoCount = 0;
  let erroCount    = 0;
  let semTelCount  = 0;

  for (const oficina of oficinas) {
    const tel = oficina.whatsapp || oficina.telefone;

    if (!tel) {
      if (VERBOSE) warn(`Sem telefone: ${oficina.nome}`);
      semTelCount++;
      continue;
    }

    const mensagem = montarMensagem(oficina);

    if (DRY_RUN) {
      log(`[DRY] Enviaria para ${oficina.nome} (${tel}):`);
      if (VERBOSE) log(mensagem);
      enviadoCount++;
      continue;
    }

    try {
      await zapiSend(tel, mensagem);

      // Marca como enviado no Firestore
      await db.collection('oficinas').doc(oficina.id).update({
        zapEnviadoAt: new Date().toISOString(),
        zapTentativas: (oficina.zapTentativas || 0) + 1,
      });

      log(`  ✅ Enviado: ${oficina.nome} → ${tel}`);
      enviadoCount++;
    } catch (e) {
      err(`  Falha ao enviar para ${oficina.nome} (${tel}): ${e.message}`);

      // Registra erro sem bloquear
      if (!DRY_RUN) {
        await db.collection('oficinas').doc(oficina.id).update({
          zapErro: e.message,
          zapTentativas: (oficina.zapTentativas || 0) + 1,
        }).catch(() => {});
      }
      erroCount++;
    }

    await sleep(DELAY_MS);
  }

  log('\n════════════════════════════════════');
  log(`  ✅ Concluído`);
  log(`  Enviados:     ${enviadoCount}`);
  log(`  Sem telefone: ${semTelCount}`);
  log(`  Erros:        ${erroCount}`);
  log('════════════════════════════════════\n');
}

main().catch(e => { err('Erro fatal:', e); process.exit(1); });
