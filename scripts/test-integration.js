#!/usr/bin/env node
'use strict';
const WebSocket = require("ws");
const fetch = require("node-fetch");
const BASE    = process.env.BASE_URL || "http://localhost";
const WS_BASE = process.env.WS_URL  || "ws://localhost";
let pass = 0, fail = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); pass++; }
  else           { console.error(`  ✗ ${label}`); fail++; }
}
async function api(path, method = "GET", body, token) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
async function wsConnect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    ws._msgQueue = []; ws._msgWaiters = [];
    ws.on("message", (raw) => {
      let event; try { event = JSON.parse(raw); } catch { return; }
      if (event.type === "error") console.error("  [WS server error]", JSON.stringify(event));
      if (ws._msgWaiters.length > 0) { ws._msgWaiters.shift()(event); } else { ws._msgQueue.push(event); }
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS connect timeout")), 5000);
  });
}
function wsWait(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const idx = ws._msgQueue.findIndex((e) => e.type === type);
    if (idx !== -1) return resolve(ws._msgQueue.splice(idx, 1)[0]);
    const t = setTimeout(() => { ws._msgWaiters = ws._msgWaiters.filter((w) => w !== waiter); reject(new Error(`Timeout waiting for ${type}`)); }, timeout);
    const waiter = (event) => {
      if (event.type === type) { clearTimeout(t); resolve(event); }
      else { ws._msgQueue.push(event); ws._msgWaiters.unshift(waiter); }
    };
    ws._msgWaiters.push(waiter);
  });
}
async function run() {
  console.log("\n=== Chat Backend Integration Tests ===\n");
  console.log("[ Auth ]");
  const u1 = `user_${Date.now()}_a`, u2 = `user_${Date.now()}_b`;
  const reg1 = await api("/auth/register", "POST", { username: u1, password: "pass1234" });
  assert(reg1.status === 201, "Register user A"); const token1 = reg1.body.token;
  const reg2 = await api("/auth/register", "POST", { username: u2, password: "pass1234" });
  assert(reg2.status === 201, "Register user B"); const token2 = reg2.body.token;
  const login = await api("/auth/login", "POST", { username: u1, password: "pass1234" });
  assert(login.status === 200 && login.body.token, "Login user A");
  const badLogin = await api("/auth/login", "POST", { username: u1, password: "wrong" });
  assert(badLogin.status === 401, "Reject bad password");
  console.log("\n[ Conversations ]");
  const userId2 = reg2.body.user.id;
  const conv = await api("/conversations", "POST", { type: "direct", member_ids: [userId2] }, token1);
  assert(conv.status === 201, "Create direct conversation"); const convId = conv.body.id;
  const convList = await api("/conversations", "GET", null, token1);
  assert(convList.status === 200 && convList.body.length >= 1, "List conversations");
  console.log("\n[ WebSocket Messaging ]");
  const ws1 = await wsConnect(token1); assert(true, "User A connects via WebSocket");
  const ws2 = await wsConnect(token2); assert(true, "User B connects via WebSocket");
  const clientMsgId = `test_${Date.now()}`;
  ws1.send(JSON.stringify({ type: "message.send", conversation_id: convId, content: "Hello from integration test", client_msg_id: clientMsgId }));
  const ack = await wsWait(ws1, "message.ack");
  assert(ack.client_msg_id === clientMsgId, "Sender receives ack");
  const received = await wsWait(ws2, "message.new");
  assert(received.message.content === "Hello from integration test", "Receiver gets message");
  const msgId = received.message.id;
  ws1.send(JSON.stringify({ type: "typing.start", conversation_id: convId }));
  const typingEvent = await wsWait(ws2, "typing.start");
  assert(typingEvent.conversation_id === convId, "Typing indicator delivered");
  ws2.send(JSON.stringify({ type: "message.read", conversation_id: convId, message_id: msgId }));
  const readEvent = await wsWait(ws1, "message.read");
  assert(readEvent.message_id === msgId, "Read receipt delivered to sender");
  console.log("\n[ Message History ]");
  const history = await api(`/messages/${convId}?limit=10`, "GET", null, token1);
  assert(history.status === 200 && history.body.messages.length >= 1, "Fetch message history");
  ws1.send(JSON.stringify({ type: "message.send", conversation_id: convId, content: "Duplicate", client_msg_id: clientMsgId }));
  const dupAck = await wsWait(ws1, "message.ack");
  assert(dupAck.message_id === msgId, "Duplicate message deduped (same id returned)");
  ws1.close(); ws2.close();
  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}
run().catch((err) => { console.error("Test runner error:", err); process.exit(1); });
