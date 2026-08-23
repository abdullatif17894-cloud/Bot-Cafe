// Resolves a writable path for the orders data file.
//
// Locally (npm start), this is simply the real data/orders.json file, so
// nothing changes for local development.
//
// On Vercel, the deployed bundle's filesystem is read-only except for
// /tmp — writing to data/orders.json there throws and breaks checkout.
// So on Vercel we copy the bundled orders.json into /tmp once per
// serverless instance and read/write there instead.
//
// NOTE: /tmp is per-instance and not guaranteed to persist or be shared
// across separate serverless invocations, so this does not make orders
// durable long-term storage on Vercel — see the note in ordersStore.js.
// It only prevents checkout from crashing. Replacing this with a real
// database is a separate, bigger upgrade.

const fs = require('fs');
const path = require('path');

const BUNDLED_ORDERS_PATH = path.join(__dirname, '..', 'data', 'orders.json');
const TMP_ORDERS_PATH = path.join('/tmp', 'cafebot-orders.json');

function getOrdersPath() {
  if (!process.env.VERCEL) {
    return BUNDLED_ORDERS_PATH;
  }

  if (!fs.existsSync(TMP_ORDERS_PATH)) {
    fs.copyFileSync(BUNDLED_ORDERS_PATH, TMP_ORDERS_PATH);
  }

  return TMP_ORDERS_PATH;
}

module.exports = { getOrdersPath };
