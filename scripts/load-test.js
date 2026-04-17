#!/usr/bin/env node
/**
 * Load test — measures WebSocket throughput.
 * node scripts/load-test.js
 */
const WebSocket = require("ws");
const fetch = require("node-fetch");

const BASE = process.env.BASE_URL || "http://localhost";
const WS_BASE = process.env.WS_URL || "ws://localhost";
const CONCURRENT = parseInt(process.env.CONCURRENT || "50");
const MESSAGES_PER_CLIENT = parseInt(process.env.MESSAGES || "20");

async function api(path, method, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function wsConnect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?token=${token}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function runWorker(index) {
  const u1 = `loadtest_${Date.now()}_${index * 2}`;
  const u2 = `loadtest_${Date.now()}_${index * 2 + 1}`;

  const reg1 = await api("/auth/register", "POST", { username: u1, password: "pass1234" });
  const reg2 = await api("/auth/register", "POST", { username: u2, password: "pass1234" });

  const token1 = reg1.body.token;
  const token2 = reg2.body.token;
  const userId2 = reg2.body.user.id;

  if (!token1 || !token2) {
    return { client: index, acked: 0, error: `Registration failed: ${JSON.stringify(reg1.body)}`, duration: 0 };
  }

  const conv = await api("/conversations", "POST", { type: "direct", member_ids: [userId2] }, token1);
  const convId = conv.body.id;

  if (!convId) {
    return { client: index, acked: 0, error: `Conversation creation failed: ${JSON.stringify(conv.body)}`, duration: 0 };
  }

  return new Promise(async (resolve) => {
    const start = Date.now();
    let ws1, ws2;

    try {
      ws1 = await wsConnect(token1);
      ws2 = await wsConnect(token2);
    } catch (err) {
      return resolve({ client: index, acked: 0, error: `WS connect failed: ${err.message}`, duration: Date.now() - start });
    }

    let sent = 0;
    let acked = 0;

    const sendNext = () => {
      if (sent >= MESSAGES_PER_CLIENT) return;
      ws1.send(JSON.stringify({
        type: "message.send",
        conversation_id: convId,
        content: `Load test message ${sent} from worker ${index}`,
        client_msg_id: `${index}_${sent}_${Date.now()}`,
      }));
      sent++;
    };

    // Initial burst of 1 to avoid overwhelming before ws2 is ready
    sendNext();

    ws1.on("message", (raw) => {
      const event = JSON.parse(raw);
      if (event.type === "message.ack") {
        acked++;
        if (sent < MESSAGES_PER_CLIENT) {
          sendNext();
        } else if (acked >= MESSAGES_PER_CLIENT) {
          ws1.close();
          ws2.close();
          resolve({ client: index, acked, duration: Date.now() - start });
        }
      }
    });

    ws1.on("error", (err) => {
      ws1.close();
      ws2.close();
      resolve({ client: index, acked, error: err.message, duration: Date.now() - start });
    });

    // Timeout per worker
    setTimeout(() => {
      ws1.close();
      ws2.close();
      resolve({ client: index, acked, timeout: true, duration: Date.now() - start });
    }, 120_000);
  });
}

async function main() {
  console.log(`\nLoad test: ${CONCURRENT} clients × ${MESSAGES_PER_CLIENT} messages\n`);

  const start = Date.now(); // ← was missing before

  const results = await Promise.all(
    Array.from({ length: CONCURRENT }, (_, i) => runWorker(i)) // ← was never called before
  );

  const totalDuration = Date.now() - start;
  const totalAcked = results.reduce((s, r) => s + r.acked, 0);
  const errors = results.filter((r) => r.error || r.timeout);
  const throughput = (totalAcked / (totalDuration / 1000)).toFixed(1);

  console.log(`=== Load Test Results ===`);
  console.log(`Total messages acked : ${totalAcked} / ${CONCURRENT * MESSAGES_PER_CLIENT}`);
  console.log(`Total duration       : ${totalDuration}ms`);
  console.log(`Throughput           : ${throughput} msg/sec`);
  console.log(`Client errors        : ${errors.length}`);
  console.log(`Avg latency/client   : ${(results.reduce((s, r) => s + r.duration, 0) / results.length).toFixed(0)}ms`);

  if (errors.length > 0) {
    console.log(`\nFirst few errors:`);
    errors.slice(0, 3).forEach(r => console.log(`  client ${r.client}: ${r.error || "timeout"}`));
  }
}

main().catch(console.error);