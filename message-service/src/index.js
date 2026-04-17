'use strict';

const express = require('express');
const { pool } = require('./db');
const PushNotifier = require('./PushNotifier');

const app = express();
app.use(express.json({ limit: '1mb' }));

const notifier = new PushNotifier();

// ── POST /push ───────────────────────────────────────────────────────────────
// Called by chat-service when recipients are offline.
// Body: { user_ids, message_id, sender, content }
app.post('/push', async (req, res) => {
  const { user_ids, message_id, sender, content } = req.body;
  if (!Array.isArray(user_ids) || user_ids.length === 0 || !message_id) {
    return res.status(400).json({ error: 'user_ids array and message_id are required' });
  }

  try {
    // Fetch push tokens for all offline users
    const { rows } = await pool.query(
      'SELECT id, push_token FROM users WHERE id = ANY($1::uuid[]) AND push_token IS NOT NULL',
      [user_ids]
    );

    if (rows.length === 0) {
      return res.json({ ok: true, sent: 0, reason: 'no push tokens' });
    }

    const tokens = rows.map((r) => r.push_token);
    const sent   = await notifier.multicast(tokens, {
      title: sender,
      body:  content?.slice(0, 200) ?? '📨 New message',
      data:  { message_id },
    });

    return res.json({ ok: true, sent });
  } catch (err) {
    console.error('[MessageService] /push error:', err);
    return res.status(500).json({ error: 'Push failed' });
  }
});

// ── POST /retry-offline ───────────────────────────────────────────────────────
// Manual or scheduled retry for undelivered offline queue entries.
// Body: { user_id }
app.post('/retry-offline', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  try {
    const { rows } = await pool.query(
      `SELECT oq.message_id, m.content, m.sender_id, u.push_token, u.username AS sender_username
       FROM offline_queue oq
       JOIN messages m ON m.id = oq.message_id
       JOIN users u ON u.id = m.sender_id
       JOIN users recipient ON recipient.id = oq.user_id
       WHERE oq.user_id = $1 AND recipient.push_token IS NOT NULL
       ORDER BY oq.created_at ASC
       LIMIT 50`,
      [user_id]
    );

    if (rows.length === 0) {
      return res.json({ ok: true, sent: 0 });
    }

    // Group by unique push tokens
    const tokenSet = new Set();
    let sent = 0;

    for (const row of rows) {
      if (tokenSet.has(row.push_token)) continue;
      tokenSet.add(row.push_token);
      await notifier.unicast(row.push_token, {
        title: row.sender_username,
        body:  row.content?.slice(0, 200) ?? '📨 You have offline messages',
        data:  { message_id: row.message_id },
      });
      sent++;
    }

    return res.json({ ok: true, sent });
  } catch (err) {
    console.error('[MessageService] /retry-offline error:', err);
    return res.status(500).json({ error: 'Retry failed' });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'message-service' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '6000', 10);
app.listen(PORT, () => {
  console.log(`[MessageService] Listening on port ${PORT}`);
});

module.exports = app;
