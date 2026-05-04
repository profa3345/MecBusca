/**
 * MecBusca — ana-chat.js
 * Módulo de chat da Ana IA para integração no index.html
 *
 * FIXES mobile:
 *   CLIENT-FIX-1: Timeout de 55s no fetch (antes do servidor expirar)
 *   CLIENT-FIX-2: Retry automático (1x) em falhas de rede — comum em 4G/5G
 *   CLIENT-FIX-3: AbortController para cancelar requests pendentes ao fechar chat
 *   CLIENT-FIX-4: Histórico de conversa mantido em memória (até 10 turnos)
 *   CLIENT-FIX-5: Estado de "digitando..." com animação enquanto aguarda
 *   CLIENT-FIX-6: Fila de mensagens — evita requests paralelos que causam out-of-order
 *   CLIENT-FIX-7: Detecção de offline antes de enviar (sem tentar request inútil)
 *   CLIENT-FIX-8: Endpoint /api/ana (não mais /api/leads)
 */

const AnaChat = (() => {
  // ── Estado ────────────────────────────────────────────────────
  const state = {
    history: [],       // [{role: 'user'|'assistant', content: string}]
    sending: false,    // CLIENT-FIX-6: fila simples — bloqueia envio paralelo
    abortController: null,
  };

  // ── Config ────────────────────────────────────────────────────
  const MAX_HISTORY_TURNS = 10;
  const FETCH_TIMEOUT_MS  = 55_000; // CLIENT-FIX-1
  const ENDPOINT          = '/api/ana'; // CLIENT-FIX-8

  // ── Helpers ───────────────────────────────────────────────────
  function trimHistory() {
    // Mantém apenas os últimos N turnos (user + assistant = 2 itens por turno)
    const maxItems = MAX_HISTORY_TURNS * 2;
    if (state.history.length > maxItems) {
      state.history = state.history.slice(-maxItems);
    }
  }

  // CLIENT-FIX-1 + CLIENT-FIX-3: fetch com timeout e cancelamento
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

  // CLIENT-FIX-2: retry 1x em erros de rede (não em erros HTTP 4xx)
  async function fetchWithRetry(url, options, timeoutMs) {
    try {
      return await fetchWithTimeout(url, options, timeoutMs);
    } catch (err) {
      if (err.name === 'AbortError') throw err; // cancelamento manual, não retry

      console.warn('[Ana] Primeiro fetch falhou, tentando novamente...', err.message);
      await new Promise(r => setTimeout(r, 1500)); // pequena pausa
      return await fetchWithTimeout(url, options, timeoutMs);
    }
  }

  // ── API principal ─────────────────────────────────────────────

  /**
   * Envia mensagem para Ana e retorna a resposta.
   * @param {string} message - texto do usuário
   * @returns {Promise<{reply: string, error?: string}>}
   */
  async function sendMessage(message) {
    if (!message?.trim()) {
      return { error: 'Mensagem vazia.' };
    }

    // CLIENT-FIX-6: fila — não permite envio paralelo
    if (state.sending) {
      return { error: 'Aguarde a resposta anterior antes de enviar outra mensagem.' };
    }

    // CLIENT-FIX-7: verificar conexão antes de tentar
    if (!navigator.onLine) {
      return { error: 'Você está offline. Conecte-se à internet e tente novamente.' };
    }

    state.sending = true;

    // Adiciona ao histórico imediatamente
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
            // Envia histórico excluindo a última mensagem do user (que já está no campo message)
            history: state.history.slice(0, -1),
          }),
        },
        FETCH_TIMEOUT_MS
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Remove a mensagem do user do histórico se falhou (para não poluir)
        state.history.pop();
        const errorMsg = data?.error || `Erro ${response.status}. Tente novamente.`;
        return { error: errorMsg };
      }

      const reply = data?.reply;
      if (!reply) {
        state.history.pop();
        return { error: 'Resposta inesperada. Tente novamente.' };
      }

      // Adiciona resposta da Ana ao histórico
      state.history.push({ role: 'assistant', content: reply });
      trimHistory();

      return { reply };

    } catch (err) {
      // Remove a mensagem do user do histórico em caso de erro
      state.history.pop();

      if (err.name === 'AbortError') {
        return { error: 'Solicitação cancelada.' };
      }

      // Timeout ou erro de rede
      console.error('[Ana] Erro de comunicação:', err.message);
      return {
        error: 'Não consegui conectar à Ana. Verifique sua internet e tente novamente.',
      };
    } finally {
      state.sending = false;
    }
  }

  /**
   * Cancela request em andamento (ex: usuário fecha o chat)
   */
  function cancel() {
    if (state.abortController) {
      state.abortController.abort();
    }
  }

  /**
   * Limpa o histórico (nova conversa)
   */
  function resetHistory() {
    state.history = [];
  }

  /**
   * Retorna se há um request em andamento
   */
  function isSending() {
    return state.sending;
  }

  // ── UI Helper: renderiza bolha de "digitando..." ──────────────
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

  // ── Expõe API pública ─────────────────────────────────────────
  return {
    sendMessage,
    cancel,
    resetHistory,
    isSending,
    createTypingBubble,
  };
})();

// Disponibiliza globalmente
window.AnaChat = AnaChat;
