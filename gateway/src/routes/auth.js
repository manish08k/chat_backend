'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const { pool } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 12;

// ── POST /api/auth/register ──────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { username, password, phone, email } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (typeof username !== 'string' || username.length < 3 || username.length > 64) {
    return res.status(400).json({ error: 'username must be 3–64 characters' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, phone, email)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, phone, email, created_at`,
      [username.trim().toLowerCase(), passwordHash, phone || null, email || null]
    );

    const user  = rows[0];
    const token = signToken(user);
    return res.status(201).json({ token, user });
  } catch (err) {
    if (err.code === '23505') {
      // Unique constraint violation
      const field = err.detail?.includes('username') ? 'username'
        : err.detail?.includes('phone') ? 'phone' : 'email';
      return res.status(409).json({ error: `${field} is already taken` });
    }
    console.error('[Auth] register error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username.trim().toLowerCase()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last_seen
    await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);

    const token = signToken(user);
    return res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('[Auth] login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/auth/push-token ────────────────────────────────────────────────
router.post('/push-token', requireAuth, async (req, res) => {
  const { push_token } = req.body;
  if (!push_token || typeof push_token !== 'string') {
    return res.status(400).json({ error: 'push_token is required' });
  }

  try {
    await pool.query('UPDATE users SET push_token = $1 WHERE id = $2', [push_token, req.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Auth] push-token error:', err);
    return res.status(500).json({ error: 'Failed to update push token' });
  }
});

module.exports = router;
