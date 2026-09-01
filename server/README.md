# Funnel — Server

The device **registry** and WebRTC **signaling broker**. Tracks which phones are online and relays SDP/ICE between publishers (phones) and subscribers (clients).

- **Language:** Node.js + TypeScript
- **Signaling:** WebSocket (`ws`)
- **State:** in-memory (Redis-shaped interface, see below)

## Responsibilities

- Accept device registration/unregistration and maintain presence with TTL-based heartbeats.
- Expose the device list (WS `list-devices`, plus `device-updated` / `device-removed` pushes) to the dashboard.
- Relay WebRTC signaling (SDP offer/answer + ICE candidates) between peers.
- Enforce authentication / device pairing (shared token today) over TLS (WSS, terminated upstream).
- **Not** in the media path — audio/video flows peer-to-peer via WebRTC/TURN.

See the wire contract in [`../docs/protocol.md`](../docs/protocol.md); the enforced shapes live in [`@funnel/shared`](../shared/src/protocol.ts) and this server imports them rather than redefining anything.

## Layout

| File               | Role                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `src/index.ts`     | Boots the HTTP + WebSocket servers, `GET /healthz`, graceful shutdown.     |
| `src/config.ts`    | Reads the environment into a `ServerConfig` (listener, auth, ICE servers). |
| `src/registry.ts`  | `DeviceRegistry` interface + in-memory implementation with a TTL sweep.    |
| `src/connection.ts`| Handshake, role handling, presence, and peer-to-peer message relay.        |

## How a connection goes

1. Client opens the WebSocket and sends `hello` (`protocolVersion`, `role`, `token`) within 10s.
2. Server validates the version and token, assigns an id, and replies `hello-ack` with the ICE servers and the heartbeat interval. Subscribers immediately get a `device-list`.
3. Publishers `register`, then `heartbeat` every `HEARTBEAT_INTERVAL_MS`; missing heartbeats for `PRESENCE_TTL_MS` flip the device offline. A dropped socket marks the device offline; an explicit `unregister` removes it.
4. `offer` / `answer` / `ice-candidate` / `session-end` are relayed to the peer named in `to` — either a server-assigned connection id or a registered `deviceId`. The broker always stamps `from` with its own view of the sender, so a client cannot forge an identity.
5. WebSocket ping/pong runs on the heartbeat interval; sockets that miss a pong are terminated.

## Development

```bash
# from the repo root (npm workspaces)
npm install
npm run dev:server

# or from server/
cp .env.example .env
npm run dev        # tsx watch
npm run build      # tsc -> dist/
npm start          # node dist/index.js
npm run typecheck
```

Health check: `curl localhost:8080/healthz` → `{"status":"ok","uptimeSec":…,"devices":{…},"connections":{…}}`.

### Environment

All variables are optional; see [`.env.example`](./.env.example).

| Variable            | Default                          | Purpose                                                                 |
| ------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `HOST`              | `0.0.0.0`                        | Interface to bind.                                                      |
| `PORT`              | `8080`                           | Port for WebSocket signaling and `/healthz`.                            |
| `FUNNEL_AUTH_TOKEN` | _unset_                          | Shared token required in `hello`. **Unset disables auth** (loud warning).|
| `STUN_URLS`         | `stun:stun.l.google.com:19302`   | Comma-separated STUN URLs sent in `hello-ack`.                          |
| `TURN_URLS`         | _unset_                          | Comma-separated TURN URLs sent in `hello-ack`.                          |
| `TURN_USERNAME`     | _unset_                          | TURN long-term credential username.                                     |
| `TURN_CREDENTIAL`   | _unset_                          | TURN long-term credential secret.                                       |

## Status

🚧 Working first pass — handshake, registry with TTL presence, device discovery pushes, and signaling relay all run. Not production-hardened.

### What's not done yet

- **Redis-backed registry.** State is in-memory, so presence dies with the process and the server cannot be scaled past one instance. `DeviceRegistry` is the seam a Redis implementation slots into.
- **Real auth / pairing.** One shared token for every device and dashboard; no per-device credentials, QR pairing, rotation, or revocation. TLS is expected from a reverse proxy — the server speaks plain `ws`.
- **Reconnection resume.** A reconnecting client gets a fresh id and must re-register; in-flight WebRTC sessions are not resumed. See the open question in `../docs/protocol.md`.
- **REST device list.** Discovery is WebSocket-only; `/healthz` is the sole HTTP route.
- **Rate limiting / backpressure** on the relay path, and any persistence of session history.
