/**
 * ChatClient — browser/Node WebSocket client for the chat backend.
 * Usage:
 *   const client = new ChatClient({ url: 'ws://localhost/ws', token: '<jwt>' });
 *   client.on('message.new', (msg) => console.log(msg));
 *   await client.connect();
 *   client.sendMessage({ conversation_id, content: 'Hello' });
 */

class ChatClient extends EventTarget {
  constructor({ url, token, reconnectDelay = 3000, maxReconnects = 10 }) {
    super();
    this.url = `${url}?token=${token}`;
    this.reconnectDelay = reconnectDelay;
    this.maxReconnects = maxReconnects;
    this.ws = null;
    this.reconnectCount = 0;
    this.alive = false;
    this._pingInterval = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log("[ChatClient] Connected");
        this.reconnectCount = 0;
        this.alive = true;
        this._startPing();
        this.dispatchEvent(new Event("connected"));
        resolve();
      };

      this.ws.onmessage = ({ data }) => {
        let event;
        try { event = JSON.parse(data); } catch { return; }
        this.dispatchEvent(new CustomEvent(event.type, { detail: event }));
        this.dispatchEvent(new CustomEvent("*", { detail: event }));
      };

      this.ws.onclose = (e) => {
        this._stopPing();
        this.alive = false;
        this.dispatchEvent(new CustomEvent("disconnected", { detail: { code: e.code } }));
        if (e.code !== 4001 && this.reconnectCount < this.maxReconnects) {
          this.reconnectCount++;
          console.log(`[ChatClient] Reconnecting (${this.reconnectCount})...`);
          setTimeout(() => this.connect(), this.reconnectDelay);
        }
      };

      this.ws.onerror = (err) => {
        this.dispatchEvent(new CustomEvent("error", { detail: err }));
        reject(err);
      };
    });
  }

  disconnect() {
    this.maxReconnects = 0;
    this.ws?.close();
  }

  on(eventType, handler) {
    this.addEventListener(eventType, (e) => handler(e.detail));
  }

  _send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      console.warn("[ChatClient] Not connected — message dropped");
    }
  }

  sendMessage({ conversation_id, content, type = "text", media_url, reply_to }) {
    const client_msg_id = crypto.randomUUID();
    this._send({ type: "message.send", conversation_id, content, message_type: type, media_url, reply_to, client_msg_id });
    return client_msg_id;
  }

  sendRead({ conversation_id, message_id }) {
    this._send({ type: "message.read", conversation_id, message_id });
  }

  sendTypingStart(conversation_id) {
    this._send({ type: "typing.start", conversation_id });
  }

  sendTypingStop(conversation_id) {
    this._send({ type: "typing.stop", conversation_id });
  }

  _startPing() {
    this._pingInterval = setInterval(() => {
      this._send({ type: "ping" });
    }, 25_000);
  }

  _stopPing() {
    clearInterval(this._pingInterval);
  }
}

if (typeof module !== "undefined") module.exports = ChatClient;
