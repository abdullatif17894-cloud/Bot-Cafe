// Vercel serverless entry point.
// Vercel automatically turns any file inside /api into a serverless
// function. This one simply re-exports the existing Express app from
// backend/server.js — no app logic lives here, so local `npm start`
// (which runs backend/server.js directly) keeps working exactly as before.
module.exports = require('../backend/server');
