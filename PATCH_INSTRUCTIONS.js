// ── PATCH firebase.json ─────────────────────────────────────────
// Adicione esta entrada em "rewrites", ANTES da rota catch-all "**":
//
//   {
//     "source": "/api/ana",
//     "function": "anaIA"
//   },
//
// O bloco "rewrites" completo ficará assim:
//
//   "rewrites": [
//     { "source": "/sitemap.xml",  "function": "sitemapXml" },
//     { "source": "/api/leads",    "function": "criarLead"  },
//     { "source": "/api/ana",      "function": "anaIA"      },  ← NOVO
//     { "source": "**",            "destination": "/index.html" }
//   ]
//
// ── PATCH functions/index.js ────────────────────────────────────
// Adicione no topo (imports) e no exports:
//
//   const { anaIA } = require('./ana'); // se separou em arquivo proprio
//   // OU cole diretamente o conteúdo de functions_ana.js
//
//   exports.anaIA = anaIA;
//
// ── PATCH index.html ────────────────────────────────────────────
// 1. Carregue o módulo (antes do fechamento </body>):
//
//   <script src="/ana-chat.js"></script>
//
// 2. No handler do formulário/botão de envio da Ana, substitua
//    qualquer chamada direta à Anthropic API por:
//
//   async function enviarParaAna(texto) {
//     const btn = document.querySelector('#ana-send');
//     const input = document.querySelector('#ana-input');
//     const messages = document.querySelector('#ana-messages');
//
//     if (AnaChat.isSending()) return;
//
//     // Adiciona bolha do usuário
//     appendBubble(messages, 'user', texto);
//     input.value = '';
//
//     // Mostra "digitando..."
//     const typing = AnaChat.createTypingBubble(messages);
//     messages.scrollTop = messages.scrollHeight;
//
//     const result = await AnaChat.sendMessage(texto);
//
//     typing.remove();
//
//     if (result.error) {
//       appendBubble(messages, 'error', result.error);
//     } else {
//       appendBubble(messages, 'assistant', result.reply);
//     }
//
//     messages.scrollTop = messages.scrollHeight;
//   }

// Este arquivo é só documentação do patch — não é executado.
