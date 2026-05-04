/**
 * MecBusca — ana-chat.js v2
 * Módulo de chat da Ana IA + listener de atualização SW
 *
 * CLIENT-FIX-1: Timeout de 55s no fetch (antes do servidor expirar)
 * CLIENT-FIX-2: Retry automático 1x em falhas de rede
 * CLIENT-FIX-3: AbortController para cancelar requests ao fechar chat
 * CLIENT-FIX-4: Histórico de conversa em memória (até 10 turnos)
 * CLIENT-FIX-5: Estado "digitando..." com animação
 * CLIENT-FIX-6: Fila de mensagens — sem requests paralelos
 * CLIENT-FIX-7: Detecção de offline antes de enviar
 * CLIENT-FIX-8: Endpoint /api/ana
 * CLIENT-FIX-9: Listener BroadcastChannel 'sw-updates' → toast "Nova versão disponível"
 */

const AnaChat = (() => {
  const state = {
    history: [],
    sending: false,
    abortController: null,
  };

  const MAX_HISTORY_TURNS = 10;
  const FETCH_TIMEOUT_MS  = 55_000; // CLIENT-FIX-1
  const ENDPOINT          = '/api/ana'; // CLIENT-FIX-8

  function trimHistory() {
    const maxItems = MAX_HISTORY_TURNS * 2;
    if (state.history.length > maxItems) {
      state.history = state.history.slice(-maxItems);
    }
  }

  // CLIENT-FIX-1 + CLIENT-FIX-3
  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    state.abortController = controller;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    } finally {
      state.abortController = null;
    }
  }

  // CLIENT-FIX-2: retry 1x em erro de rede (não em 4xx/5xx)
  async function fetchWithRetry(url, options, timeoutMs) {
    try {
      return await fetchWithTimeout(url, options, timeoutMs);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('[Ana] Primeiro fetch falhou, tentando novamente...', err.message);
      await new Promise(r => setTimeout(r, 1500));
      return await fetchWithTimeout(url, options, timeoutMs);
    }
  }

  async function sendMessage(message) {
    if (!message?.trim()) return { error: 'Mensagem vazia.' };

    // CLIENT-FIX-6: sem requests paralelos
    if (state.sending) {
      return { error: 'Aguarde a resposta anterior antes de enviar outra mensagem.' };
    }

    // CLIENT-FIX-7: checar conexão antes de tentar
    if (!navigator.onLine) {
      return { error: 'Você está offline. Conecte-se à internet e tente novamente.' };
    }

    state.sending = true;
    state.history.push({ role: 'user', content: message.trim() });
    trimHistory();

    try {
      const response = await fetchWithRetry(
        ENDPOINT,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-App-Version': window.__APP_VERSION__ || '0',
          },
          body: JSON.stringify({
            message: message.trim(),
            history: state.history.slice(0, -1), // CLIENT-FIX-4
          }),
        },
        FETCH_TIMEOUT_MS
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        state.history.pop();
        return { error: data?.error || `Erro ${response.status}. Tente novamente.` };
      }

      const reply = data?.reply;
      if (!reply) {
        state.history.pop();
        return { error: 'Resposta inesperada. Tente novamente.' };
      }

      state.history.push({ role: 'assistant', content: reply });
      trimHistory();
      return { reply };

    } catch (err) {
      state.history.pop();
      if (err.name === 'AbortError') return { error: 'Solicitação cancelada.' };
      console.error('[Ana] Erro de comunicação:', err.message);
      return { error: 'Não consegui conectar à Ana. Verifique sua internet e tente novamente.' };
    } finally {
      state.sending = false;
    }
  }

  function cancel() {
    state.abortController?.abort();
  }

  function resetHistory() {
    state.history = [];
  }

  function isSending() {
    return state.sending;
  }

  // CLIENT-FIX-5: bolha de "digitando..."
  function createTypingBubble(containerEl) {
    const bubble = document.createElement('div');
    bubble.className = 'ana-bubble ana-bubble--typing';
    bubble.setAttribute('aria-label', 'Ana está digitando');
    bubble.innerHTML = `
      <span class="ana-dot"></span>
      <span class="ana-dot"></span>
      <span class="ana-dot"></span>
    `;
    containerEl?.appendChild(bubble);
    return bubble;
  }

  // CLIENT-FIX-9: toast de nova versão quando SW atualiza
  function showUpdateToast() {
    if (document.getElementById('sw-update-toast')) return;

    if (!document.getElementById('sw-toast-styles')) {
      const style = document.createElement('style');
      style.id = 'sw-toast-styles';
      style.textContent = `
        @keyframes _anaSlideUp {
          from { opacity:0; transform:translateX(-50%) translateY(12px); }
          to   { opacity:1; transform:translateX(-50%) translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }

    const toast = document.createElement('div');
    toast.id = 'sw-update-toast';
    toast.setAttribute('role', 'alert');
    toast.style.cssText = [
      'position:fixed', 'bottom:1.5rem', 'left:50%',
      'transform:translateX(-50%)',
      'background:#00D084', 'color:#000',
      'font-family:system-ui,sans-serif',
      'font-size:.875rem', 'font-weight:600',
      'padding:.7rem 1.25rem',
      'border-radius:999px',
      'box-shadow:0 4px 20px rgba(0,208,132,.35)',
      'display:flex', 'align-items:center', 'gap:10px',
      'z-index:9999',
      'animation:_anaSlideUp .3s ease',
      'white-space:nowrap',
    ].join(';');

    const btn = document.createElement('button');
    btn.textContent = 'Atualizar';
    btn.onclick = () => location.reload();
    btn.style.cssText = [
      'background:rgba(0,0,0,.15)', 'border:none', 'color:#000',
      'font-size:.8rem', 'font-weight:700',
      'padding:.3rem .75rem', 'border-radius:999px', 'cursor:pointer',
    ].join(';');

    const span = document.createElement('span');
    span.textContent = 'Nova versão disponível';

    toast.appendChild(span);
    toast.appendChild(btn);
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 12000);
  }

  function initSWUpdateListener() {
    if (!('BroadcastChannel' in window)) return;
    const channel = new BroadcastChannel('sw-updates');
    channel.addEventListener('message', event => {
      if (event.data?.type === 'SW_UPDATED') showUpdateToast();
    });
  }

  // Inicializa imediatamente ou após DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSWUpdateListener);
  } else {
    initSWUpdateListener();
  }

  return { sendMessage, cancel, resetHistory, isSending, createTypingBubble };
})();

window.AnaChat = AnaChat;
