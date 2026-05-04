#!/usr/bin/env node
/**
 * MecBusca — generate-icons.js
 *
 * Gera icons/icon-192.png e icons/icon-512.png a partir do SVG do logo.
 * Também gera screenshots placeholder se não existirem.
 *
 * Uso:
 *   node generate-icons.js
 *
 * Dependências (instala automaticamente se ausentes):
 *   sharp  — conversão SVG → PNG de alta qualidade
 *
 * Por que sharp e não canvas?
 *   sharp usa libvips nativo, suporta SVG diretamente via librsvg,
 *   não precisa de X11/display e funciona em CI/CD sem cabeça.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Instala sharp se necessário ───────────────────────────────────
try {
  require.resolve('sharp');
} catch {
  console.log('📦 Instalando sharp...');
  execSync('npm install sharp --save-dev', { stdio: 'inherit' });
}

const sharp = require('sharp');

// ── SVG do logo MecBusca ─────────────────────────────────────────
// Mesmo SVG do manifest.json, mas sem URL-encoding (sharp lê buffer)
const SVG_SRC = Buffer.from(`
<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
  <!-- Fundo circular verde -->
  <circle cx="48" cy="46" r="40" fill="#00D084"/>
  <!-- "Pino" abaixo -->
  <path d="M48 96C48 96 10 62 10 46A38 38 0 0 1 86 46C86 62 48 96 48 96Z" fill="#00D084"/>
  <!-- Círculo escuro interno -->
  <circle cx="48" cy="46" r="24" fill="#111a12"/>
  <!-- Corpo da chave de fenda / parafuso -->
  <rect x="45" y="50" width="6" height="18" rx="2" fill="white"/>
  <!-- Cabo da chave -->
  <path d="M35 38Q35 24 48 24Q61 24 61 38L61 46Q61 50 57 50L39 50Q35 50 35 46Z" fill="white"/>
  <!-- Olho / detalhe central -->
  <ellipse cx="48" cy="40" rx="7" ry="9" fill="#111a12"/>
</svg>
`);

const ICONS_DIR = path.join(__dirname, 'icons');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

async function generateIcons() {
  // Cria pastas se não existirem
  fs.mkdirSync(ICONS_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const sizes = [
    { size: 192, file: 'icon-192.png' },
    { size: 512, file: 'icon-512.png' },
  ];

  for (const { size, file } of sizes) {
    const dest = path.join(ICONS_DIR, file);
    await sharp(SVG_SRC)
      .resize(size, size)
      .png({ quality: 100, compressionLevel: 9 })
      .toFile(dest);
    console.log(`✅ Gerado: icons/${file} (${size}×${size})`);
  }

  // Gera screenshots placeholder se não existirem
  // (substituir por prints reais antes de ir para produção)
  const screenshots = [
    { file: 'mobile-busca.png',    label: 'Busca de Oficinas' },
    { file: 'mobile-oficina.png',  label: 'Perfil da Oficina' },
  ];

  for (const { file, label } of screenshots) {
    const dest = path.join(SCREENSHOTS_DIR, file);
    if (fs.existsSync(dest)) {
      console.log(`⏭️  Pulando ${file} (já existe)`);
      continue;
    }

    // Placeholder 750×1334 com cor de fundo e texto centralizado via SVG
    const placeholderSvg = Buffer.from(`
<svg width="750" height="1334" xmlns="http://www.w3.org/2000/svg">
  <rect width="750" height="1334" fill="#080C09"/>
  <rect x="275" y="567" width="200" height="200" rx="24" fill="#00D084" opacity="0.15"/>
  <text x="375" y="640" font-family="system-ui" font-size="48" fill="#00D084"
        text-anchor="middle" dominant-baseline="middle">🔧</text>
  <text x="375" y="720" font-family="system-ui" font-size="22" fill="#ffffff"
        text-anchor="middle" font-weight="600">MecBusca</text>
  <text x="375" y="760" font-family="system-ui" font-size="16" fill="#8a8a9a"
        text-anchor="middle">${label}</text>
  <text x="375" y="820" font-family="system-ui" font-size="13" fill="#555"
        text-anchor="middle">Substituir por screenshot real</text>
</svg>
`);

    await sharp(placeholderSvg)
      .resize(750, 1334)
      .png({ quality: 90 })
      .toFile(dest);
    console.log(`🖼️  Placeholder gerado: screenshots/${file} — substituir por screenshot real`);
  }

  console.log('\n✅ Ícones gerados com sucesso!');
  console.log('   📌 Lembre de substituir os screenshots placeholder por prints reais do app.');
  console.log('   Use: screenshots/mobile-busca.png e screenshots/mobile-oficina.png\n');
}

generateIcons().catch(err => {
  console.error('❌ Erro ao gerar ícones:', err.message);
  process.exit(1);
});
