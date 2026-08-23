// NOTE: File-based storage (reading/writing data/orders.json) is for
// local development and demo purposes only. It relies on a writable,
// persistent local filesystem. Vercel's serverless functions run in an
// ephemeral environment and do not guarantee that file writes persist
// across invocations or deployments — this approach must be replaced with
// a real database before deploying this app to Vercel or any other
// serverless platform.
//
// Read/update access to data/orders.json for the staff dashboard.
//
// Kept separate from backend/tools.js's own order-saving logic
// (finalizeOrder), so the customer-facing ordering tools are not touched by
// this feature — this module only reads the same file and, for status
// updates, rewrites it.

const fs = require('fs');
const path = require('path');

const ORDERS_PATH = path.join(__dirname, '..', 'data', 'orders.json');

const STATUS_FLOW = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];

// Maps each status to the one and only status it can advance to next.
const NEXT_STATUS = {
  NEW: 'PREPARING',
  PREPARING: 'READY',
  READY: 'COMPLETED',
  COMPLETED: null,
};

function readOrders() {
  const raw = fs.readFileSync(ORDERS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function writeOrders(orders) {
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2) + '\n', 'utf8');
}

function listOrders() {
  return readOrders();
}

// Advances an order exactly one step (e.g. NEW -> PREPARING). Rejects
// skipping steps, moving backwards, or an already-COMPLETED order — the
// dashboard only ever offers the single valid next status as a button, and
// this is the server-side check behind that.
function updateOrderStatus(orderId, newStatus) {
  if (!orderId || typeof orderId !== 'string') {
    return { success: false, error: 'orderId is required.' };
  }
  if (!STATUS_FLOW.includes(newStatus)) {
    return { success: false, error: `"${newStatus}" is not a valid status.` };
  }

  const orders = readOrders();
  const order = orders.find((o) => o.orderId === orderId);
  if (!order) {
    return { success: false, error: `No order found with id "${orderId}".` };
  }

  const expectedNext = NEXT_STATUS[order.status];
  if (!expectedNext || expectedNext !== newStatus) {
    return {
      success: false,
      error: expectedNext
        ? `Order ${orderId} is "${order.status}" and can only move to "${expectedNext}".`
        : `Order ${orderId} is already "${order.status}" and cannot move further.`,
    };
  }

  order.status = newStatus;
  writeOrders(orders);

  return { success: true, order };
}

module.exports = { listOrders, updateOrderStatus, STATUS_FLOW, NEXT_STATUS };
