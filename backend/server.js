// CafeBot backend server.
// Serves the existing frontend, loads environment variables, and answers
// chat requests using the Claude Messages API.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');

// .env lives at the project root, one level up from backend/.
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { TOOLS, executeTool } = require('./tools');
const { listOrders, updateOrderStatus } = require('./ordersStore');

const app = express();

const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const SYSTEM_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'system-prompt.md');

// Current recommended general-purpose model per Anthropic's model docs
// (Claude Opus 5 is recommended for complex agentic coding/enterprise work;
// Claude Sonnet 5 is the recommended balanced choice for general-purpose,
// customer-facing assistants like CafeBot).
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 500;

// Persona/rules prompt. Menu data is no longer inlined here — the getMenu
// and addItemToCart tools (backend/tools.js) are the single source of truth,
// so there's only one place menu data can come from.
const SYSTEM_PROMPT =
  fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8') +
  '\n\n## Menu Lookups\n\n' +
  'Use the `getMenu` tool to look up current menu items, prices, sizes, options, ' +
  'and allergens whenever a customer asks about the menu. Do not answer menu ' +
  'questions from memory, and do not mention any item the tool does not return.';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_TOOL_ITERATIONS = 3;

const SESSION_COOKIE = 'cafebot_session';

// Minimal cookie-based session id — no new dependency, just enough to key
// the in-memory order state per browser session.
function resolveSessionId(req, res) {
  const cookieHeader = req.headers.cookie || '';
  const existing = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(SESSION_COOKIE + '='));

  if (existing) {
    return existing.slice(SESSION_COOKIE.length + 1);
  }

  const newId = crypto.randomUUID();
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${newId}; HttpOnly; Path=/; SameSite=Lax`);
  return newId;
}

app.use(express.static(FRONTEND_DIR));
app.use(express.json());

app.post('/api/chat', async (req, res) => {
  const { message, conversationHistory } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'The "message" field is required.' });
  }

  // Resolve (or create) this browser's session id; tools.js uses it to read
  // and update this session's in-memory order state.
  const sessionId = resolveSessionId(req, res);

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];

  try {
    const workingMessages = [...history, { role: 'user', content: message }];
    let replyText = null;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: workingMessages,
      });

      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');

        // Record Claude's tool-call turn, then run each requested tool and
        // feed the results back so it can produce a final answer.
        workingMessages.push({ role: 'assistant', content: response.content });

        const toolResultBlocks = toolUseBlocks.map((block) => {
          let result;
          try {
            result = executeTool(block.name, block.input, sessionId);
          } catch (toolErr) {
            result = { error: toolErr.message };
          }
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          };
        });

        workingMessages.push({ role: 'user', content: toolResultBlocks });
        continue;
      }

      replyText =
        response?.content?.find((block) => block.type === 'text')?.text ||
        "Sorry, I didn't quite catch that — could you rephrase?";
      break;
    }

    if (replyText === null) {
      replyText = "Sorry, that took more steps than expected — could you try asking again?";
    }

    return res.status(200).json({
      reply: replyText,
      conversationHistory: [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: replyText },
      ],
    });
  } catch (err) {
    console.error('CafeBot chat error:', err && err.message ? err.message : err);

    return res.status(200).json({
      reply:
        "Sorry, I'm having a little trouble connecting to CafeBot's brain right now. Please try again in a moment, or feel free to ask our staff for help!",
      conversationHistory: history,
    });
  }
});

// Staff dashboard API — reads/updates data/orders.json directly. No
// authentication yet (see README.md notes); fine for local development only.
app.get('/api/staff/orders', (req, res) => {
  try {
    const orders = listOrders();
    return res.status(200).json({ orders });
  } catch (err) {
    console.error('CafeBot staff orders list error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Could not load orders.' });
  }
});

app.post('/api/staff/orders/:orderId/status', (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body || {};

  if (!status || typeof status !== 'string') {
    return res.status(400).json({ error: 'The "status" field is required.' });
  }

  try {
    const result = updateOrderStatus(orderId, status);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    return res.status(200).json({ order: result.order });
  } catch (err) {
    console.error('CafeBot staff status update error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Could not update order status.' });
  }
});

app.listen(PORT, () => {
  console.log(`CafeBot server running at http://localhost:${PORT}`);
});
