#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
#  MecBusca — Script de Deploy v3
#  Uso: bash deploy.sh [--prod | --functions | --hosting | --rules]
#  Requisitos: firebase-tools instalado e autenticado
#
#  FIXES v3 aplicados:
#   FIX-SH-7: PROJECT_ID extraído corretamente com --json (era frágil com grep)
#   FIX-SH-8: npm audit --audit-level=high bloqueia deploy se houver CVEs altas
#   FIX-SH-9: verifica existência de ícones PNG (192 e 512) exigidos pelo manifest
#   (mantidos todos os fixes v2: SH-1 a SH-6)
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
echo "🔍 [1/6] Verificando ferramentas..."

# FIX-SH-1: verificar firebase-tools, node, npm, jq
for cmd in firebase node npm; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "   ❌ '${cmd}' não encontrado. Instale e tente novamente."
    exit 1
  fi
done

FIREBASE_VERSION=$(firebase --version 2>/dev/null || echo "desconhecida")
NODE_VERSION=$(node --version 2>/dev/null || echo "desconhecida")
echo "   ✅ firebase: $FIREBASE_VERSION | node: $NODE_VERSION"

# FIX-SH-7: extrair PROJECT_ID corretamente via --json
# 'firebase use' sem flag retorna texto variável por versão do CLI.
# Com --json retorna JSON estável: {"result":"project-id","status":"success"}
PROJECT_ID=""
if command -v jq &>/dev/null; then
  PROJECT_ID=$(firebase use --json 2>/dev/null | jq -r '.result // empty' || echo "")
fi

# Fallback sem jq: pega a última palavra da linha que contém o alias ativo
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(firebase use 2>/dev/null | grep -E '^\*|^\(' | awk '{print $NF}' | tr -d '()' | head -1 || echo "")
fi

if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "null" ]; then
  echo "   ❌ Nenhum projeto Firebase selecionado. Execute: firebase use <project-id>"
  exit 1
fi
echo "   ✅ Projeto Firebase: $PROJECT_ID"

# ── 2. Verificar variáveis críticas de segurança ─────────────
echo ""
echo "🔍 [2/6] Verificando variáveis de segurança..."

WARNINGS=0

# FIX-SH-3: chave reCAPTCHA de teste bloqueia deploy --prod
if grep -q "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI" index.html 2>/dev/null; then
  echo "   ⚠️  CHAVE RECAPTCHA DE TESTE detectada em index.html!"
  if [ "$TARGET" = "--prod" ] || [ "$TARGET" = "all" ]; then
    echo ""
    echo "   ❌ Deploy bloqueado: chave reCAPTCHA de TESTE não pode ir para produção."
    echo "   Configure a chave real: window.__RECAPTCHA_KEY__ = 'SUA_CHAVE_REAL_AQUI'"
    exit 1
  fi
  WARNINGS=$((WARNINGS + 1))
fi

# Check GA4 placeholder
if grep -q "'G-XXXXXXXXXX'" index.html 2>/dev/null; then
  echo "   ⚠️  GA4 ID ainda é placeholder (G-XXXXXXXXXX). Configure window.__GA4_ID__."
  WARNINGS=$((WARNINGS + 1))
fi

# Check FCM VAPID key
if grep -qE "__FCM_VAPID_KEY__.*=.*''" index.html 2>/dev/null; then
  echo "   ⚠️  FCM VAPID key vazia. Notificações push não funcionarão em produção."
  echo "   Obter em: Firebase Console → Project Settings → Cloud Messaging → Web Push certificates"
  WARNINGS=$((WARNINGS + 1))
fi

# FIX-SH-9: verificar ícones PNG exigidos pelo manifest (iOS/Android não usam SVG)
if [ ! -f "icons/icon-192.png" ]; then
  echo "   ⚠️  icons/icon-192.png não encontrado — PWA não instalará no iOS."
  echo "   Gere com: npx pwa-asset-generator icon.svg icons --manifest manifest.json"
  WARNINGS=$((WARNINGS + 1))
fi
if [ ! -f "icons/icon-512.png" ]; then
  echo "   ⚠️  icons/icon-512.png não encontrado — splash screen Android ausente."
  WARNINGS=$((WARNINGS + 1))
fi

# Verificar secrets da função anaIA
if ! firebase functions:secrets:access ANTHROPIC_API_KEY &>/dev/null 2>&1; then
  echo "   ⚠️  Secret ANTHROPIC_API_KEY não configurada (necessária para chatbot Ana)."
  echo "   Configure: firebase functions:secrets:set ANTHROPIC_API_KEY"
  WARNINGS=$((WARNINGS + 1))
fi

if ! firebase functions:secrets:access CNPJA_API_KEY &>/dev/null 2>&1; then
  echo "   ⚠️  CNPJA_API_KEY não configurada — busca/enriquecimento via CNPJá desativado"
  echo "   (Receita Federal/IBGE/OSM continuam funcionando; painel só não conseguirá"
  echo "   revalidar dados oficiais nem o script rodará descoberta automática por cidade)."
  WARNINGS=$((WARNINGS + 1))
fi

if ! firebase functions:secrets:access ZAPI_INSTANCE_ID &>/dev/null 2>&1; then
  echo "   ⚠️  ZAPI_INSTANCE_ID não configurada — verificação por WhatsApp desativada."
  WARNINGS=$((WARNINGS + 1))
fi
if ! firebase functions:secrets:access ZAPI_TOKEN &>/dev/null 2>&1; then
  echo "   ⚠️  ZAPI_TOKEN não configurada."
  WARNINGS=$((WARNINGS + 1))
fi

if ! firebase functions:secrets:access GA4_API_SECRET &>/dev/null 2>&1; then
  echo "   ℹ️  GA4_API_SECRET não configurada (conversões server-side desativadas)."
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo "   ⚠️  $WARNINGS aviso(s). Revise antes de prosseguir."
else
  echo "   ✅ Variáveis de segurança OK"
fi

# ── 3. Instalar dependências das functions ────────────────────
echo ""
echo "📦 [3/6] Instalando dependências das Cloud Functions..."
if [ -d "functions" ] && [ -f "functions/package.json" ]; then
  (cd functions && npm install --omit=dev --silent)
  echo "   ✅ Dependências instaladas"

  # FIX-SH-8: bloquear deploy se houver vulnerabilidades altas ou críticas
  echo "   🔒 Verificando vulnerabilidades (npm audit)..."
  if ! (cd functions && npm audit --audit-level=high --omit=dev 2>&1); then
    echo ""
    echo "   ❌ Deploy bloqueado: vulnerabilidades HIGH/CRITICAL nas dependências."
    echo "   Execute: cd functions && npm audit fix"
    echo "   Para ignorar (não recomendado em prod): npm audit --audit-level=critical"
    exit 1
  fi
  echo "   ✅ Sem vulnerabilidades altas"
else
  echo "   ℹ️  Pasta functions/ não encontrada — pulando."
fi

# ── 4. Atualizar versão do app ────────────────────────────────
echo ""
echo "🔧 [4/6] Atualizando versão do app para $APP_VERSION..."
# FIX-SH-2: não mexer no service-worker.js via sed.
if [ -f "index.html" ]; then
  sed -i "s/window\.__APP_VERSION__\s*=\s*'[^']*'/window.__APP_VERSION__ = '$APP_VERSION'/g" index.html \
    && echo "   ✅ Versão: $APP_VERSION" \
    || echo "   ⚠️  Não foi possível atualizar __APP_VERSION__ no index.html"
fi

# ── 5. Validações finais de assets ───────────────────────────
echo ""
echo "🔧 [5/6] Validando assets..."

# Checar se screenshots existem (necessários para install prompt no Android)
MISSING_SCREENSHOTS=0
for f in "screenshots/mobile-busca.png" "screenshots/mobile-oficina.png"; do
  if [ ! -f "$f" ]; then
    echo "   ℹ️  $f ausente — install prompt Android pode não mostrar preview"
    MISSING_SCREENSHOTS=$((MISSING_SCREENSHOTS + 1))
  fi
done
if [ "$MISSING_SCREENSHOTS" -eq 0 ]; then
  echo "   ✅ Screenshots PWA presentes"
fi

# ── 6. Deploy ─────────────────────────────────────────────────
echo ""
echo "🚀 [6/6] Iniciando deploy Firebase (target: $TARGET)..."
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
echo "  [ ] Testar chat da Ana no mobile (Chrome DevTools → Network throttle)"
echo ""
echo "  📈 Growth checklist:"
echo "  [ ] GA4 recebendo eventos? → analytics.google.com → Realtime"
echo "  [ ] Lead de teste gerou evento generate_lead no GA4?"
echo "  [ ] FCM VAPID configurada? (se não: push desativado)"
echo "  [ ] Sitemap acessível? → curl https://mecbusca.com.br/sitemap.xml | head -5"
echo "  [ ] PWA instalável no Android? (Chrome → menu → Instalar app)"
echo "  [ ] PWA instalável no iOS? (Safari → Compartilhar → Adicionar à Tela de Início)"
echo "════════════════════════════════════════════════════════"
echo ""
