# Funnel — Android app

The publisher side of Funnel. Runs on each Android phone, captures camera + microphone, registers with the server, and streams over WebRTC.

- **Language:** Kotlin
- **Build:** Gradle
- **Key APIs:** CameraX (video), AudioRecord (audio), `libwebrtc` (transport), Foreground Service (keep-alive)

## Responsibilities

- Register/unregister with the server over a persistent WebSocket (see [`../docs/protocol.md`](../docs/protocol.md)).
- Send periodic heartbeats (online status, battery, capabilities).
- Establish WebRTC sessions (SDP offer/answer + ICE) with a selected client.
- Capture and encode camera + mic; publish SRTP media peer-to-peer.
- Run a foreground service so capture survives the screen turning off.

## Status

🚧 Not yet implemented — Gradle project scaffolding pending.
