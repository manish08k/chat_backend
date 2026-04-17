'use strict';

const http         = require('http');
const { WebSocketServer } = require('ws');
const jwt          = require('jsonwebtoken');
const Redis        = require('ioredis');
const ConnectionManager = require('./ConnectionManager');
const MessageHandler    = require('./MessageHandler');
const { pool }     = require('./db');

const PORT        = parseInt(process.env.PORT || '5000', 10);
const INSTANCE_ID = process.env.INSTANCE_ID || `chat-${process.pid}`;
const JWT_SECRET  = process.env.JWT_SECRET;
const REDIS_URL   = process.env.REDIS_URL;

if (!JWT_SECRET)  throw new Error('JWT_SECRET is required');
if (!REDIS_URL)   throw new Error('REDIS_URL is required');

// ── Redis clients (pub and sub must be separate connections) ─────────────────
const redisPub = new Redis(REDIS_URL, { lazyConnect: true });
const redisSub = new Redis(REDIS_URL, { lazyConnect: true });

redisPub.on('error', (err) => console.error('[Redis pub]', err.message));
redisSub.on('error', (err) => console.error('[Redis sub]', err.message));

// ── HTTP server (also serves health endpoint) ─────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', instance: INSTANCE_ID }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

const connManager    = new ConnectionManager(redisPub, INSTANCE_ID);
const msgHandler     = new MessageHandler(redisPub, connManager, pool, INSTANCE_ID);

/** Parse + verify the JWT from the query string on upgrade. */
function authenticateConnection(req) {
  try {
    const url    = new URL(req.url, 'http://localhost');
    const token  = url.searchParams.get('token');
    if (!token) return null;
    const payload = jwt.verify(token, JWT_SECRET);
    return { id: payload.sub, username: payload.username };
  } catch {
    return null;
  }
}

wss.on('connection', async (ws, req) => {
  const user = authenticateConnection(req);
  if (!user) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log(`[ChatService] ${user.username} connected (${INSTANCE_ID})`);

  await connManager.register(user.id, ws);
  await msgHandler.flushOfflineQueue(user.id);

  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
    // Refresh presence TTL on every pong
    connManager.refreshPresence(user.id).catch(() => {});
  });

  ws.on('message', async (raw) => {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    try {
      switch (event.type) {
        case 'message.send':
          await msgHandler.handleSend(user, event);
          break;
        case 'message.read':
          await msgHandler.handleRead(user, event);
          break;
        case 'typing.start':
        case 'typing.stop':
          await msgHandler.handleTyping(user, event);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', message: `Unknown event type: ${event.type}` }));
      }
    } catch (err) {
      console.error('[ChatService] handler error:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Server error processing event' }));
    }
  });

  ws.on('close', async () => {
    console.log(`[ChatService] ${user.username} disconnected`);
    await connManager.unregister(user.id);
  });

  ws.on('error', (err) => {
    console.error(`[ChatService] WS error for ${user.username}:`, err.message);
  });
});

// ── Heartbeat: ping all sockets every 30s, drop dead ones ────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

// ── Redis broadcast subscriber ────────────────────────────────────────────────
async function startRedisSubscriber() {
  await redisSub.connect();
  await redisSub.subscribe('chat:broadcast', (err) => {
    if (err) console.error('[Redis sub] subscribe error:', err);
  });

  redisSub.on('message', (_channel, raw) => {
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return;
    }
    // Deliver to any locally-connected recipient on this instance
    if (envelope.recipient_ids) {
      for (const recipientId of envelope.recipient_ids) {
        connManager.sendToUser(recipientId, envelope.event);
      }
    }
  });
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  await redisPub.connect();
  await startRedisSubscriber();

  server.listen(PORT, () => {
    console.log(`[ChatService] ${INSTANCE_ID} listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('[ChatService] Fatal startup error:', err);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown() {
  console.log('[ChatService] Shutting down...');
  clearInterval(heartbeat);
  wss.close();
  await redisPub.quit();
  await redisSub.quit();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
