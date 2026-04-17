'use strict';

const PRESENCE_TTL = 90; // seconds

/**
 * ConnectionManager
 *
 * Maintains an in-memory map of userId → WebSocket for this instance
 * and manages Redis presence keys so other instances can check
 * whether a user is online (and on which instance).
 */
class ConnectionManager {
  /**
   * @param {import('ioredis').Redis} redis
   * @param {string} instanceId
   */
  constructor(redis, instanceId) {
    this.redis      = redis;
    this.instanceId = instanceId;
    /** @type {Map<string, import('ws').WebSocket>} */
    this.sockets    = new Map();
  }

  /**
   * Register a newly connected user.
   * Sets Redis presence key with TTL so other instances know this user is online.
   */
  async register(userId, ws) {
    this.sockets.set(userId, ws);
    await this.redis.setex(`user:online:${userId}`, PRESENCE_TTL, this.instanceId);
  }

  /**
   * Unregister a disconnected user.
   * Removes the Redis presence key only if it still points to THIS instance.
   */
  async unregister(userId) {
    this.sockets.delete(userId);
    // Only delete if our instance owns the key (avoid clobbering a reconnect on another instance)
    const owner = await this.redis.get(`user:online:${userId}`);
    if (owner === this.instanceId) {
      await this.redis.del(`user:online:${userId}`);
    }
  }

  /**
   * Refresh the presence TTL — called on every heartbeat pong.
   */
  async refreshPresence(userId) {
    await this.redis.expire(`user:online:${userId}`, PRESENCE_TTL);
  }

  /**
   * Check if a user is online (has a Redis presence key).
   * @returns {Promise<boolean>}
   */
  async isOnline(userId) {
    const result = await this.redis.exists(`user:online:${userId}`);
    return result === 1;
  }

  /**
   * Send a JSON event to a locally-connected user.
   * @returns {boolean} whether the message was delivered locally
   */
  sendToUser(userId, event) {
    const ws = this.sockets.get(userId);
    if (!ws) return false;

    const { OPEN } = require('ws').WebSocket;
    if (ws.readyState !== OPEN) return false;

    try {
      ws.send(JSON.stringify(event));
      return true;
    } catch (err) {
      console.error(`[ConnectionManager] send error to ${userId}:`, err.message);
      return false;
    }
  }

  /**
   * Broadcast a JSON event to all locally-connected users in a list.
   * @param {string[]} userIds
   * @param {object} event
   */
  broadcastToUsers(userIds, event) {
    for (const userId of userIds) {
      this.sendToUser(userId, event);
    }
  }

  /**
   * Returns an array of userIds currently registered on THIS instance.
   */
  localUserIds() {
    return [...this.sockets.keys()];
  }
}

module.exports = ConnectionManager;
