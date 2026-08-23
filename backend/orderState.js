// In-memory, session-based order state.
// No database — state lives only for as long as the server process runs
// and is lost on restart. Fine for local development; revisit before
// production (see README.md notes).

/**
 * Shape of a single order:
 * {
 *   items: [{ itemId, name, quantity, size, options: [], unitPrice, lineTotal }],
 *   orderType: null | 'pickup' | 'dine-in' | 'delivery',
 *   customer: { name: null, phone: null, email: null },
 *   pickupTime: null | string,
 *   delivery: { address: null, apartmentUnit: null, instructions: null, addressConfirmed: false },
 *   discount: { promotionId: null, amount: 0 },
 *   total: 0,
 *   confirmed: false,
 *   status: 'draft' | 'confirmed' | 'cancelled',
 *   recommendations: { declined: [itemId, ...] },
 * }
 */
function createDefaultOrder() {
  return {
    items: [],
    orderType: null,
    customer: {
      name: null,
      phone: null,
      email: null,
    },
    pickupTime: null,
    delivery: {
      address: null,
      apartmentUnit: null,
      instructions: null,
      addressConfirmed: false,
    },
    discount: {
      promotionId: null,
      amount: 0,
    },
    total: 0,
    confirmed: false,
    status: 'draft',
    recommendations: {
      declined: [],
    },
  };
}

// sessionId -> order state. In-memory only, per the note above.
const sessions = new Map();

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createDefaultOrder());
  }
  return sessions.get(sessionId);
}

function updateSession(sessionId, updates) {
  const current = getOrCreateSession(sessionId);
  const updated = Object.assign({}, current, updates);
  sessions.set(sessionId, updated);
  return updated;
}

function resetSession(sessionId) {
  const fresh = createDefaultOrder();
  sessions.set(sessionId, fresh);
  return fresh;
}

module.exports = {
  createDefaultOrder,
  getOrCreateSession,
  updateSession,
  resetSession,
  sessions,
};
