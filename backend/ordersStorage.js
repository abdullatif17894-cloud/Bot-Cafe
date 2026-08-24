// Reads/writes the orders array.
//
// When Upstash Redis is connected (KV_REST_API_URL / KV_REST_API_TOKEN env
// vars — added automatically by the Vercel + Upstash integration), orders
// are stored in Redis under one key. This persists reliably across
// serverless invocations, unlike a file on disk on Vercel.
//
// Locally, and as a fallback if Redis isn't configured, orders are stored
// in data/orders.json exactly as before — nothing changes for local dev.

const fs = require('fs');
const path = require('path');

const BUNDLED_ORDERS_PATH = path.join(__dirname, '..', 'data', 'orders.json');
const REDIS_KEY = 'cafebot:orders';

const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

async function readOrders() {
  if (useRedis) {
    const res = await fetch(`${REDIS_URL}/get/${REDIS_KEY}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const data = await res.json();
    if (!data.result) return [];
    return JSON.parse(data.result);
  }

  const raw = fs.readFileSync(BUNDLED_ORDERS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function writeOrders(orders) {
  if (useRedis) {
    await fetch(`${REDIS_URL}/set/${REDIS_KEY}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      body: JSON.stringify(orders),
    });
    return;
  }

  fs.writeFileSync(BUNDLED_ORDERS_PATH, JSON.stringify(orders, null, 2) + '\n', 'utf8');
}

module.exports = { readOrders, writeOrders };
