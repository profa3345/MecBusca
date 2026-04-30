#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
#  MecBusca — Script de Deploy v2
#  Uso: bash deploy.sh [--prod | --functions | --hosting | --rules]
#  Requisitos: firebase-tools instalado e autenticado
#
#  Melhorias aplicadas:
#   FIX-SH-1: verificação de ferramentas obrigatórias (firebase, node, npm)
#              antes de qualquer operação.
#   FIX-SH-2: deploy.sh não faz sed no service-worker.js (era frágil e
#              desnecessário — CACHE_VER é incrementado manualmente).
#   FIX-SH-3: verificação de chave reCAPTCHA de teste bloqueia deploy --prod.
#   FIX-SH-4: validação de variáveis críticas (PROJECT_ID) antes do deploy.
#   FIX-SH-5: trap para limpeza de estado em caso de erro (exit trap).
#   FIX-SH-6: log com timestamp para auditoria de deploys.
# ════════════════════════════════════════════════════════════════
set -euo pipefail

TARGET="${1:-all}"
DEPLOY_TS=$(date +%s)
APP_VERSION=$(date '+%Y.%m.%d.%H%M')
LOG_FILE="deploy_${APP_VERSION}.log"

# FIX-SH-5: cleanup em caso de falha
trap 'echo "❌ Deploy interrompido. Verifique ${LOG_FILE} para detalhes." | tee -a "$LOG_FILE"' ERR

# FIX-SH-6: tee para log file
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║       MecBusca — Deploy  $(date '+%d/%m/%Y %H:%M:%S')         ║"
echo "║       TARGET: ${TARGET}                                ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── 1. Verificar ferramentas obrigatórias ─────────────────────
echo "🔍 [1/5] Verificando ferramentas..."

# FIX-SH-1: verificar firebase-tools, node, npm
for cmd in firebase node npm; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "   ❌ '${cmd}' não encontrado. Instale e tente novamente."
    exit 1
  fi
done

FIREBASE_VERSION=$(firebase --version 2>/dev/null || echo "desconhecida")
NODE_VERSION=$(node --version 2>/dev/null || echo "desconhecida")
echo "   ✅ firebase: $FIREBASE_VERSION | node: $NODE_VERSION"

# FIX-SH-4: verificar PROJECT_ID configurado
PROJECT_ID=$(firebase use 2>/dev/null | grep -oE '[a-z0-9-]+' | head -1 || echo "")
if [ -z "$PROJECT_ID" ]; then
  echo "   ❌ Nenhum projeto Firebase selecionado. Execute: firebase use <project-id>"
  exit 1
fi
echo "   ✅ Projeto Firebase: $PROJECT_ID"

# ── 2. Verificar variáveis críticas de segurança ─────────────
echo ""
echo "🔍 [2/5] Verificando variáveis de segurança..."

WARNINGS=0

# FIX-SH-3: chave reCAPTCHA de teste bloqueia deploy --prod
if grep -q "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI" index.html; then
  echo "   ⚠️  CHAVE RECAPTCHA DE TESTE detectada em index.html!"
  if [ "$TARGET" = "--prod" ] || [ "$TARGET" = "all" ]; then
    echo ""
    echo "   ❌ Deploy bloqueado: chave reCAPTCHA de TESTE não pode ir para produção."
    echo "   Configure a chave real:"
    echo "   window.__RECAPTCHA_KEY__ = 'SUA_CHAVE_REAL_AQUI'"
    exit 1
  fi
  WARNINGS=$((WARNINGS + 1))
fi

# Check GA4 — G-XXXXXXXXXX placeholder means not configured
if grep -q "'G-XXXXXXXXXX'" index.html 2>/dev/null; then
  echo "   ⚠️  GA4 ID ainda é placeholder (G-XXXXXXXXXX). Configure window.__GA4_ID__."
  WARNINGS=$((WARNINGS + 1))
fi

# Check FCM VAPID key
if grep -qE "__FCM_VAPID_KEY__.*=.*''" index.html 2>/dev/null; then
  echo "   ⚠️  FCM VAPID key vazia. Notificações push não funcionarão em produção."
  echo "   Obter em: Firebase Console → Project Settings → Cloud Messaging → Web Push certificates"
  echo "   Depois definir: window.__FCM_VAPID_KEY__ = 'sua-chave-vapid'"
  if [ "$TARGET" = "--prod" ] || [ "$TARGET" = "all" ]; then
    echo "   ℹ️  Continuando deploy (push é opcional)..."
  fi
  WARNINGS=$((WARNINGS + 1))
fi

# Verificar se ANTHROPIC_API_KEY está configurada como secret
if ! firebase functions:secrets:access ANTHROPIC_API_KEY &>/dev/null 2>&1; then
  echo "   ⚠️  Secret ANTHROPIC_API_KEY não configurada (necessária para chatbot Ana)."
  echo "   Configure: firebase functions:secrets:set ANTHROPIC_API_KEY"
  WARNINGS=$((WARNINGS + 1))
fi

# Verificar GA4 API Secret (para Measurement Protocol server-side)
if ! firebase functions:secrets:access GA4_API_SECRET &>/dev/null 2>&1; then
  echo "   ℹ️  GA4_API_SECRET não configurada (conversões server-side desativadas)."
  echo "   Para ativar: firebase functions:secrets:set GA4_API_SECRET"
  echo "   Obter em: Google Analytics → Admin → Data Streams → Measurement Protocol API secrets"
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo "   ⚠️  $WARNINGS aviso(s). Revise antes de prosseguir."
else
  echo "   ✅ Variáveis de segurança OK"
fi

# ── 3. Instalar dependências das functions ────────────────────
echo ""
echo "📦 [3/5] Instalando dependências das Cloud Functions..."
if [ -d "functions" ] && [ -f "functions/package.json" ]; then
  (cd functions && npm install --omit=dev --silent)
  echo "   ✅ Dependências instaladas"
else
  echo "   ℹ️  Pasta functions/ não encontrada — pulando."
fi

# ── 4. Atualizar versão do app ────────────────────────────────
echo ""
echo "🔧 [4/5] Atualizando versão do app para $APP_VERSION..."
# FIX-SH-2: não mecher no service-worker.js via sed.
#           CACHE_VER é controlado manualmente no arquivo.
if [ -f "index.html" ]; then
  # Substitui __APP_VERSION__ ou a versão atual (formato YYYY.MM.DD.HHMM)
  sed -i "s/window\.__APP_VERSION__\s*=\s*'[^']*'/window.__APP_VERSION__ = '$APP_VERSION'/g" index.html \
    && echo "   ✅ Versão: $APP_VERSION" \
    || echo "   ⚠️  Não foi possível atualizar __APP_VERSION__ no index.html (ok se não usar este padrão)"
fi

# ── 5. Deploy ─────────────────────────────────────────────────
echo ""
echo "🚀 [5/5] Iniciando deploy Firebase (target: $TARGET)..."
echo "   Timestamp: $DEPLOY_TS"

case "$TARGET" in
  --functions)
    firebase deploy --only functions
    ;;
  --hosting)
    firebase deploy --only hosting
    ;;
  --rules)
    firebase deploy --only firestore:rules,firestore:indexes
    ;;
  --prod | all)
    firebase deploy --only hosting,functions,firestore:rules,firestore:indexes
    ;;
  *)
    echo "   ❌ Target desconhecido: $TARGET"
    echo "   Use: --prod | --functions | --hosting | --rules | all"
    exit 1
    ;;
esac

echo ""
echo "✅ Deploy concluído em $(date '+%d/%m/%Y %H:%M:%S')!"
echo "   Log salvo em: $LOG_FILE"

echo ""
echo "════════════════════════════════════════════════════════"
echo "  App: https://mecbusca.com.br"
echo "  Console: https://console.firebase.google.com/project/$PROJECT_ID"
echo ""
echo "  📋 Checklist pós-deploy:"
echo "  [ ] App Check enforcement ATIVO no console Firebase?"
echo "  [ ] Testar busca de oficinas (modo anônimo)"
echo "  [ ] Testar envio de lead (modo anônimo)"
echo "  [ ] Testar login e painel da oficina"
echo "  [ ] Verificar erros: Firebase Console → Firestore → coleção _errors"
echo "  [ ] Verificar logs das Cloud Functions (Firebase Console → Functions → Logs)"
echo ""
echo "  📈 Growth checklist:"
echo "  [ ] GA4 recebendo eventos? → analytics.google.com → Realtime"
echo "  [ ] Lead de teste gerou evento generate_lead no GA4?"
echo "  [ ] FCM VAPID configurada? (se não: push desativado)"
echo "  [ ] Sitemap acessível? → curl https://mecbusca.com.br/sitemap.xml | head -5"
echo "════════════════════════════════════════════════════════"
echo ""
