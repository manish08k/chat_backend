'use strict';

const fetch = require('node-fetch');

const FCM_URL = 'https://fcm.googleapis.com/fcm/send';

/**
 * PushNotifier
 *
 * Thin wrapper around Firebase Cloud Messaging (FCM) Legacy HTTP API.
 * For production, consider migrating to FCM v1 (OAuth2 + HTTP/2).
 */
class PushNotifier {
  constructor() {
    this.serverKey = process.env.FCM_SERVER_KEY || '';
    if (!this.serverKey) {
      console.warn('[PushNotifier] FCM_SERVER_KEY not set — push notifications disabled');
    }
  }

  /**
   * Send a push notification to a single device token.
   * @param {string} token  FCM registration token
   * @param {{ title: string, body: string, data?: object }} notification
   * @returns {Promise<boolean>} true if FCM accepted
   */
  async unicast(token, { title, body, data = {} }) {
    if (!this.serverKey) return false;

    try {
      const res = await fetch(FCM_URL, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          Authorization:   `key=${this.serverKey}`,
        },
        body: JSON.stringify({
          to:           token,
          notification: { title, body, sound: 'default' },
          data,
          priority:     'high',
        }),
      });

      const json = await res.json();
      if (json.failure > 0) {
        console.warn('[PushNotifier] FCM unicast failure:', json.results?.[0]);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[PushNotifier] unicast error:', err.message);
      return false;
    }
  }

  /**
   * Send a push notification to up to 1,000 device tokens (FCM multicast).
   * Automatically batches if tokens.length > 1000.
   * @param {string[]} tokens
   * @param {{ title: string, body: string, data?: object }} notification
   * @returns {Promise<number>} number of successfully accepted tokens
   */
  async multicast(tokens, { title, body, data = {} }) {
    if (!this.serverKey || tokens.length === 0) return 0;

    const BATCH_SIZE = 1000;
    let totalSuccess = 0;

    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batch = tokens.slice(i, i + BATCH_SIZE);
      try {
        const res = await fetch(FCM_URL, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization:  `key=${this.serverKey}`,
          },
          body: JSON.stringify({
            registration_ids: batch,
            notification:     { title, body, sound: 'default' },
            data,
            priority:         'high',
          }),
        });

        const json = await res.json();
        totalSuccess += (json.success || 0);

        if (json.failure > 0) {
          console.warn(`[PushNotifier] multicast: ${json.failure} failures in batch`);
        }
      } catch (err) {
        console.error('[PushNotifier] multicast batch error:', err.message);
      }
    }

    return totalSuccess;
  }
}

module.exports = PushNotifier;
