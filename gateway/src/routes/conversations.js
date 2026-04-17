'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── POST /api/conversations ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { type, member_ids, name } = req.body;

  if (!type || !['direct', 'group'].includes(type)) {
    return res.status(400).json({ error: 'type must be "direct" or "group"' });
  }
  if (!Array.isArray(member_ids) || member_ids.length === 0) {
    return res.status(400).json({ error: 'member_ids array is required' });
  }
  if (type === 'group' && !name) {
    return res.status(400).json({ error: 'name is required for group conversations' });
  }

  // Deduplicate and include the requesting user
  const allMembers = [...new Set([req.user.id, ...member_ids])];

  if (type === 'direct') {
    if (allMembers.length !== 2) {
      return res.status(400).json({ error: 'Direct conversations require exactly one other member' });
    }

    // Return existing direct conversation if it already exists
    const existing = await pool.query(
      `SELECT c.id FROM conversations c
       JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = $1
       JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = $2
       WHERE c.type = 'direct'
       LIMIT 1`,
      [allMembers[0], allMembers[1]]
    );
    if (existing.rows.length > 0) {
      const { rows } = await pool.query('SELECT * FROM conversations WHERE id = $1', [existing.rows[0].id]);
      return res.json(rows[0]);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: convRows } = await client.query(
      `INSERT INTO conversations (type, name, created_by)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [type, name || null, req.user.id]
    );
    const conv = convRows[0];

    // Insert all members
    for (const userId of allMembers) {
      const role = userId === req.user.id ? 'admin' : 'member';
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, $3)`,
        [conv.id, userId, role]
      );
    }

    await client.query('COMMIT');
    return res.status(201).json(conv);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Conversations] create error:', err);
    return res.status(500).json({ error: 'Failed to create conversation' });
  } finally {
    client.release();
  }
});

// ── GET /api/conversations ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.type, c.name, c.created_by, c.created_at,
              m.content      AS last_message,
              m.created_at   AS last_message_at,
              m.sender_id    AS last_sender_id,
              cm.last_read_at
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
       LEFT JOIN LATERAL (
         SELECT content, created_at, sender_id
         FROM messages
         WHERE conversation_id = c.id AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1
       ) m ON TRUE
       ORDER BY COALESCE(m.created_at, c.created_at) DESC`,
      [req.user.id]
    );
    return res.json(rows);
  } catch (err) {
    console.error('[Conversations] list error:', err);
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ── GET /api/conversations/:id ───────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Verify membership
    const membership = await pool.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (membership.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const { rows: convRows } = await pool.query(
      'SELECT * FROM conversations WHERE id = $1',
      [id]
    );
    const { rows: members } = await pool.query(
      `SELECT u.id, u.username, u.last_seen, cm.role, cm.joined_at, cm.last_read_at
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = $1`,
      [id]
    );

    return res.json({ ...convRows[0], members });
  } catch (err) {
    console.error('[Conversations] get error:', err);
    return res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

module.exports = router;
