'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/users/me ────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, phone, email, push_token, last_seen, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('[Users] /me error:', err);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── GET /api/users/search?q=<query> ─────────────────────────────────────────
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, username, last_seen
       FROM users
       WHERE username ILIKE $1
         AND id != $2
       ORDER BY username
       LIMIT 20`,
      [`%${q}%`, req.user.id]
    );
    return res.json(rows);
  } catch (err) {
    console.error('[Users] search error:', err);
    return res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
