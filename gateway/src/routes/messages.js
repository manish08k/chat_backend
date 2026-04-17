'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/messages/:conversationId?before=<msg_id>&limit=50 ───────────────
router.get('/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
  const before = req.query.before || null;

  try {
    // Verify membership
    const membership = await pool.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, req.user.id]
    );
    if (membership.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    let query;
    let params;

    if (before) {
      // Cursor: return messages older than the given message id
      query = `
        SELECT m.id, m.conversation_id, m.sender_id, m.content, m.type,
               m.media_url, m.reply_to, m.client_msg_id, m.status,
               m.created_at, m.updated_at,
               u.username AS sender_username
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1
          AND m.deleted_at IS NULL
          AND m.created_at < (SELECT created_at FROM messages WHERE id = $2)
        ORDER BY m.created_at DESC
        LIMIT $3
      `;
      params = [conversationId, before, limit];
    } else {
      query = `
        SELECT m.id, m.conversation_id, m.sender_id, m.content, m.type,
               m.media_url, m.reply_to, m.client_msg_id, m.status,
               m.created_at, m.updated_at,
               u.username AS sender_username
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1
          AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT $2
      `;
      params = [conversationId, limit];
    }

    const { rows } = await pool.query(query, params);
    // Return oldest-first for client rendering
    const messages = rows.reverse();

    const nextCursor = messages.length === limit ? messages[0].id : null;

    return res.json({ messages, next_cursor: nextCursor });
  } catch (err) {
    console.error('[Messages] history error:', err);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

module.exports = router;
