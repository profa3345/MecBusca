#!/usr/bin/env node
/**
 * MecBusca — scripts/capture-oficinas.js
 *
 * Captura automática de oficinas mecânicas via Google Places API
 * e salva no Firestore com status "pendente_confirmacao".
 *
 * USO:
 *   GOOGLE_PLACES_KEY=AIza... FIREBASE_PROJECT=mecbusca node capture-oficinas.js
 *   node capture-oficinas.js --cidade "Vitória, ES" --categoria "oficina mecânica"
 *   node capture-oficinas.js --all-es     # percorre todas as cidades do ES
 *   node capture-oficinas.js --all-br     # percorre todas as cidades do Brasil
 *   node capture-oficinas.js --estado SP  # percorre todas as cidades de SP
 *   node capture-oficinas.js --dry-run    # simula sem salvar
 *
 * REQUISITOS:
 *   npm install node-fetch firebase-admin
 *   Variáveis de ambiente:
 *     GOOGLE_PLACES_KEY  — chave da Google Places API (com Places API ativa)
 *     GOOGLE_SA_KEY_FILE — path para service account JSON do Firebase (opcional)
 *     FIREBASE_PROJECT   — project ID (padrão: mecbusca)
 *
 * CUSTO ESTIMADO GOOGLE PLACES API:
 *   Text Search: $0,032 por request (1000 = $32)
 *   Place Details: $0,017 por request (1000 = $17)
 *   Para cobrir ES inteiro (~50 cidades, 10 queries cada): ~$25
 */

'use strict';

const https = require('https');
const path  = require('path');
const fs    = require('fs');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const ALL_ES   = args.includes('--all-es');
const ALL_BR   = args.includes('--all-br');
const VERBOSE  = args.includes('--verbose');

function getArg(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const cidadeArg = getArg('--cidade');
const catArg    = getArg('--categoria');
const estadoArg = getArg('--estado');
const tipoArg   = getArg('--tipo');

// ── Configuração ──────────────────────────────────────────────────────────────
const GOOGLE_KEY      = process.env.GOOGLE_PLACES_KEY;
const PROJECT_ID      = process.env.FIREBASE_PROJECT || 'mecbusca';
const SA_KEY_FILE     = process.env.GOOGLE_SA_KEY_FILE || null;

const DELAY_MS        = 200;   // delay entre requests (respeitar rate limit Google)
const RESULTS_PER_QUERY = 20;  // Google Places retorna até 20 por página
const MAX_PAGES       = 3;     // até 3 páginas = até 60 resultados por query
const DEDUP_KEY       = 'place_id'; // campo para deduplicação

// ── Cidades por estado ────────────────────────────────────────────────────────
const CIDADES_BR = {
  AC: ['Rio Branco, AC', 'Cruzeiro do Sul, AC', 'Sena Madureira, AC', 'Tarauacá, AC'],
  AL: ['Maceió, AL', 'Arapiraca, AL', 'Palmeira dos Índios, AL', 'União dos Palmares, AL', 'Penedo, AL'],
  AM: ['Manaus, AM', 'Parintins, AM', 'Itacoatiara, AM', 'Manacapuru, AM', 'Coari, AM', 'Tefé, AM'],
  AP: ['Macapá, AP', 'Santana, AP', 'Laranjal do Jari, AP', 'Oiapoque, AP'],
  BA: ['Salvador, BA', 'Feira de Santana, BA', 'Vitória da Conquista, BA', 'Camaçari, BA',
       'Itabuna, BA', 'Juazeiro, BA', 'Lauro de Freitas, BA', 'Ilhéus, BA', 'Jequié, BA',
       'Teixeira de Freitas, BA', 'Barreiras, BA', 'Porto Seguro, BA', 'Alagoinhas, BA',
       'Paulo Afonso, BA', 'Simões Filho, BA', 'Eunápolis, BA', 'Santo Antônio de Jesus, BA'],
  CE: ['Fortaleza, CE', 'Caucaia, CE', 'Juazeiro do Norte, CE', 'Maracanaú, CE',
       'Sobral, CE', 'Crato, CE', 'Itapipoca, CE', 'Maranguape, CE', 'Iguatu, CE',
       'Quixadá, CE', 'Pacatuba, CE', 'Aquiraz, CE'],
  DF: ['Brasília, DF', 'Ceilândia, DF', 'Taguatinga, DF', 'Samambaia, DF',
       'Planaltina, DF', 'Gama, DF', 'Sobradinho, DF', 'Recanto das Emas, DF'],
  ES: ['Vitória, ES', 'Vila Velha, ES', 'Cariacica, ES', 'Serra, ES',
       'Cachoeiro de Itapemirim, ES', 'Linhares, ES', 'São Mateus, ES',
       'Colatina, ES', 'Guarapari, ES', 'Aracruz, ES', 'Viana, ES',
       'Nova Venécia, ES', 'Barra de São Francisco, ES', 'Piúma, ES', 'Anchieta, ES'],
  GO: ['Goiânia, GO', 'Aparecida de Goiânia, GO', 'Anápolis, GO', 'Rio Verde, GO',
       'Luziânia, GO', 'Águas Lindas de Goiás, GO', 'Valparaíso de Goiás, GO',
       'Trindade, GO', 'Formosa, GO', 'Novo Gama, GO', 'Itumbiara, GO', 'Senador Canedo, GO'],
  MA: ['São Luís, MA', 'Imperatriz, MA', 'Timon, MA', 'Caxias, MA', 'Codó, MA',
       'Paço do Lumiar, MA', 'Açailândia, MA', 'Bacabal, MA', 'Balsas, MA', 'Santa Inês, MA'],
  MG: ['Belo Horizonte, MG', 'Uberlândia, MG', 'Contagem, MG', 'Juiz de Fora, MG',
       'Betim, MG', 'Montes Claros, MG', 'Ribeirão das Neves, MG', 'Uberaba, MG',
       'Governador Valadares, MG', 'Ipatinga, MG', 'Sete Lagoas, MG', 'Divinópolis, MG',
       'Santa Luzia, MG', 'Ibirité, MG', 'Poços de Caldas, MG', 'Patos de Minas, MG',
       'Pouso Alegre, MG', 'Teófilo Otoni, MG', 'Barbacena, MG', 'Sabará, MG',
       'Varginha, MG', 'Conselheiro Lafaiete, MG', 'Muriaé, MG', 'Araguari, MG'],
  MS: ['Campo Grande, MS', 'Dourados, MS', 'Três Lagoas, MS', 'Corumbá, MS',
       'Ponta Porã, MS', 'Naviraí, MS', 'Nova Andradina, MS', 'Aquidauana, MS'],
  MT: ['Cuiabá, MT', 'Várzea Grande, MT', 'Rondonópolis, MT', 'Sinop, MT',
       'Tangará da Serra, MT', 'Cáceres, MT', 'Sorriso, MT', 'Lucas do Rio Verde, MT'],
  PA: ['Belém, PA', 'Ananindeua, PA', 'Santarém, PA', 'Marabá, PA', 'Castanhal, PA',
       'Parauapebas, PA', 'Cameta, PA', 'Itaituba, PA', 'Abaetetuba, PA', 'Tucuruí, PA',
       'Marituba, PA', 'Altamira, PA'],
  PB: ['João Pessoa, PB', 'Campina Grande, PB', 'Santa Rita, PB', 'Patos, PB',
       'Bayeux, PB', 'Sousa, PB', 'Cajazeiras, PB', 'Cabedelo, PB'],
  PE: ['Recife, PE', 'Caruaru, PE', 'Olinda, PE', 'Petrolina, PE', 'Paulista, PE',
       'Caboatã de São Agostinho, PE', 'Jaboatão dos Guararapes, PE', 'Garanhuns, PE',
       'Vitória de Santo Antão, PE', 'Surubim, PE', 'Cabo de Santo Agostinho, PE'],
  PI: ['Teresina, PI', 'Parnaíba, PI', 'Picos, PI', 'Piripiri, PI', 'Floriano, PI', 'Campo Maior, PI'],
  PR: ['Curitiba, PR', 'Londrina, PR', 'Maringá, PR', 'Ponta Grossa, PR', 'Cascavel, PR',
       'São José dos Pinhais, PR', 'Foz do Iguaçu, PR', 'Colombo, PR', 'Guarapuava, PR',
       'Paranaguá, PR', 'Araucária, PR', 'Toledo, PR', 'Apucarana, PR', 'Pinhais, PR',
       'Campo Largo, PR', 'Almirante Tamandaré, PR', 'Umuarama, PR', 'Piraquara, PR'],
  RJ: ['Rio de Janeiro, RJ', 'São Gonçalo, RJ', 'Duque de Caxias, RJ', 'Nova Iguaçu, RJ',
       'Niterói, RJ', 'Belford Roxo, RJ', 'São João de Meriti, RJ', 'Campos dos Goytacazes, RJ',
       'Petrópolis, RJ', 'Volta Redonda, RJ', 'Magé, RJ', 'Itaboraí, RJ',
       'Macaé, RJ', 'Cabo Frio, RJ', 'Mesquita, RJ', 'Nova Friburgo, RJ',
       'Barra Mansa, RJ', 'Angra dos Reis, RJ', 'Nilópolis, RJ', 'Queimados, RJ'],
  RN: ['Natal, RN', 'Mossoró, RN', 'Parnamirim, RN', 'São Gonçalo do Amarante, RN',
       'Macaíba, RN', 'Ceará-Mirim, RN', 'Caicó, RN', 'Açu, RN'],
  RO: ['Porto Velho, RO', 'Ji-Paraná, RO', 'Ariquemes, RO', 'Vilhena, RO',
       'Cacoal, RO', 'Rolim de Moura, RO', 'Guajará-Mirim, RO'],
  RR: ['Boa Vista, RR', 'Rorainópolis, RR', 'Caracaraí, RR'],
  RS: ['Porto Alegre, RS', 'Caxias do Sul, RS', 'Canoas, RS', 'Pelotas, RS',
       'Santa Maria, RS', 'Gravataí, RS', 'Viamão, RS', 'Novo Hamburgo, RS',
       'São Leopoldo, RS', 'Rio Grande, RS', 'Alvorada, RS', 'Passo Fundo, RS',
       'Sapucaia do Sul, RS', 'Uruguaiana, RS', 'Santa Cruz do Sul, RS',
       'Cachoeirinha, RS', 'Bagé, RS', 'Bento Gonçalves, RS', 'Erechim, RS'],
  SC: ['Florianópolis, SC', 'Joinville, SC', 'Blumenau, SC', 'São José, SC',
       'Criciúma, SC', 'Chapecó, SC', 'Itajaí, SC', 'Lages, SC', 'Jaraguá do Sul, SC',
       'Palhoça, SC', 'Balneário Camboriú, SC', 'Biguaçu, SC', 'São Bento do Sul, SC',
       'Caçador, SC', 'Tubarão, SC', 'Concórdia, SC'],
  SE: ['Aracaju, SE', 'Nossa Senhora do Socorro, SE', 'Lagarto, SE', 'Itabaiana, SE',
       'São Cristóvão, SE', 'Estância, SE'],
  SP: ['São Paulo, SP', 'Guarulhos, SP', 'Campinas, SP', 'São Bernardo do Campo, SP',
       'Santo André, SP', 'Osasco, SP', 'São José dos Campos, SP', 'Ribeirão Preto, SP',
       'Sorocaba, SP', 'Mauá, SP', 'Santos, SP', 'São José do Rio Preto, SP',
       'Mogi das Cruzes, SP', 'Diadema, SP', 'Jundiaí, SP', 'Carapicuíba, SP',
       'Piracicaba, SP', 'Bauru, SP', 'São Vicente, SP', 'Franca, SP',
       'Guarujá, SP', 'Taubaté, SP', 'Limeira, SP', 'Suzano, SP',
       'Praia Grande, SP', 'Taboão da Serra, SP', 'Barueri, SP', 'Sumaré, SP',
       'Embu das Artes, SP', 'São Carlos, SP', 'Indaiatuba, SP', 'Cotia, SP',
       'Americana, SP', 'Marília, SP', 'Araraquara, SP', 'Presidente Prudente, SP',
       'Jacareí, SP', 'Hortolândia, SP', 'Itaquaquecetuba, SP', 'Botucatu, SP'],
  TO: ['Palmas, TO', 'Araguaína, TO', 'Gurupi, TO', 'Porto Nacional, TO', 'Paraíso do Tocantins, TO'],
};

// Lista plana de todas as cidades do Brasil
const TODAS_CIDADES_BR = Object.values(CIDADES_BR).flat();

// Cidades do ES (mantido para compatibilidade com --all-es)
const CIDADES_ES = CIDADES_BR.ES;

// ── Categorias de busca — OFICINAS ───────────────────────────────────────────
const CATEGORIAS_OFICINAS = [
  'oficina mecânica',
  'auto elétrica',
  'borracharia',
  'funilaria e pintura',
  'troca de óleo',
  'ar condicionado automotivo',
  'retífica de motor',
  'suspensão e freios',
];

// ── Categorias de busca — FORNECEDORES DE PEÇAS ──────────────────────────────
const CATEGORIAS_PECAS = [
  // Peças gerais
  'autopeças',
  'distribuidora de peças automotivas',
  'peças usadas para carros',
  'sucata de carros peças',

  // Veículos pesados
  'peças para caminhão',
  'distribuidora de peças para caminhão',
  'peças para ônibus',
  'peças para trator',
  'implementos agrícolas peças',

  // Motos e scooters
  'peças para moto',
  'distribuidora de peças para moto',
  'peças para scooter',

  // Vans e utilitários
  'peças para van',
  'peças para utilitários',

  // Especialidades
  'pneus e rodas',
  'baterias automotivas',
  'distribuidora de filtros automotivos',
  'escapamentos automotivos',
  'vidros automotivos',
  'som automotivo e acessórios',
];

// ── Categorias de busca — LAVA-JATOS ─────────────────────────────────────────
const CATEGORIAS_LAVAJATO = [
  'lava jato',
  'lava rápido automotivo',
  'higienização automotiva',
  'polimento automotivo',
  'detailing automotivo',
  'lavagem a vapor automotiva',
  'estética automotiva',
];

// Todas as categorias juntas
const CATEGORIAS_TODAS = [...CATEGORIAS_OFICINAS, ...CATEGORIAS_PECAS, ...CATEGORIAS_LAVAJATO];

// Seleção padrão (oficinas) — pode ser alterada via --tipo
const CATEGORIAS = CATEGORIAS_OFICINAS;

// ── Mapa de normalização de categoria ─────────────────────────────────────────
const CATEGORIA_MAP = {
  // Oficinas
  'oficina mecânica':        'mecanica_geral',
  'auto elétrica':           'auto_eletrica',
  'borracharia':             'borracharia',
  'funilaria e pintura':     'funilaria_pintura',
  'troca de óleo':           'troca_oleo',
  'ar condicionado':         'ar_condicionado',
  'retífica':                'retica_motor',
  'suspensão':               'suspensao_freios',
  'freios':                  'suspensao_freios',

  // Fornecedores de peças
  'autopeças':               'autopecas',
  'distribuidora de peças':  'autopecas',
  'peças usadas':            'pecas_usadas',
  'sucata':                  'pecas_usadas',
  'peças para caminhão':     'pecas_caminhao',
  'peças para ônibus':       'pecas_onibus',
  'peças para trator':       'pecas_trator',
  'implementos':             'pecas_trator',
  'peças para moto':         'pecas_moto',
  'peças para scooter':      'pecas_moto',
  'peças para van':          'pecas_van',
  'pneus':                   'pneus_rodas',
  'baterias':                'baterias',
  'filtros':                 'filtros',
  'escapamentos':            'escapamentos',
  'vidros automotivos':      'vidros_automotivos',
  'som automotivo':          'acessorios',

  // Lava-jatos
  'lava jato':               'lavajato',
  'lava rápido':             'lavajato',
  'higienização automotiva': 'lavajato',
  'polimento automotivo':    'lavajato',
  'detailing':               'lavajato',
  'lavagem a vapor':         'lavajato',
  'estética automotiva':     'lavajato',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(...args)  { console.log('[capture]', ...args); }
function warn(...args) { console.warn('[capture] ⚠️ ', ...args); }
function err(...args)  { console.error('[capture] ❌', ...args); }

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

/** Slug seguro para Firestore doc ID */
function toSlug(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Extrai telefone formatado */
function parseTelefone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  // Remove DDI +55
  const national = digits.startsWith('55') && digits.length > 11
    ? digits.slice(2)
    : digits;
  return national.length >= 10 ? national : null;
}

/** Detecta se o telefone parece ser WhatsApp (celular: 9 dígitos após DDD) */
function isWhatsApp(tel) {
  if (!tel) return false;
  const local = tel.replace(/^\d{2}/, ''); // remove DDD
  return local.startsWith('9') && local.length === 9;
}

/** Normaliza categorias de tipos do Google para categorias MecBusca */
function normalizarCategorias(types = [], queryCategory = '') {
  const cats = new Set();

  const lowerQuery = queryCategory.toLowerCase();
  for (const [key, val] of Object.entries(CATEGORIA_MAP)) {
    if (lowerQuery.includes(key)) cats.add(val);
  }

  // Tipos do Google
  if (types.includes('car_repair'))       cats.add('mecanica_geral');
  if (types.includes('car_dealer'))       cats.add('concessionaria');
  if (types.includes('gas_station'))      cats.add('posto_combustivel');
  if (types.includes('storage'))          cats.add('estacionamento');

  return Array.from(cats.size ? cats : ['mecanica_geral']);
}

// ── Google Places API ─────────────────────────────────────────────────────────
const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

/** Text Search — retorna lista de lugares */
async function textSearch(query, pageToken = null) {
  const params = new URLSearchParams({
    query,
    key: GOOGLE_KEY,
    language: 'pt-BR',
    region: 'br',
    type: 'car_repair',
  });
  if (pageToken) params.set('pagetoken', pageToken);

  const url = `${PLACES_BASE}/textsearch/json?${params}`;
  const data = await httpsGet(url);

  if (data.status === 'REQUEST_DENIED') {
    throw new Error(`Places API negou request: ${data.error_message}`);
  }
  if (!['OK', 'ZERO_RESULTS', 'INVALID_REQUEST'].includes(data.status)) {
    warn(`textSearch status=${data.status} query="${query}"`);
  }
  return data;
}

/** Place Details — retorna detalhes de um lugar pelo place_id */
async function placeDetails(placeId) {
  const fields = [
    'place_id', 'name', 'formatted_address', 'formatted_phone_number',
    'international_phone_number', 'geometry', 'opening_hours',
    'rating', 'user_ratings_total', 'website', 'url',
    'address_components', 'types', 'business_status',
  ].join(',');

  const url = `${PLACES_BASE}/details/json?place_id=${placeId}&fields=${fields}&language=pt-BR&key=${GOOGLE_KEY}`;
  const data = await httpsGet(url);
  return data.result || null;
}

// ── Firestore (Admin SDK via Service Account ou Application Default) ──────────
let db = null;

function initFirestore() {
  if (DRY_RUN) {
    log('DRY RUN — Firestore não será acessado.');
    return;
  }

  const admin = require('firebase-admin');
  if (admin.apps.length) { db = admin.firestore(); return; }

  let credential;
  if (SA_KEY_FILE && fs.existsSync(SA_KEY_FILE)) {
    const sa = require(path.resolve(SA_KEY_FILE));
    credential = admin.credential.cert(sa);
    log(`Usando service account: ${SA_KEY_FILE}`);
  } else {
    credential = admin.credential.applicationDefault();
    log('Usando Application Default Credentials.');
  }

  admin.initializeApp({ credential, projectId: PROJECT_ID });
  db = admin.firestore();
  log(`Firestore conectado ao projeto: ${PROJECT_ID}`);
}

// ── Processamento de oficina ──────────────────────────────────────────────────
const processedPlaceIds = new Set(); // deduplicação em memória
let savedCount   = 0;
let skippedCount = 0;
let errorCount   = 0;

/**
 * Processa um place_id: busca detalhes, normaliza e salva no Firestore.
 * Retorna true se salvou, false se pulou (duplicado/fechado).
 */
async function processarOficina(placeId, cidade, queryCategory) {
  if (processedPlaceIds.has(placeId)) {
    if (VERBOSE) log(`  ↩ Duplicado em memória: ${placeId}`);
    skippedCount++;
    return false;
  }
  processedPlaceIds.add(placeId);

  let details;
  try {
    details = await placeDetails(placeId);
    await sleep(DELAY_MS);
  } catch (e) {
    warn(`placeDetails falhou para ${placeId}: ${e.message}`);
    errorCount++;
    return false;
  }

  if (!details) { skippedCount++; return false; }

  // Ignora estabelecimentos permanentemente fechados
  if (details.business_status === 'PERMANENTLY_CLOSED') {
    if (VERBOSE) log(`  ✕ Fechado permanentemente: ${details.name}`);
    skippedCount++;
    return false;
  }

  // Extrai componentes de endereço
  const comps = details.address_components || [];
  const getComp = type => comps.find(c => c.types.includes(type))?.long_name || '';

  const logradouro = getComp('route');
  const numero     = getComp('street_number');
  const bairro     = getComp('sublocality_level_1') || getComp('sublocality');
  const municipio  = getComp('administrative_area_level_2') || cidade.split(',')[0].trim();
  const estado     = getComp('administrative_area_level_1') || 'ES';
  const cep        = getComp('postal_code');

  const enderecoCompleto = details.formatted_address || '';
  const telefone    = parseTelefone(details.formatted_phone_number || details.international_phone_number);
  const hasWhatsApp = isWhatsApp(telefone);
  const categorias  = normalizarCategorias(details.types, queryCategory);

  const slug = `${toSlug(details.name)}-${toSlug(municipio)}-${placeId.slice(-6)}`;

  const oficina = {
    // Identificação
    place_id:      placeId,
    nome:          details.name,
    slug,

    // Contato
    telefone:      telefone || null,
    whatsapp:      hasWhatsApp ? telefone : null,
    whatsappDetectado: hasWhatsApp,
    website:       details.website || null,
    googleMapsUrl: details.url || null,

    // Endereço
    enderecoCompleto,
    logradouro:    logradouro || null,
    numero:        numero || null,
    bairro:        bairro || null,
    cidade:        municipio,
    estado:        estado.slice(0, 2).toUpperCase(),
    cep:           cep || null,

    // Localização GeoPoint (salvo como objeto para converter no import)
    lat:           details.geometry?.location?.lat || null,
    lng:           details.geometry?.location?.lng || null,

    // Classificação
    categorias,

    // Avaliações Google
    avaliacaoGoogle:      details.rating || null,
    totalAvaliacoesGoogle: details.user_ratings_total || 0,

    // Horários (serializado)
    horarios: details.opening_hours?.weekday_text?.join(' | ') || null,

    // Metadados MecBusca
    origem:      'google_places',
    status:      'pendente_confirmacao',
    reivindicado: false,
    ativo:        false,            // NÃO aparece na busca principal até confirmar

    // Timestamps
    capturedAt:   new Date().toISOString(),
    updatedAt:    null,
    confirmadoAt: null,

    // Painel (vazio até reivindicação)
    uid:          null,
    descricao:    null,
    fotos:        [],
    servicos:     categorias,
    avaliacaoMedia: details.rating || 0,
    totalAvaliacoes: 0,
  };

  if (DRY_RUN) {
    log(`  [DRY] Salvaria: ${oficina.nome} | ${oficina.cidade} | ${oficina.telefone || 'sem tel'}`);
    savedCount++;
    return true;
  }

  // Salva no Firestore (upsert por place_id)
  try {
    const colRef = db.collection('oficinas');

    // Verifica se já existe por place_id
    const existing = await colRef.where('place_id', '==', placeId).limit(1).get();
    if (!existing.empty) {
      if (VERBOSE) log(`  ↩ Já existe no Firestore: ${details.name}`);
      skippedCount++;
      return false;
    }

    // Converte lat/lng para GeoPoint
    const admin = require('firebase-admin');
    if (oficina.lat && oficina.lng) {
      oficina.geopoint = new admin.firestore.GeoPoint(oficina.lat, oficina.lng);
    }
    delete oficina.lat;
    delete oficina.lng;

    await colRef.doc(slug).set(oficina, { merge: false });
    log(`  ✅ Salvo: ${oficina.nome} (${oficina.cidade}) ${oficina.telefone || ''}`);
    savedCount++;
    return true;
  } catch (e) {
    err(`Erro ao salvar ${details.name}: ${e.message}`);
    errorCount++;
    return false;
  }
}

// ── Loop principal ────────────────────────────────────────────────────────────
async function capturarCidade(cidade, categoria) {
  const query = `${categoria} ${cidade}`;
  log(`\n🔍 Buscando: "${query}"`);

  let pageToken = null;
  let page = 0;
  let totalEncontrados = 0;

  do {
    if (pageToken) await sleep(2000); // Google exige 2s entre páginas com pageToken

    let result;
    try {
      result = await textSearch(query, pageToken);
      await sleep(DELAY_MS);
    } catch (e) {
      err(`textSearch falhou: ${e.message}`);
      break;
    }

    const places = result.results || [];
    totalEncontrados += places.length;
    if (VERBOSE) log(`  Página ${page + 1}: ${places.length} resultados`);

    for (const place of places) {
      await processarOficina(place.place_id, cidade, categoria);
      await sleep(DELAY_MS);
    }

    pageToken = result.next_page_token || null;
    page++;
  } while (pageToken && page < MAX_PAGES);

  log(`  → ${totalEncontrados} encontrados em "${cidade}" para "${categoria}"`);
}

async function main() {
  log('════════════════════════════════════════════');
  log('  MecBusca — Captura Automática de Oficinas');
  log('════════════════════════════════════════════');
  log(`  Modo: ${DRY_RUN ? 'DRY RUN (sem salvar)' : 'PRODUÇÃO'}`);
  log(`  Projeto: ${PROJECT_ID}`);
  log('');

  if (!GOOGLE_KEY) {
    err('GOOGLE_PLACES_KEY não definida!');
    err('Exporte a variável antes de rodar:');
    err('  export GOOGLE_PLACES_KEY=AIza...');
    process.exit(1);
  }

  initFirestore();

  // Define escopo da busca
  let cidades;
  if (ALL_BR) {
    cidades = TODAS_CIDADES_BR;
  } else if (estadoArg) {
    const uf = estadoArg.toUpperCase();
    cidades = CIDADES_BR[uf] || [];
    if (!cidades.length) { err(`Estado não encontrado: ${uf}`); process.exit(1); }
  } else if (ALL_ES) {
    cidades = CIDADES_ES;
  } else {
    cidades = [cidadeArg || 'Vitória, ES'];
  }
  const categorias = catArg ? [catArg]
    : tipoArg === 'pecas'    ? CATEGORIAS_PECAS
    : tipoArg === 'lavajato' ? CATEGORIAS_LAVAJATO
    : tipoArg === 'tudo'     ? CATEGORIAS_TODAS
    : CATEGORIAS_OFICINAS;

  log(`  Cidades (${cidades.length}): ${cidades.slice(0, 5).join(', ')}${cidades.length > 5 ? '...' : ''}`);
  log(`  Categorias (${categorias.length}): ${categorias.join(', ')}`);
  log('');

  const startTime = Date.now();

  for (const cidade of cidades) {
    for (const categoria of categorias) {
      await capturarCidade(cidade, categoria);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log('\n════════════════════════════════════════════');
  log(`  ✅ Captura concluída em ${elapsed}s`);
  log(`  Salvos:   ${savedCount}`);
  log(`  Pulados:  ${skippedCount} (duplicados / fechados)`);
  log(`  Erros:    ${errorCount}`);
  log('════════════════════════════════════════════\n');

  if (!DRY_RUN && savedCount > 0) {
    log('🚀 Próximos passos:');
    log('  1. Abra o Painel Admin do MecBusca');
    log('  2. Revise as oficinas com status "pendente_confirmacao"');
    log('  3. Dispare o WhatsApp automático: node send-whatsapp.js');
    log('');
  }
}

main().catch(e => {
  err('Erro fatal:', e);
  process.exit(1);
});
