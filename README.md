# CafeBot

CafeBot is a café web app with an AI ordering assistant. It serves a
frontend site with a chat widget backed by an Express server that uses the
Claude Messages API (tool use) to help customers browse the menu, build an
order, and check out — plus a minimal staff dashboard for fulfilling orders.

## Structure

```
CafeBot/
├── frontend/     # index.html, styles.css, app.js, staff.html
├── backend/      # server.js (Express app + /api/chat), tools.js, orderState.js, ordersStore.js
├── data/         # menu.json, promotions.json, pricing.json, orders.json
├── prompts/      # system-prompt.md — CafeBot's persona/rules
└── README.md
```

## Setup

**Requirements:** Node.js 18+ and an Anthropic API key.

1. Install dependencies:
   ```
   cd backend
   npm install
   ```
2. Create a `.env` file in the project root (same level as this README) —
   copy `.env.example` and fill in your key:
   ```
   cp .env.example .env
   ```
   Then edit `.env`:
   ```
   ANTHROPIC_API_KEY=your_actual_key_here
   PORT=3000
   ```
   `.env` is git-ignored and must never be committed. `PORT` is optional and
   defaults to `3000` if omitted.
3. Start the server:
   ```
   npm start
   ```
   (run from the `backend/` directory — `npm start` runs `node server.js`)
4. Open `http://localhost:3000` in a browser for the customer site and chat
   widget, or `http://localhost:3000/staff.html` for the staff dashboard.

## Notes

- `data/orders.json` is temporary, file-based order storage for local
  development only (JSON has no native comment syntax, so this note lives
  here instead). Revisit before production — replace with a real database
  before this goes live.
- `data/pricing.json` holds a single flat `taxRate` and flat `deliveryFee`
  for simplicity. Revisit before production — real tax rates vary by
  jurisdiction/order type, and delivery fees are often distance- or
  zone-based rather than flat.
- The staff dashboard (`frontend/staff.html`, `/api/staff/*`) has no
  authentication — anyone who can reach the server can view and update
  orders. Fine for local development only; add real staff login before
  this goes live.
