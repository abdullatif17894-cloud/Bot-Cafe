// CafeBot chat widget — sends real messages to the backend (/api/chat),
// shows a typing indicator while waiting, and renders the real response.

(function () {
  var API_ENDPOINT = '/api/chat';
  var HISTORY_LIMIT = 10; // recent messages (user + assistant) sent for context
  var GREETING = "Hi! I'm CafeBot. Ask me about our menu, hours, or place an order!";
  var NETWORK_ERROR_MESSAGE =
    "Sorry, I couldn't reach CafeBot right now. Please check your connection and try again.";

  var widget = document.querySelector('.cafebot-widget');
  var toggleBtn = document.getElementById('cafebot-toggle');
  var closeBtn = document.getElementById('cafebot-close');
  var windowEl = document.getElementById('cafebot-window');
  var messagesEl = document.getElementById('cafebot-messages');
  var formEl = document.getElementById('cafebot-form');
  var inputEl = document.getElementById('cafebot-input');
  var sendBtn = formEl ? formEl.querySelector('.cafebot-send') : null;

  if (!widget || !toggleBtn || !windowEl || !messagesEl || !formEl || !inputEl) {
    return;
  }

  var isOpen = false;
  var hasGreeted = false;
  var isWaiting = false;
  var conversationHistory = [];

  function openChat() {
    isOpen = true;
    widget.classList.add('is-open');
    windowEl.hidden = false;
    requestAnimationFrame(function () {
      windowEl.classList.add('is-visible');
    });
    toggleBtn.setAttribute('aria-expanded', 'true');

    if (!hasGreeted) {
      hasGreeted = true;
      addBubble(GREETING, 'bot');
    }

    inputEl.focus();
  }

  function closeChat() {
    isOpen = false;
    widget.classList.remove('is-open');
    windowEl.classList.remove('is-visible');
    toggleBtn.setAttribute('aria-expanded', 'false');
    setTimeout(function () {
      if (!isOpen) {
        windowEl.hidden = true;
      }
    }, 200);
  }

  function toggleChat() {
    if (isOpen) {
      closeChat();
    } else {
      openChat();
    }
  }

  function addBubble(text, sender) {
    var bubble = document.createElement('div');
    bubble.className = 'cafebot-bubble ' + (sender === 'user' ? 'cafebot-bubble-user' : 'cafebot-bubble-bot');
    bubble.textContent = text;
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  function showTypingIndicator() {
    var bubble = document.createElement('div');
    bubble.className = 'cafebot-bubble cafebot-bubble-bot cafebot-typing';
    bubble.id = 'cafebot-typing-indicator';
    bubble.textContent = 'CafeBot is typing…';
    bubble.setAttribute('aria-live', 'polite');
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function removeTypingIndicator() {
    var el = document.getElementById('cafebot-typing-indicator');
    if (el) {
      el.remove();
    }
  }

  function setWaiting(waiting) {
    isWaiting = waiting;
    inputEl.disabled = waiting;
    if (sendBtn) {
      sendBtn.disabled = waiting;
    }
  }

  function handleSend(event) {
    event.preventDefault();

    if (isWaiting) {
      return;
    }

    var text = inputEl.value.trim();
    if (!text) {
      return;
    }

    addBubble(text, 'user');
    inputEl.value = '';
    setWaiting(true);
    showTypingIndicator();

    var recentHistory = conversationHistory.slice(-HISTORY_LIMIT);

    fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, conversationHistory: recentHistory }),
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            throw new Error('Received an invalid response from the server.');
          })
          .then(function (data) {
            if (!response.ok) {
              throw new Error((data && data.error) || 'The request failed.');
            }
            return data;
          });
      })
      .then(function (data) {
        removeTypingIndicator();
        var reply = data && typeof data.reply === 'string' ? data.reply : "Sorry, I didn't quite catch that.";
        addBubble(reply, 'bot');
        conversationHistory = Array.isArray(data.conversationHistory)
          ? data.conversationHistory
          : conversationHistory.concat([
              { role: 'user', content: text },
              { role: 'assistant', content: reply },
            ]);
      })
      .catch(function (err) {
        removeTypingIndicator();
        addBubble(NETWORK_ERROR_MESSAGE, 'bot');
        console.error('CafeBot request failed:', err);
      })
      .finally(function () {
        setWaiting(false);
        inputEl.focus();
      });
  }

  toggleBtn.addEventListener('click', toggleChat);
  closeBtn.addEventListener('click', closeChat);
  formEl.addEventListener('submit', handleSend);
})();
