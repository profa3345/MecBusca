#!/usr/bin/env node
/**
 * MecBusca — scripts/capture-oficinas.js  (v4 — pipeline oficial de dados)
 *
 * ANTES: captura 100% via Google Places (Text Search + Details).
 * AGORA: pipeline com fonte de verdade em dados públicos oficiais.
 *
 *   Receita Federal  → registro oficial do CNPJ (via BrasilAPI, espelho
 *                       público do CNPJ da RFB — sem custo, sem chave)
 *        │
 *        ├── CNPJá     → descoberta (busca por CNAE + município) e
 *        │               enriquecimento (telefone/e-mail quando a RFB
 *        │               não tiver). Requer CNPJA_API_KEY (plano pago).
 *        │
 *        ├── IBGE      → normaliza nome do município/UF e resolve o
 *        │               código IBGE (sem custo, sem chave)
 *        │
 *        └── OpenStreetMap (Nominatim) → geocodifica o endereço para
 *                        lat/lng (sem custo, sem chave — respeitar
 *                        política de uso: 1 req/s + User-Agent próprio)
 *
 *   Google Places      → USADO SOMENTE para buscar 1 foto de capa.
 *                        Nada de Text Search/Details completo — custo
 *                        cai de ~$0,05/oficina para ~$0,007/oficina
 *                        (Find Place + 1 Photo).
 *                              ↓
 *                     Banco do MecBusca (Firestore)
 *
 * USO:
 *   # descoberta automática por estado/cidade (usa CNPJá — precisa de chave)
 *   CNPJA_API_KEY=... FIREBASE_PROJECT=mecbusca node capture-oficinas.js --estado ES
 *   node capture-oficinas.js --cidade "Vitória" --estado ES --tipo oficinas
 *   node capture-oficinas.js --all-es
 *   node capture-oficinas.js --all-br
 *
 *   # importação manual de uma lista de CNPJs (não precisa de CNPJá)
 *   node capture-oficinas.js --cnpjs cnpjs.txt
 *
 *   # simula sem gravar no Firestore / sem gastar cota do Google
 *   node capture-oficinas.js --estado ES --dry-run
 *   node capture-oficinas.js --estado ES --sem-foto     # pula Google inteiramente
 *
 * REQUISITOS:
 *   npm install firebase-admin
 *   (fetch nativo do Node 18+ — sem node-fetch)
 *
 * VARIÁVEIS DE AMBIENTE:
 *   FIREBASE_PROJECT     — project ID (padrão: mecbusca)
 *   GOOGLE_SA_KEY_FILE    — path para service account JSON (opcional)
 *   CNPJA_API_KEY         — chave da CNPJá (necessária só para --estado/--cidade/--all-*;
 *                            dispensável no modo --cnpjs)
 *   GOOGLE_PLACES_KEY     — chave da Google Places API (opcional; só para foto de capa)
 *   NOMINATIM_USER_AGENT  — identificação exigida pela política de uso do
 *                           OpenStreetMap (padrão: "MecBusca/1.0 (contato@mecbusca.com.br)")
 *
 * CUSTO ESTIMADO POR OFICINA CAPTURADA:
 *   Receita Federal (BrasilAPI): grátis
 *   IBGE:                        grátis
 *   OpenStreetMap (Nominatim):   grátis (respeitar rate limit)
 *   CNPJá (descoberta):          conforme plano contratado (cobrada por consulta)
 *   Google (1 foto):             ~$0,007 (Find Place $0,00 a $0,017 + Photo ~$0,007)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const ALL_ES    = args.includes('--all-es');
const ALL_BR    = args.includes('--all-br');
const VERBOSE   = args.includes('--verbose');
const SEM_FOTO  = args.includes('--sem-foto');

function getArg(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const cidadeArg  = getArg('--cidade');
const estadoArg  = getArg('--estado');
const tipoArg    = getArg('--tipo');       // oficinas | pecas | lavajato | tudo
const cnpjsFile  = getArg('--cnpjs');       // modo manual: arquivo com 1 CNPJ por linha

// ── Configuração ──────────────────────────────────────────────────────────────
const PROJECT_ID       = process.env.FIREBASE_PROJECT || 'mecbusca';
const SA_KEY_FILE       = process.env.GOOGLE_SA_KEY_FILE || null;
const CNPJA_KEY          = process.env.CNPJA_API_KEY || null;
const GOOGLE_KEY         = process.env.GOOGLE_PLACES_KEY || null;
const NOMINATIM_UA       = process.env.NOMINATIM_USER_AGENT || 'MecBusca/1.0 (contato@mecbusca.com.br)';

const DELAY_NOMINATIM_MS = 1100; // política de uso do OSM: máx. 1 req/s
const DELAY_CNPJA_MS     = 350;
const DELAY_RFB_MS       = 350;
const RESULTS_PER_PAGE   = 20;
const MAX_PAGES          = 5;

// ── Cidades por estado (reaproveitado da versão anterior) ─────────────────────
const CIDADES_BR = {
  AC: ['Rio Branco', 'Cruzeiro do Sul', 'Sena Madureira', 'Tarauacá'],
  AL: ['Maceió', 'Arapiraca', 'Palmeira dos Índios', 'União dos Palmares', 'Penedo'],
  AM: ['Manaus', 'Parintins', 'Itacoatiara', 'Manacapuru', 'Coari', 'Tefé'],
  AP: ['Macapá', 'Santana', 'Laranjal do Jari', 'Oiapoque'],
  BA: ['Salvador', 'Feira de Santana', 'Vitória da Conquista', 'Camaçari', 'Itabuna',
       'Juazeiro', 'Lauro de Freitas', 'Ilhéus', 'Jequié', 'Teixeira de Freitas'],
  CE: ['Fortaleza', 'Caucaia', 'Juazeiro do Norte', 'Maracanaú', 'Sobral', 'Crato'],
  DF: ['Brasília', 'Ceilândia', 'Taguatinga', 'Samambaia', 'Planaltina', 'Gama'],
  ES: ['Vitória', 'Vila Velha', 'Cariacica', 'Serra', 'Cachoeiro de Itapemirim',
       'Linhares', 'São Mateus', 'Colatina', 'Guarapari', 'Aracruz', 'Viana',
       'Nova Venécia', 'Barra de São Francisco', 'Piúma', 'Anchieta'],
  GO: ['Goiânia', 'Aparecida de Goiânia', 'Anápolis', 'Rio Verde', 'Luziânia'],
  MA: ['São Luís', 'Imperatriz', 'Timon', 'Caxias', 'Codó'],
  MG: ['Belo Horizonte', 'Uberlândia', 'Contagem', 'Juiz de Fora', 'Betim',
       'Montes Claros', 'Ribeirão das Neves', 'Uberaba', 'Governador Valadares'],
  MS: ['Campo Grande', 'Dourados', 'Três Lagoas', 'Corumbá', 'Ponta Porã'],
  MT: ['Cuiabá', 'Várzea Grande', 'Rondonópolis', 'Sinop', 'Tangará da Serra'],
  PA: ['Belém', 'Ananindeua', 'Santarém', 'Marabá', 'Castanhal', 'Parauapebas'],
  PB: ['João Pessoa', 'Campina Grande', 'Santa Rita', 'Patos', 'Bayeux'],
  PE: ['Recife', 'Caruaru', 'Olinda', 'Petrolina', 'Paulista', 'Jaboatão dos Guararapes'],
  PI: ['Teresina', 'Parnaíba', 'Picos', 'Piripiri', 'Floriano'],
  PR: ['Curitiba', 'Londrina', 'Maringá', 'Ponta Grossa', 'Cascavel', 'São José dos Pinhais'],
  RJ: ['Rio de Janeiro', 'São Gonçalo', 'Duque de Caxias', 'Nova Iguaçu', 'Niterói',
       'Belford Roxo', 'São João de Meriti', 'Campos dos Goytacazes', 'Petrópolis'],
  RN: ['Natal', 'Mossoró', 'Parnamirim', 'São Gonçalo do Amarante', 'Macaíba'],
  RO: ['Porto Velho', 'Ji-Paraná', 'Ariquemes', 'Vilhena', 'Cacoal'],
  RR: ['Boa Vista', 'Rorainópolis', 'Caracaraí'],
  RS: ['Porto Alegre', 'Caxias do Sul', 'Canoas', 'Pelotas', 'Santa Maria', 'Gravataí'],
  SC: ['Florianópolis', 'Joinville', 'Blumenau', 'São José', 'Criciúma', 'Chapecó'],
  SE: ['Aracaju', 'Nossa Senhora do Socorro', 'Lagarto', 'Itabaiana'],
  SP: ['São Paulo', 'Guarulhos', 'Campinas', 'São Bernardo do Campo', 'Santo André',
       'Osasco', 'São José dos Campos', 'Ribeirão Preto', 'Sorocaba', 'Mauá', 'Santos'],
  TO: ['Palmas', 'Araguaína', 'Gurupi', 'Porto Nacional', 'Paraíso do Tocantins'],
};
const TODAS_CIDADES_BR = Object.entries(CIDADES_BR)
  .flatMap(([uf, cidades]) => cidades.map(c => ({ cidade: c, uf })));

// ── CNAEs oficiais por tipo de negócio ─────────────────────────────────────────
// Fonte: Classificação Nacional de Atividades Econômicas (CONCLA/IBGE).
// ⚠️ Confira sempre a tabela vigente em https://concla.ibge.gov.br/ antes de
//    rodar em produção — a CNAE pode ser revisada pelo IBGE.
const CNAE_OFICINAS = [
  '4520001', // Serviços de manutenção e reparação mecânica de veículos automotores
  '4520003', // Serviços de manutenção e reparação elétrica de veículos automotores
  '4520004', // Serviços de alinhamento e balanceamento de veículos automotores
  '4520005', // Serviços de lanternagem ou funilaria de veículos automotores
  '4520006', // Serviços de pintura de veículos automotores
  '4520007', // Serviços de instalação, manutenção e reparação de acessórios para veículos automotores
  '4520008', // Serviços de capotaria
  '4520002', // Serviços de borracharia para veículos automotores
];
const CNAE_PECAS = [
  '4530701', // Comércio a varejo de peças e acessórios novos para veículos automotores
  '4530703', // Comércio a varejo de peças e acessórios usados para veículos automotores
  '4541206', // Comércio a varejo de peças e acessórios para motocicletas e motonetas
  '4530702', // Comércio por atacado de peças e acessórios novos para veículos automotores
];
const CNAE_LAVAJATO = [
  '9601701', // Lavanderias (usado às vezes por lava-rápidos formais)
  '4520009', // Serviços de lavagem, lubrificação e polimento de veículos automotores
];
const CNAE_TODAS = [...CNAE_OFICINAS, ...CNAE_PECAS, ...CNAE_LAVAJATO];

const CATEGORIA_POR_CNAE = {
  '4520001': 'mecanica_geral',
  '4520002': 'borracharia',
  '4520003': 'auto_eletrica',
  '4520004': 'suspensao_freios',
  '4520005': 'funilaria_pintura',
  '4520006': 'funilaria_pintura',
  '4520007': 'acessorios',
  '4520008': 'acessorios',
  '4530701': 'autopecas',
  '4530702': 'autopecas',
  '4530703': 'pecas_usadas',
  '4541206': 'pecas_moto',
  '9601701': 'lavajato',
  '4520009': 'lavajato',
};

// ── Helpers gerais ──────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(...a)  { console.log('[capture]', ...a); }
function warn(...a) { console.warn('[capture] ⚠️ ', ...a); }
function err(...a)  { console.error('[capture] ❌', ...a); }

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Resposta não-JSON (${res.status}): ${text.slice(0, 200)}`); }
  return { ok: res.ok, status: res.status, data };
}

function toSlug(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }

function parseTelefone(ddd, numero) {
  const d = onlyDigits(ddd);
  const n = onlyDigits(numero);
  if (!d || !n) return null;
  const full = `${d}${n}`;
  return full.length >= 10 ? full : null;
}

function isWhatsApp(tel) {
  if (!tel) return false;
  const local = tel.replace(/^\d{2}/, '');
  return local.startsWith('9') && local.length === 9;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1) RECEITA FEDERAL — fonte de verdade do cadastro (via BrasilAPI)
//    Espelho público, gratuito, dos dados abertos do CNPJ da RFB.
//    Docs: https://brasilapi.com.br/docs#tag/CNPJ
// ═══════════════════════════════════════════════════════════════════════════
const BRASILAPI_CNPJ = 'https://brasilapi.com.br/api/cnpj/v1';

async function consultarReceitaFederal(cnpj) {
  const cnpjLimpo = onlyDigits(cnpj);
  if (cnpjLimpo.length !== 14) throw new Error(`CNPJ inválido: ${cnpj}`);

  const { ok, status, data } = await fetchJson(`${BRASILAPI_CNPJ}/${cnpjLimpo}`);
  if (!ok) {
    throw new Error(`Receita Federal (BrasilAPI) ${status}: ${data?.message || 'erro desconhecido'}`);
  }
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2) CNPJá — descoberta (busca por CNAE + município) e enriquecimento
//    Docs: https://cnpja.com/docs  (ajustar parâmetros conforme plano contratado)
// ═══════════════════════════════════════════════════════════════════════════
const CNPJA_BASE = 'https://api.cnpja.com';

async function cnpjaBuscarPorMunicipio({ uf, cidade, cnaes, page = 1 }) {
  if (!CNPJA_KEY) throw new Error('CNPJA_API_KEY não configurada — descoberta automática indisponível.');

  const params = new URLSearchParams({
    'address.state': uf,
    'address.city': cidade,
    'status.id': '2', // 2 = ATIVA na tabela de situação cadastral da RFB
    'mainActivity.id': cnaes.join(','),
    page: String(page),
    limit: String(RESULTS_PER_PAGE),
  });

  const { ok, status, data } = await fetchJson(`${CNPJA_BASE}/office?${params}`, {
    headers: { Authorization: CNPJA_KEY },
  });
  if (!ok) throw new Error(`CNPJá ${status}: ${JSON.stringify(data).slice(0, 200)}`);

  // Formato de resposta pode variar conforme plano — normaliza para um array simples.
  return Array.isArray(data) ? data : (data.records || data.data || []);
}

/** Enriquece com telefone/e-mail quando a Receita Federal não tiver esses dados. */
async function cnpjaEnriquecer(cnpj) {
  if (!CNPJA_KEY) return null;
  try {
    const { ok, data } = await fetchJson(`${CNPJA_BASE}/office/${onlyDigits(cnpj)}`, {
      headers: { Authorization: CNPJA_KEY },
    });
    return ok ? data : null;
  } catch (e) {
    warn(`CNPJá enriquecimento falhou para ${cnpj}: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3) IBGE — normaliza município/UF e resolve código IBGE
//    Docs: https://servicodados.ibge.gov.br/api/docs/localidades
// ═══════════════════════════════════════════════════════════════════════════
const IBGE_BASE = 'https://servicodados.ibge.gov.br/api/v1/localidades';
const _ibgeCache = new Map(); // uf -> [{id, nome}]

async function ibgeMunicipiosDoEstado(uf) {
  const key = uf.toUpperCase();
  if (_ibgeCache.has(key)) return _ibgeCache.get(key);
  const { ok, data } = await fetchJson(`${IBGE_BASE}/estados/${key}/municipios`);
  const lista = ok && Array.isArray(data) ? data.map(m => ({ id: m.id, nome: m.nome })) : [];
  _ibgeCache.set(key, lista);
  return lista;
}

/** Normaliza o nome do município digitado/vindo da RFB para o nome oficial + código IBGE. */
async function normalizarMunicipio(nomeBruto, uf) {
  const lista = await ibgeMunicipiosDoEstado(uf);
  const alvo = toSlug(nomeBruto);
  const match = lista.find(m => toSlug(m.nome) === alvo)
    || lista.find(m => toSlug(m.nome).startsWith(alvo) || alvo.startsWith(toSlug(m.nome)));
  if (!match) {
    warn(`Município "${nomeBruto}/${uf}" não encontrado no IBGE — mantendo nome original.`);
    return { nome: nomeBruto, codigoIBGE: null };
  }
  return { nome: match.nome, codigoIBGE: match.id };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4) OpenStreetMap (Nominatim) — geocodificação do endereço
//    Política de uso: https://operations.osmfoundation.org/policies/nominatim/
//    Máx. 1 req/s, sempre com User-Agent identificável, sem uso comercial em
//    massa sem hospedagem própria — para volume alto, considerar rodar uma
//    instância própria do Nominatim.
// ═══════════════════════════════════════════════════════════════════════════
async function geocodificarOSM(enderecoCompleto) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    q: enderecoCompleto,
    countrycodes: 'br',
    limit: '1',
  });
  const { ok, data } = await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'User-Agent': NOMINATIM_UA, 'Accept-Language': 'pt-BR' },
  });
  await sleep(DELAY_NOMINATIM_MS);
  if (!ok || !Array.isArray(data) || !data.length) return null;
  const { lat, lon } = data[0];
  return { lat: parseFloat(lat), lng: parseFloat(lon) };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5) Google — USADO SOMENTE PARA FOTO. Sem Text Search, sem Details completo.
// ═══════════════════════════════════════════════════════════════════════════
const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

async function buscarFotoGoogle(nome, enderecoCompleto) {
  if (!GOOGLE_KEY || SEM_FOTO) return null;
  try {
    // Find Place from Text — mais barato que Text Search completo,
    // usado só para achar o place_id e a 1ª foto.
    const fpParams = new URLSearchParams({
      input: `${nome}, ${enderecoCompleto}`,
      inputtype: 'textquery',
      fields: 'place_id,photos',
      language: 'pt-BR',
      key: GOOGLE_KEY,
    });
    const { ok, data } = await fetchJson(`${PLACES_BASE}/findplacefromtext/json?${fpParams}`);
    if (!ok || data.status !== 'OK' || !data.candidates?.length) return null;

    const candidate = data.candidates[0];
    const photoRef = candidate.photos?.[0]?.photo_reference;
    if (!photoRef) return null;

    // URL direta da foto (não baixa o binário aqui — o front-end/CDN resolve on-demand)
    const photoUrl = `${PLACES_BASE}/photo?maxwidth=800&photo_reference=${photoRef}&key=${GOOGLE_KEY}`;
    return { photoUrl, googlePlaceId: candidate.place_id };
  } catch (e) {
    warn(`Google (foto) falhou para "${nome}": ${e.message}`);
    return null;
  }
}

// ── Firestore (Banco do MecBusca) ──────────────────────────────────────────
let db = null;
function initFirestore() {
  if (DRY_RUN) { log('DRY RUN — Firestore não será acessado.'); return; }
  const admin = require('firebase-admin');
  if (admin.apps.length) { db = admin.firestore(); return; }

  let credential;
  if (SA_KEY_FILE && fs.existsSync(SA_KEY_FILE)) {
    credential = admin.credential.cert(require(path.resolve(SA_KEY_FILE)));
    log(`Usando service account: ${SA_KEY_FILE}`);
  } else {
    credential = admin.credential.applicationDefault();
    log('Usando Application Default Credentials.');
  }
  admin.initializeApp({ credential, projectId: PROJECT_ID });
  db = admin.firestore();
  log(`Firestore conectado ao projeto: ${PROJECT_ID}`);
}

// ── Processamento de uma oficina (a partir do CNPJ) ────────────────────────
let savedCount = 0, skippedCount = 0, errorCount = 0;
const processedCNPJs = new Set();

async function processarCNPJ(cnpj) {
  const cnpjLimpo = onlyDigits(cnpj);
  if (processedCNPJs.has(cnpjLimpo)) { skippedCount++; return false; }
  processedCNPJs.add(cnpjLimpo);

  // 1) Receita Federal — fonte de verdade
  let rf;
  try {
    rf = await consultarReceitaFederal(cnpjLimpo);
    await sleep(DELAY_RFB_MS);
  } catch (e) {
    warn(`Receita Federal falhou para ${cnpjLimpo}: ${e.message}`);
    errorCount++;
    return false;
  }

  if (String(rf.descricao_situacao_cadastral || '').toUpperCase() !== 'ATIVA') {
    if (VERBOSE) log(`  ✕ Situação cadastral não ativa: ${rf.razao_social} (${rf.descricao_situacao_cadastral})`);
    skippedCount++;
    return false;
  }

  // 2) CNPJá — enriquecimento (telefone/e-mail quando a RFB não trouxer)
  let enriquecido = null;
  if (CNPJA_KEY) {
    enriquecido = await cnpjaEnriquecer(cnpjLimpo);
    await sleep(DELAY_CNPJA_MS);
  }

  const nome = rf.nome_fantasia?.trim() || rf.razao_social?.trim();
  const telefone =
    parseTelefone(rf.ddd_telefone_1?.slice(0, 2), rf.ddd_telefone_1?.slice(2)) ||
    parseTelefone(enriquecido?.phones?.[0]?.area, enriquecido?.phones?.[0]?.number);
  const email = rf.email || enriquecido?.emails?.[0]?.address || null;

  // 3) IBGE — normaliza município/UF
  const { nome: municipioNorm, codigoIBGE } = await normalizarMunicipio(rf.municipio, rf.uf);

  const enderecoCompleto =
    `${rf.logradouro || ''}, ${rf.numero || 'S/N'} - ${rf.bairro || ''}, ` +
    `${municipioNorm} - ${rf.uf}, ${rf.cep || ''}`.replace(/\s+/g, ' ').trim();

  // 4) OpenStreetMap — geocodifica
  let geo = null;
  try { geo = await geocodificarOSM(enderecoCompleto); }
  catch (e) { warn(`Geocodificação OSM falhou para "${nome}": ${e.message}`); }

  // 5) Google — só a foto de capa (opcional)
  const foto = await buscarFotoGoogle(nome, enderecoCompleto);

  const categorias = [...new Set(
    [rf.cnae_fiscal, ...(rf.cnaes_secundarios || []).map(c => c.codigo)]
      .map(c => CATEGORIA_POR_CNAE[String(c)])
      .filter(Boolean)
  )];
  if (!categorias.length) categorias.push('mecanica_geral');

  const slug = `${toSlug(nome)}-${toSlug(municipioNorm)}-${cnpjLimpo.slice(-6)}`;

  const oficina = {
    // Identificação oficial (Receita Federal)
    cnpj:               cnpjLimpo,
    razaoSocial:         rf.razao_social || null,
    nomeFantasia:         rf.nome_fantasia || null,
    nome,
    slug,
    situacaoCadastral:    rf.descricao_situacao_cadastral || null,
    dataAbertura:         rf.data_inicio_atividade || null,
    porte:                rf.porte || null,
    capitalSocial:        rf.capital_social ?? null,
    cnaePrincipal:        rf.cnae_fiscal || null,
    cnaePrincipalDescricao: rf.cnae_fiscal_descricao || null,

    // Contato
    telefone: telefone || null,
    whatsapp: isWhatsApp(telefone) ? telefone : null,
    whatsappDetectado: isWhatsApp(telefone),
    email,
    website: null, // RFB não traz site — a própria oficina preenche depois no painel

    // Endereço
    enderecoCompleto,
    logradouro: rf.logradouro || null,
    numero:     rf.numero || null,
    bairro:     rf.bairro || null,
    cidade:     municipioNorm,
    estado:     (rf.uf || '').toUpperCase(),
    cep:        rf.cep || null,
    codigoIBGE,

    // Localização (convertida para GeoPoint no momento de salvar)
    lat: geo?.lat ?? null,
    lng: geo?.lng ?? null,

    // Classificação
    categorias,
    servicos: categorias,

    // Foto (opcional, só Google)
    fotoCapa: foto?.photoUrl || null,
    googlePlaceId: foto?.googlePlaceId || null,

    // Metadados MecBusca
    origem: 'receita_federal',
    fontesDados: ['receita_federal', ...(CNPJA_KEY ? ['cnpja'] : []), 'ibge', 'openstreetmap', ...(foto ? ['google_foto'] : [])],
    status: 'pendente_confirmacao',
    reivindicado: false,
    ativo: false,

    // Timestamps
    capturedAt: new Date().toISOString(),
    updatedAt: null,
    confirmadoAt: null,

    // Painel (vazio até reivindicação)
    uid: null,
    descricao: null,
    fotos: [],
    avaliacaoMedia: 0,
    totalAvaliacoes: 0,
  };

  if (DRY_RUN) {
    log(`  [DRY] Salvaria: ${oficina.nome} | CNPJ ${cnpjLimpo} | ${oficina.cidade}/${oficina.estado} | ${oficina.telefone || 'sem tel'}`);
    savedCount++;
    return true;
  }

  try {
    const colRef = db.collection('oficinas');
    const existing = await colRef.where('cnpj', '==', cnpjLimpo).limit(1).get();
    if (!existing.empty) {
      if (VERBOSE) log(`  ↩ Já existe no Firestore (CNPJ ${cnpjLimpo}): ${nome}`);
      skippedCount++;
      return false;
    }

    const admin = require('firebase-admin');
    if (oficina.lat != null && oficina.lng != null) {
      oficina.geopoint = new admin.firestore.GeoPoint(oficina.lat, oficina.lng);
    }
    delete oficina.lat;
    delete oficina.lng;

    await colRef.doc(slug).set(oficina, { merge: false });
    log(`  ✅ Salvo: ${nome} (${oficina.cidade}/${oficina.estado}) CNPJ ${cnpjLimpo}`);
    savedCount++;
    return true;
  } catch (e) {
    err(`Erro ao salvar ${nome} (${cnpjLimpo}): ${e.message}`);
    errorCount++;
    return false;
  }
}

// ── Descoberta via CNPJá por cidade/CNAE ────────────────────────────────────
async function capturarCidade(cidade, uf, cnaes) {
  log(`\n🔍 Buscando via CNPJá: "${cidade}/${uf}" — CNAEs: ${cnaes.length}`);
  let page = 1;
  let totalEncontrados = 0;

  while (page <= MAX_PAGES) {
    let registros;
    try {
      registros = await cnpjaBuscarPorMunicipio({ uf, cidade, cnaes, page });
      await sleep(DELAY_CNPJA_MS);
    } catch (e) {
      err(`Busca CNPJá falhou: ${e.message}`);
      break;
    }
    if (!registros.length) break;

    totalEncontrados += registros.length;
    if (VERBOSE) log(`  Página ${page}: ${registros.length} resultados`);

    for (const reg of registros) {
      const cnpj = reg.taxId || reg.cnpj || reg.tax_id;
      if (!cnpj) continue;
      await processarCNPJ(cnpj);
    }

    if (registros.length < RESULTS_PER_PAGE) break;
    page++;
  }

  log(`  → ${totalEncontrados} candidatos em "${cidade}/${uf}"`);
}

// ── Modo manual: lista de CNPJs em arquivo ──────────────────────────────────
async function capturarDeArquivo(filePath) {
  const conteudo = fs.readFileSync(path.resolve(filePath), 'utf-8');
  const cnpjs = conteudo.split('\n').map(l => onlyDigits(l)).filter(l => l.length === 14);
  log(`📄 ${cnpjs.length} CNPJs carregados de ${filePath}`);
  for (const cnpj of cnpjs) {
    await processarCNPJ(cnpj);
  }
}

// ── Loop principal ────────────────────────────────────────────────────────
async function main() {
  log('════════════════════════════════════════════');
  log('  MecBusca — Captura de Oficinas (dados oficiais)');
  log('════════════════════════════════════════════');
  log(`  Modo: ${DRY_RUN ? 'DRY RUN (sem salvar)' : 'PRODUÇÃO'}`);
  log(`  Projeto: ${PROJECT_ID}`);
  log(`  Foto (Google): ${GOOGLE_KEY && !SEM_FOTO ? 'ativada' : 'desativada'}`);
  log('');

  initFirestore();

  if (cnpjsFile) {
    await capturarDeArquivo(cnpjsFile);
  } else {
    if (!CNPJA_KEY) {
      err('CNPJA_API_KEY não definida — necessária para descoberta automática por cidade/estado.');
      err('Use --cnpjs arquivo.txt para importar uma lista de CNPJs sem CNPJá,');
      err('ou exporte: export CNPJA_API_KEY=...');
      process.exit(1);
    }

    let alvos;
    if (ALL_BR) alvos = TODAS_CIDADES_BR;
    else if (estadoArg && !cidadeArg) alvos = (CIDADES_BR[estadoArg.toUpperCase()] || []).map(c => ({ cidade: c, uf: estadoArg.toUpperCase() }));
    else if (ALL_ES) alvos = CIDADES_BR.ES.map(c => ({ cidade: c, uf: 'ES' }));
    else alvos = [{ cidade: cidadeArg || 'Vitória', uf: (estadoArg || 'ES').toUpperCase() }];

    const cnaes = tipoArg === 'pecas' ? CNAE_PECAS
      : tipoArg === 'lavajato' ? CNAE_LAVAJATO
      : tipoArg === 'tudo'     ? CNAE_TODAS
      : CNAE_OFICINAS;

    log(`  Cidades (${alvos.length}): ${alvos.slice(0, 5).map(a => `${a.cidade}/${a.uf}`).join(', ')}${alvos.length > 5 ? '...' : ''}`);
    log(`  CNAEs (${cnaes.length}): ${cnaes.join(', ')}`);
    log('');

    const startTime = Date.now();
    for (const { cidade, uf } of alvos) {
      await capturarCidade(cidade, uf, cnaes);
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`\n  ⏱  Concluído em ${elapsed}s`);
  }

  log('\n════════════════════════════════════════════');
  log(`  Salvos:   ${savedCount}`);
  log(`  Pulados:  ${skippedCount} (duplicados / inativos)`);
  log(`  Erros:    ${errorCount}`);
  log('════════════════════════════════════════════\n');

  if (!DRY_RUN && savedCount > 0) {
    log('🚀 Próximos passos:');
    log('  1. Abra o Painel Admin do MecBusca');
    log('  2. Revise as oficinas com status "pendente_confirmacao"');
    log('  3. Dispare a verificação por WhatsApp: node reivindicar-solicitar (fluxo já existente)');
    log('');
  }
}

main().catch(e => {
  err('Erro fatal:', e);
  process.exit(1);
});
