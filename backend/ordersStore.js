// NOTE: Orders are stored via ordersStorage.js — Upstash Redis when
// connected (see ordersStorage.js for details), or data/orders.json
// locally. This module adds the staff-dashboard-specific logic (advancing
// an order's status) on top of that shared read/write.
//
// Kept separate from backend/tools.js's own order-saving logic
// (finalizeOrder), so the customer-facing ordering tools are not touched by
// this feature — this module only reads the same data and, for status
// updates, rewrites it.

const { readOrders, writeOrders } = require('./ordersStorage');

const STATUS_FLOW = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];

// Maps each status to the one and only status it can advance to next.
const NEXT_STATUS = {
  NEW: 'PREPARING',
  PREPARING: 'READY',
  READY: 'COMPLETED',
  COMPLETED: null,
};

async function listOrders() {
  return readOrders();
}

// Advances an order exactly one step (e.g. NEW -> PREPARING). Rejects
// skipping steps, moving backwards, or an already-COMPLETED order — the
// dashboard only ever offers the single valid next status as a button, and
// this is the server-side check behind that.
async function updateOrderStatus(orderId, newStatus) {
  if (!orderId || typeof orderId !== 'string') {
    return { success: false, error: 'orderId is required.' };
  }
  if (!STATUS_FLOW.includes(newStatus)) {
    return { success: false, error: `"${newStatus}" is not a valid status.` };
  }

  const orders = await readOrders();
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
  await writeOrders(orders);

  return { success: true, order };
}

module.exports = { listOrders, updateOrderStatus, STATUS_FLOW, NEXT_STATUS };
