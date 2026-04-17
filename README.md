# Chat Backend

A production-grade, horizontally scalable real-time chat system built with Node.js, WebSockets, Redis, and PostgreSQL. Designed around the same architectural patterns used at Discord, Slack, and WhatsApp.

## Architecture

```
Client
  │
  ▼
nginx (reverse proxy + load balancer)
  ├──── REST /api ────▶ Gateway Service (auth, users, conversations)
  └──── WS  /ws  ────▶ Chat Service × 2 instances
                              │
                    Redis Pub/Sub (cross-instance fanout)
                              │
                       Message Service
                              │
                         PostgreSQL
```

**Why multiple chat service instances?**
A user on instance-1 can send a message to a user connected to instance-2. Redis pub/sub broadcasts the event to all instances; only the instance holding the recipient's WebSocket connection delivers it. This is how Discord and Slack handle millions of concurrent connections.

## Key Design Decisions

| Decision | Approach | Why |
|---|---|---|
| Real-time transport | WebSocket over HTTP long-poll | Lower latency, full-duplex, no polling overhead |
| Cross-instance delivery | Redis pub/sub | Decoupled, O(1) fanout regardless of instance count |
| Auth on WebSocket | JWT on upgrade handshake | Stateless, no session store needed |
| Offline delivery | Redis queue + flush on reconnect | Guarantees delivery without persistent connections |
| Presence tracking | TTL-based Redis keys + heartbeat | Auto-expires stale presence without explicit logout |

## Services

- **nginx** — TLS termination, load balancing across chat instances, routing REST vs WebSocket traffic
- **Gateway** — REST API: registration, login, conversation management. Rate limited via express-rate-limit
- **Chat Service** — WebSocket server: message delivery, typing indicators, read receipts, presence
- **Message Service** — Persistence layer: stores messages in PostgreSQL, serves message history
- **Redis** — Pub/sub bus for cross-instance message fanout + offline message queue
- **PostgreSQL** — Source of truth: users, conversations, messages, membership

## WebSocket Events

| Event | Direction | Description |
|---|---|---|
| `message.send` | Client → Server | Send a message to a conversation |
| `message.ack` | Server → Client | Confirms message persisted with server-assigned ID |
| `message.new` | Server → Client | Incoming message from another user |
| `message.read` | Client → Server | Mark messages as read |
| `typing.start` | Client → Server | User started typing |
| `typing.stop` | Client → Server | User stopped typing |
| `ping` / `pong` | Bidirectional | Keepalive heartbeat every 30s |

## Performance

Load tested with 50 concurrent users × 20 messages each:

```
Total messages acked : 1000 / 1000
Total duration       : 21971ms
Throughput           : 45.5 msg/sec
Client errors        : 0
Avg latency/client   : 274ms
```

## Running Locally

```bash
git clone https://github.com/manish08k/chat_backend
cd chat_backend
cp .env.example .env
docker compose up -d --build
```

All services start automatically. nginx listens on port 80.

## Running the Load Test

```bash
cd scripts
npm install
node load-test.js
```

Custom parameters:

```bash
CONCURRENT=100 MESSAGES=50 node load-test.js
```

## API Reference

### Auth

```
POST /api/auth/register   { username, password }
POST /api/auth/login      { username, password }
```

### Conversations

```
GET  /api/conversations                        List user's conversations
POST /api/conversations                        Create conversation { type, member_ids }
GET  /api/conversations/:id/messages           Message history
```

### WebSocket Connection

```
ws://localhost/ws?token=<jwt>
```

Send events as JSON:

```json
{
  "type": "message.send",
  "conversation_id": "<uuid>",
  "content": "Hello!",
  "client_msg_id": "<unique-id>"
}
```

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| WebSockets | ws |
| Database | PostgreSQL 15 |
| Cache / Pub-Sub | Redis 7 |
| Proxy | nginx 1.25 |
| Containerization | Docker + Docker Compose |
| Orchestration | Kubernetes (manifests in `/k8s`) |

## Kubernetes

Production-ready K8s manifests in `/k8s`:

- Deployments for each service with resource limits
- Horizontal scaling configuration for chat-service
- Secrets management
- Service and Ingress definitions

## What I Would Add Next

- End-to-end message encryption (AES-256 at rest)
- WebSocket connection rate limiting per user
- Prometheus metrics + Grafana dashboard
- At-least-once delivery guarantee with client-side deduplication
- Group conversation fan-out optimization
- Media and file upload via S3 presigned URLs
- CI/CD pipeline with GitHub Actions
