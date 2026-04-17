'use strict';

const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const PUSH_URL = process.env.PUSH_SERVICE_URL || 'http://message-service:6000/push';

/**
 * MessageHandler
 *
 * Handles all business logic for incoming WebSocket events:
 *   - message.send  → persist, fan-out via Redis pub/sub, queue offline
 *   - message.read  → upsert receipt, notify sender
 *   - typing.start/stop → fan-out to conversation members
 *   - flushOfflineQueue → on reconnect, drain and deliver queued messages
 */
class MessageHandler {
  /**
   * @param {import('ioredis').Redis} redisPub
   * @param {import('./ConnectionManager')} connManager
   * @param {import('pg').Pool} pool
   * @param {string} instanceId
   */
  constructor(redisPub, connManager, pool, instanceId) {
    this.redis       = redisPub;
    this.connManager = connManager;
    this.pool        = pool;
    this.instanceId  = instanceId;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // message.send
  // ─────────────────────────────────────────────────────────────────────────
  async handleSend(sender, event) {
    const { conversation_id, content, message_type = 'text', media_url, reply_to, client_msg_id } = event;

    if (!conversation_id || !content) {
      this._sendToUser(sender.id, { type: 'error', message: 'conversation_id and content are required' });
      return;
    }

    // Verify sender is a conversation member
    const membership = await this.pool.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversation_id, sender.id]
    );
    console.log("[DEBUG] membership check:", conversation_id, sender.id, membership.rows.length);
    if (membership.rows.length === 0) {
      this._sendToUser(sender.id, { type: 'error', message: 'Not a member of this conversation' });
      return;
    }

    // Persist — ON CONFLICT handles duplicate client_msg_id safely
    let message;
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO messages
           (conversation_id, sender_id, content, type, media_url, reply_to, client_msg_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (conversation_id, client_msg_id)
           DO UPDATE SET updated_at = messages.updated_at   -- no-op update to return existing row
         RETURNING *`,
        [conversation_id, sender.id, content, message_type, media_url || null, reply_to || null, client_msg_id || uuidv4()]
      );
      message = rows[0];
    } catch (err) {
      console.error('[MessageHandler] persist error:', err);
      this._sendToUser(sender.id, { type: 'error', message: 'Failed to save message' });
      return;
    }

    // Ack back to sender
    this._sendToUser(sender.id, {
      type:          'message.ack',
      client_msg_id: client_msg_id,
      message_id:    message.id,
      status:        message.status,
      created_at:    message.created_at,
    });

    // Fetch all conversation members
    const { rows: memberRows } = await this.pool.query(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
      [conversation_id]
    );
    const recipientIds = memberRows
      .map((r) => r.user_id)
      .filter((id) => id !== sender.id);

    // Build the new-message event payload
    const newMessageEvent = {
      type:    'message.new',
      message: {
        ...message,
        sender_username: sender.username,
      },
    };

    // Fan-out: publish to Redis so ALL instances deliver to online recipients
    const onlineRecipients  = [];
    const offlineRecipients = [];

    await Promise.all(
      recipientIds.map(async (userId) => {
        const online = await this.connManager.isOnline(userId);
        if (online) onlineRecipients.push(userId);
        else         offlineRecipients.push(userId);
      })
    );

    if (onlineRecipients.length > 0) {
      await this.redis.publish(
        'chat:broadcast',
        JSON.stringify({ recipient_ids: onlineRecipients, event: newMessageEvent })
      );
    }

    // Queue offline messages and trigger push notifications
    if (offlineRecipients.length > 0) {
      // Write to offline_queue in DB
      await Promise.all(
        offlineRecipients.map((userId) =>
          this.pool.query(
            'INSERT INTO offline_queue (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [userId, message.id]
          )
        )
      );

      // Fire-and-forget push notification
      this._triggerPush(offlineRecipients, message, sender.username).catch((err) =>
        console.error('[MessageHandler] push error:', err.message)
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // message.read
  // ─────────────────────────────────────────────────────────────────────────
  async handleRead(reader, event) {
    const { conversation_id, message_id } = event;
    if (!conversation_id || !message_id) return;

    try {
      // Upsert receipt
      await this.pool.query(
        `INSERT INTO message_receipts (message_id, user_id, status)
         VALUES ($1, $2, 'read')
         ON CONFLICT (message_id, user_id)
           DO UPDATE SET status = 'read', updated_at = NOW()`,
        [message_id, reader.id]
      );

      // Update message status if all members have read
      await this.pool.query(
        `UPDATE messages SET status = 'read'
         WHERE id = $1 AND status != 'read'`,
        [message_id]
      );

      // Notify the original sender
      const { rows } = await this.pool.query('SELECT sender_id FROM messages WHERE id = $1', [message_id]);
      if (rows.length > 0) {
        const readEvent = {
          type:            'message.read',
          message_id,
          reader_id:       reader.id,
          conversation_id,
        };
        // Publish so the sender receives it regardless of which instance they are on
        await this.redis.publish(
          'chat:broadcast',
          JSON.stringify({ recipient_ids: [rows[0].sender_id], event: readEvent })
        );
      }
    } catch (err) {
      console.error('[MessageHandler] read receipt error:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // typing.start / typing.stop
  // ─────────────────────────────────────────────────────────────────────────
  async handleTyping(user, event) {
    const { conversation_id } = event;
    if (!conversation_id) return;

    const { rows: memberRows } = await this.pool.query(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
      [conversation_id]
    );
    const otherMembers = memberRows
      .map((r) => r.user_id)
      .filter((id) => id !== user.id);

    const typingEvent = {
      type:            event.type,
      conversation_id,
      user_id:         user.id,
      username:        user.username,
    };

    await this.redis.publish(
      'chat:broadcast',
      JSON.stringify({ recipient_ids: otherMembers, event: typingEvent })
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Offline queue flush — called on user reconnect
  // ─────────────────────────────────────────────────────────────────────────
  async flushOfflineQueue(userId) {
    try {
      const { rows } = await this.pool.query(
        `SELECT oq.id AS queue_id, m.*,
                u.username AS sender_username
         FROM offline_queue oq
         JOIN messages m ON m.id = oq.message_id
         JOIN users u ON u.id = m.sender_id
         WHERE oq.user_id = $1
         ORDER BY oq.created_at ASC`,
        [userId]
      );

      if (rows.length === 0) return;

      // Deliver each queued message to the now-connected user
      for (const row of rows) {
        this._sendToUser(userId, {
          type:    'message.new',
          message: row,
        });
      }

      // Purge delivered queue entries
      const queueIds = rows.map((r) => r.queue_id);
      await this.pool.query(
        `DELETE FROM offline_queue WHERE id = ANY($1::bigint[])`,
        [queueIds]
      );
    } catch (err) {
      console.error('[MessageHandler] flushOfflineQueue error:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────

  _sendToUser(userId, event) {
    return this.connManager.sendToUser(userId, event);
  }

  async _triggerPush(userIds, message, senderUsername) {
    await fetch(PUSH_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        user_ids:   userIds,
        message_id: message.id,
        sender:     senderUsername,
        content:    message.content,
      }),
    });
  }
}

module.exports = MessageHandler;
