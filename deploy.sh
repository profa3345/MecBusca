#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
#  MecBusca — Script de Deploy
#  Uso: bash deploy.sh [--prod | --functions | --hosting]
#  Requisitos: firebase-tools instalado e autenticado
# ════════════════════════════════════════════════════════════════
set -e

TARGET="${1:-all}"
BUILD_TS=$(date +%s)

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║        MecBusca — Deploy  $(date '+%d/%m/%Y %H:%M:%S')       ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── 1. Substituir BUILD_TS no service worker ──────────────────
echo "🔧 [1/5] Substituindo BUILD_TS = $BUILD_TS no service-worker.js..."
# Usa sed in-place (Linux). No macOS: sed -i '' ...
sed -i "s/__BUILD_TS__/$BUILD_TS/g" service-worker.js
echo "   ✅ service-worker.js atualizado (cache invalidado)"

# ── 2. Atualizar versão do app no index.html ──────────────────
echo "🔧 [2/5] Atualizando __APP_VERSION__..."
APP_VERSION=$(date '+%Y.%m.%d.%H%M')
# Substitui apenas a versão no bloco de env vars
sed -i "s/window.__APP_VERSION__    = '[^']*'/window.__APP_VERSION__    = '$APP_VERSION'/" index.html
echo "   ✅ Versão: $APP_VERSION"

# ── 3. Verificar variáveis obrigatórias ──────────────────────
echo "🔍 [3/5] Verificando variáveis de ambiente..."
if grep -q "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI" index.html; then
  echo ""
  echo "   ⚠️  ATENÇÃO: Usando chave reCAPTCHA de TESTE!"
  echo "   Configure a chave real em index.html:"
  echo "   window.__RECAPTCHA_KEY__ = 'SUA_CHAVE_AQUI'"
  echo ""
fi
if grep -q "'G-XXXXXXXXXX'" index.html 2>/dev/null || grep -q "__GA4_ID__.*= ''" index.html 2>/dev/null; then
  echo "   ℹ️  GA4 não configurado (opcional mas recomendado)"
  echo "   Configure: window.__GA4_ID__ = 'G-SEU_ID'"
fi
if grep -q "__SENTRY_DSN__.*= ''" index.html 2>/dev/null; then
  echo "   ℹ️  Sentry não configurado (opcional mas recomendado para produção)"
  echo "   Configure: window.__SENTRY_DSN__ = 'https://...@sentry.io/...'"
fi
echo "   ✅ Verificação concluída"

# ── 4. Deploy ─────────────────────────────────────────────────
echo ""
echo "🚀 [4/5] Iniciando deploy Firebase..."
if [ "$TARGET" = "--functions" ]; then
  firebase deploy --only functions
elif [ "$TARGET" = "--hosting" ]; then
  firebase deploy --only hosting
elif [ "$TARGET" = "--rules" ]; then
  firebase deploy --only firestore:rules,firestore:indexes
else
  # Deploy completo
  firebase deploy --only hosting,functions,firestore:rules,firestore:indexes
fi

echo ""
echo "✅ [5/5] Deploy concluído!"

# ── 5. Reverter BUILD_TS para placeholder (para próximo deploy) ─
echo ""
echo "🔄 Revertendo service-worker.js para controle de versão..."
sed -i "s/const _RAW_TS = '$BUILD_TS'/const _RAW_TS = '__BUILD_TS__'/" service-worker.js
echo "   ✅ service-worker.js revertido"

echo ""
echo "════════════════════════════════════════════════════"
echo "  App: https://mecbusca.com.br"
echo "  Console: https://console.firebase.google.com/project/mecbusca"
echo ""
echo "  📋 Checklist pós-deploy:"
echo "  [ ] App Check enforcement ATIVO no console Firebase?"
echo "  [ ] Testar busca de oficinas"
echo "  [ ] Testar envio de lead"
echo "  [ ] Verificar Sentry por 5 min"
echo "════════════════════════════════════════════════════"
echo ""
