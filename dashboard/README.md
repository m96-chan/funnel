# Funnel — Dashboard

The browser UI for managing and consuming devices. Lists registered phones, shows their status, and lets you select one to view/listen to as a remote camera + microphone.

- **Framework:** React 19 + Vite + TypeScript
- **Media:** WebRTC browser APIs (`RTCPeerConnection`, `getUserMedia` not required — subscribe only)
- **Hosting:** Cloudflare Workers static assets, deployed with Wrangler

## Responsibilities

- Show all registered devices and live status (online, streaming, battery, last seen).
- Initiate a WebRTC session with a selected device (subscriber role).
- Render the remote video and play the remote audio.
- Trigger session teardown.

## Layout

```
dashboard/
├── index.html
├── vite.config.ts
├── wrangler.jsonc        # Workers static-assets config (no bindings, no state)
├── .env.example
└── src/
    ├── main.tsx
    ├── App.tsx           # device table + video viewer
    ├── signaling.ts      # typed WebSocket client (subscriber role, auto-reconnect)
    ├── webrtc.ts         # recvonly RTCPeerConnection, offer/answer, trickle ICE
    ├── useDevices.ts     # React state over the signaling client
    └── styles.css
```

Every message shape comes from [`@funnel/shared`](../shared) — the dashboard never redefines the wire contract. See [`docs/protocol.md`](../docs/protocol.md).

## Configuration

| Variable             | Default                  | Meaning                                      |
| -------------------- | ------------------------ | -------------------------------------------- |
| `VITE_SIGNALING_URL` | `ws://localhost:8080/ws` | WebSocket endpoint of the signaling server.   |

Copy `.env.example` to `.env` (or `.env.local`) to override it. Vite inlines `VITE_*` variables **at build time**, so changing it means rebuilding.

## Development

```sh
npm install                              # once, from the repo root
npm run dev --workspace @funnel/dashboard # or: npm run dev:dashboard
```

Run [`../server`](../server) alongside it so there is something to connect to. Other scripts: `build`, `preview`, `typecheck`.

## Deploy to Cloudflare

```sh
VITE_SIGNALING_URL=wss://signaling.example.com/ws npm run build
npx wrangler deploy
```

- The Worker **serves static assets only** — it does not proxy signaling and holds no state. The browser talks to the signaling server directly.
- Because a page served over `https://` cannot open a `ws://` socket, the signaling server must be reachable over **`wss://`** with a valid certificate.
- `VITE_SIGNALING_URL` is baked into the bundle during `npm run build`; pointing the dashboard at a different server requires a rebuild and redeploy.

## Status

Implemented against the signaling contract: connect, list devices, offer/answer, trickle ICE, render the remote stream, tear down. Not compiled or run yet — no Node toolchain was available. Not yet implemented: auth/pairing tokens, remote unregister from the UI, audio-only mode, and per-device stream stats.
