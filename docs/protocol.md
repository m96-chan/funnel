# Funnel Protocol

The wire contract between the **Android app** (publisher), the **server** (registry + signaling broker), and the **dashboard/client** (subscriber). This document is the single source of truth for the app↔server↔client seam.

> Status: 🚧 Draft — message shapes below are a starting point and will change as implementation lands.

## Transport

- **Signaling:** WebSocket over TLS (`wss://`). One persistent connection per app and per client.
- **Media:** WebRTC (SRTP), peer-to-peer between phone and client. Never passes through the server.
- **NAT traversal:** STUN for address discovery, TURN (coturn) as a relay fallback.

## Roles

| Role       | Who          | Connection                                             |
| ---------- | ------------ | ------------------------------------------------------ |
| Publisher  | Android app  | Registers, heartbeats, answers WebRTC offers.          |
| Broker     | Server       | Tracks presence, relays signaling. Not in media path.  |
| Subscriber | Dashboard    | Lists devices, sends WebRTC offers to a chosen device. |

## Message envelope

All signaling messages share a common JSON envelope:

```json
{
  "type": "<message-type>",
  "from": "<sender-id>",
  "to": "<recipient-id | null>",
  "payload": { }
}
```

## Message types (draft)

### Registration & presence (app ↔ server)

- `register` — app announces itself.
  ```json
  { "type": "register", "payload": {
      "deviceId": "uuid",
      "name": "Kitchen Pixel 4",
      "capabilities": { "video": true, "audio": true, "maxResolution": "1080p" },
      "battery": 0.87
  }}
  ```
- `registered` — server ack with assigned session info.
- `heartbeat` — app → server, periodic; refreshes presence TTL. Carries updated `battery`, `streaming` state.
- `unregister` — app leaves; server removes it from the active registry.

### Discovery (dashboard ↔ server)

- `device-list` — dashboard requests / server pushes the current registry.
  ```json
  { "type": "device-list", "payload": { "devices": [
      { "deviceId": "uuid", "name": "Kitchen Pixel 4", "online": true, "streaming": false, "battery": 0.87 }
  ]}}
  ```
- `device-updated` — server pushes a single device's status change.

### WebRTC signaling (subscriber ↔ publisher, via broker)

- `offer` — subscriber → publisher: SDP offer to start a session.
- `answer` — publisher → subscriber: SDP answer.
- `ice-candidate` — either direction: trickled ICE candidate.
- `session-end` — either direction: tear down the media session.

## Lifecycle

```
app start ─▶ register ─▶ (heartbeat…) ─▶ answer offer ─▶ stream ─▶ session-end ─▶ unregister
```

## Open questions

- Authentication / pairing: token vs. QR handshake, and where it sits in the envelope.
- Whether the server ever transcodes or records (default: no — pure P2P).
- Reconnection semantics after a dropped WebSocket (resume vs. re-register).
