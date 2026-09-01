# Funnel

Turn your spare Android phones into on-demand **remote cameras** and **remote microphones**, managed from a single dashboard.

If you have a drawer full of old Android devices, Funnel lets each one become a network-accessible camera/mic feed. Register the phones you want to use in the dashboard, stream from the ones you need, and unregister them when you are done.

## Use case

I have many Android phones. I want to use them as remote cameras and remote microphones.

Instead of dedicated IP cameras or USB webcams, each Android device runs the Funnel app, announces itself to a dashboard, and can be selected on demand as a live audio/video source — for a meeting, a stream, home monitoring, a multi-angle recording setup, or anything that needs an extra camera/mic.

## How it works

```
 ┌─────────────┐        ┌─────────────┐        ┌─────────────┐
 │  Android #1 │        │  Android #2 │        │  Android #N │
 │  Funnel app │  ...   │  Funnel app │  ...   │  Funnel app │
 └──────┬──────┘        └──────┬──────┘        └──────┬──────┘
        │  register / stream   │                      │
        └──────────────┬───────┴──────────────────────┘
                       │
                ┌──────▼───────┐
                │  Dashboard   │   ← discover, register, select, stream
                │   / Server   │
                └──────┬───────┘
                       │
                ┌──────▼───────┐
                │  Your client │   (browser, meeting app, OBS, etc.)
                └──────────────┘
```

- Each phone runs the **Funnel Android app** and registers itself with the dashboard.
- The **dashboard** lists every registered phone and its status (online, streaming, battery, etc.).
- You **select** a phone and consume its camera and microphone as a remote source.
- When you are finished, you **unregister** the phone to free it up.

## How to use

1. **Install** the Funnel Android APK on each phone.
2. **Start** the app.
3. **Register** the device in the dashboard. You can register many phones.
4. **Select** a phone and use it as a remote camera / microphone.
5. When you are finished, **unregister** it.

## Architecture

Funnel is built around **WebRTC** for low-latency, adaptive audio/video, with a lightweight server acting as both **device registry** and **signaling broker**.

```
                            ┌───────────────────────────────┐
                            │          Dashboard / Server    │
   register / heartbeat     │  ┌──────────┐   ┌───────────┐  │
 ┌─────────────┐  (WSS)     │  │ Device   │   │ Signaling │  │
 │ Android app │────────────┼─▶│ Registry │   │  broker   │  │
 │ (publisher) │            │  └──────────┘   └─────┬─────┘  │
 └──────┬──────┘            │        REST/WS        │        │
        │                   └───────────────────────┼────────┘
        │   WebRTC media (SRTP)                      │ signaling (SDP/ICE)
        │   ◀─── STUN/TURN (NAT traversal) ───▶      │
        └───────────────────────────────────────────┴──────▶ ┌────────────┐
                                                              │   Client   │
                                                              │ (subscriber)│
                                                              └────────────┘
```

**Signaling flow (register → stream → unregister):**

1. **Register** — On start, the app opens a persistent WebSocket to the server and posts its identity (device id, name, capabilities, battery). The server adds it to the registry and marks it `online`. Periodic heartbeats keep the `online` flag fresh; a missed heartbeat marks it `offline`.
2. **Select** — The dashboard lists registered devices. Choosing one triggers a WebRTC offer/answer exchange (SDP + ICE candidates) relayed through the signaling broker.
3. **Stream** — Once ICE connectivity is established (direct, or via a TURN relay when NAT-blocked), media flows **peer-to-peer over SRTP** between the phone and the client — it does not pass through the server. The app runs a foreground service so capture continues with the screen off.
4. **Unregister** — The app (or the user, from the dashboard) closes the session; the server removes the device from the active registry and tears down signaling.

**Connectivity notes**

- **STUN** handles the common case where both peers can reach each other after address discovery.
- **TURN** relays media when a phone sits behind symmetric NAT or a mobile carrier network (CGNAT) — expect to run your own TURN server (e.g. [coturn](https://github.com/coturn/coturn)) for reliable operation.
- Because media is P2P, server bandwidth stays low regardless of how many phones stream; the server only carries signaling and registry traffic.

## Tech stack

| Layer            | Choice                          | Why                                                                 |
| ---------------- | ------------------------------- | ------------------------------------------------------------------- |
| Android app      | **Kotlin** + **Jetpack Compose** | Current Android defaults; the UI is a thin shell over the service.  |
| App capture      | **libwebrtc** Camera2 capturer  | Texture frames straight to the hardware encoder — no CPU YUV copy.  |
| App audio        | **JavaAudioDeviceModule**       | libwebrtc owns `AudioRecord`; no PCM handled by hand.               |
| Media transport  | **WebRTC** (`libwebrtc`)        | Low-latency, adaptive, encrypted (SRTP) A/V; P2P after signaling.  |
| Foreground work  | **Foreground Service**          | Keeps capture alive with the screen off; user-visible notification. |
| Server           | **Node.js** + **TypeScript**    | Fast to build; shares WebRTC/JS ecosystem with the dashboard.       |
| Signaling        | **WebSocket** (`ws`)            | Bidirectional, low-overhead SDP/ICE relay + heartbeats.             |
| Registry / state | **Redis** (or in-memory)        | Fast device presence tracking with TTL-based expiry.                |
| NAT traversal    | **coturn** (STUN/TURN)          | Establishes connectivity across NAT/CGNAT.                          |
| Dashboard        | **React** + **Vite**            | View/listen in the browser; select and manage devices.             |
| Dashboard hosting| **Cloudflare Workers** (assets) | Static SPA at the edge; no server to run, no state in the Worker.  |
| Auth / pairing   | **Token / QR pairing** + TLS    | Authenticated device onboarding; encrypted signaling (WSS).         |

> These are recommended defaults, not final decisions — the architecture (registry + signaling broker + P2P WebRTC) holds regardless of the specific server language or dashboard framework.

## Repository layout

This is a monorepo holding the Android app, the server, and the dashboard, so the app↔server contract stays in sync in one place.

```
funnel/
├── android/          # Kotlin + CameraX APK (publisher) — see android/README.md
├── server/           # Node/TS registry + signaling broker — see server/README.md
├── dashboard/        # React SPA on Cloudflare Workers (subscriber) — see dashboard/README.md
├── shared/           # signaling types / protocol contract shared by all sides
├── docs/
│   └── protocol.md   # the app ↔ server ↔ client wire contract, documented once
├── infra/            # coturn (STUN/TURN), docker-compose, env templates
├── package.json      # npm workspaces root: shared + server + dashboard
├── tsconfig.base.json
├── README.md
└── LICENSE
```

`shared/`, `server/` and `dashboard/` are npm workspaces, so one `npm install` at the root wires all three together. `android/` is a separate Gradle build and mirrors the protocol by hand.

The single most important seam is [`docs/protocol.md`](./docs/protocol.md) — the signaling and registration contract that every component agrees on.

## Components

| Component        | Role                                                              |
| ---------------- | ---------------------------------------------------------------- |
| Android app      | Captures camera + mic, registers with the dashboard, streams.     |
| Dashboard/Server | Registry of devices, selection UI, and stream broker.             |
| Client           | Consumes the selected phone's feed (browser / virtual cam / app). |

## Getting started

```bash
# 1. signaling server + TURN + Redis
cd infra && cp .env.example .env && docker compose up --build
#    or, without Docker:  npm install && npm run dev:server

# 2. dashboard
npm install          # from the repo root — sets up all three workspaces
npm run dev:dashboard

# 3. phone
cd android && gradle wrapper && ./gradlew installDebug
```

The dashboard defaults to `ws://localhost:8080/ws` and the app to `ws://10.0.2.2:8080/ws` (the host, as seen from the Android emulator). Each component's README covers its own configuration.

## Status

🚧 Early stage. Every piece of the path is now implemented — register, discover, offer/answer, capture, stream — but **none of it has been compiled or run yet**. Treat the table below as "written", not "verified".

| Component     | Implemented                                                                             |
| ------------- | --------------------------------------------------------------------------------------- |
| `shared/`     | Protocol types and helpers — the contract every side compiles against.                   |
| `server/`     | Handshake, in-memory registry with TTL presence, discovery pushes, signaling relay.       |
| `dashboard/`  | Device list, offer/answer, trickle ICE, remote video. Deploys to Cloudflare Workers.      |
| `android/`    | Signaling, camera + mic capture, answer/ICE, foreground service.                          |
| `infra/`      | docker-compose (server + Redis + coturn) and TURN config. No TLS certificates.            |

CI builds all of it on every pull request — the TypeScript workspaces and a debug APK — and every merge to `main` publishes that APK to a [GitHub Release](../../releases). Those releases are **debug-signed**: fine for a development phone, not shippable.

Outstanding across the repo: real auth/pairing (today it is one shared token), TLS termination for `wss://`, and moving the registry off the in-memory map onto Redis. Each component's README lists its own gaps.

## License

[MIT](./LICENSE) © 2026 Yusuke Harada
