// routes/config.js  — add this to your Express app
// Serves SF credentials from .env to the admin frontend (server-side only)

const express = require('express');
const router = express.Router();

// GET /api/config
router.get('/', (req, res) => {
    res.json({
        sfApiKey:  process.env.SF_API_KEY  || '',
        sfGroupId: process.env.SF_GROUP_ID || '',
    });
});

module.exports = router;

// ─────────────────────────────────────────
// In your main server.js / app.js, mount it:
//
//   const configRoute = require('./routes/config');
//   app.use('/api/config', configRoute);
//
// ─────────────────────────────────────────
// In your .env file add:
//
//   SF_API_KEY=your_actual_stayflexi_api_key_here
//   SF_GROUP_ID=your_group_id_here
//
// Make sure you have dotenv loaded at top of server.js:
//   require('dotenv').config();
// ─────────────────────────────────────────
