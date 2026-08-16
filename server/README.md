# Funnel — Server

The device **registry** and WebRTC **signaling broker**. Tracks which phones are online and relays SDP/ICE between publishers (phones) and subscribers (clients).

- **Language:** Node.js + TypeScript
- **Signaling:** WebSocket (`ws`)
- **State:** Redis (or in-memory for development)

## Responsibilities

- Accept device registration/unregistration and maintain presence with TTL-based heartbeats.
- Expose the device list (REST/WS) to the dashboard.
- Relay WebRTC signaling (SDP offer/answer + ICE candidates) between peers.
- Enforce authentication / device pairing (token or QR) over TLS (WSS).
- **Not** in the media path — audio/video flows peer-to-peer via WebRTC/TURN.

See the wire contract in [`../docs/protocol.md`](../docs/protocol.md).

## Development

```bash
# from server/
npm install
npm run dev
```

## Status

🚧 Not yet implemented.
