# Funnel — Android app

The publisher side of Funnel. Runs on each Android phone, captures camera + microphone, registers with the server, and streams over WebRTC.

- **Language:** Kotlin
- **Build:** Gradle (Kotlin DSL, version catalog)
- **UI:** Jetpack Compose + Material 3 — the current Android default; no XML layouts or view binding
- **Key APIs:** `libwebrtc` (capture, encode, transport), Foreground Service (keep-alive)

## Responsibilities

- Register/unregister with the server over a persistent WebSocket (see [`../docs/protocol.md`](../docs/protocol.md)).
- Send periodic heartbeats (online status, battery, capabilities).
- Establish WebRTC sessions (SDP offer/answer + ICE) with a selected client.
- Capture and encode camera + mic; publish SRTP media peer-to-peer.
- Run a foreground service so capture survives the screen turning off.

## Layout

```
android/
├── settings.gradle.kts
├── build.gradle.kts
├── gradle/libs.versions.toml        # every dependency version lives here
└── app/
    ├── build.gradle.kts
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/com/github/m96chan/funnel/
        │   ├── FunnelApp.kt          # Application + FunnelConfig (defaults, persisted device id)
        │   ├── MainActivity.kt       # Compose UI: server URL, device name, permissions, start/stop
        │   ├── PublisherService.kt   # foreground service; owns signaling + media + sessions
        │   ├── media/
        │   │   ├── MediaEngine.kt    # PeerConnectionFactory, camera capture, shared tracks
        │   │   └── PublisherSession.kt # one subscriber: answer, trickle ICE, send tracks
        │   └── signaling/
        │       ├── Protocol.kt       # Kotlin mirror of shared/src/protocol.ts
        │       └── SignalingClient.kt
        └── res/values/…
```

`Protocol.kt` is a hand-mirror of [`../shared/src/protocol.ts`](../shared/src/protocol.ts) — same field names, same `type` strings, same `PROTOCOL_VERSION` / `HEARTBEAT_INTERVAL_MS`. Change one, change the other. Because the envelope's `payload` is polymorphic, decoding is two-step: parse the envelope with `payload: JsonElement`, then decode the payload by `type`.

## Build

Requirements:

- JDK 17 (the Kotlin toolchain is pinned to 17).
- Android SDK **35** (compileSdk/targetSdk 35, minSdk 26).
- Gradle 8.11.1 — or let Android Studio provide it.

The Gradle **wrapper jar is not committed** (binaries do not belong in this repo). Generate it once:

```bash
cd android
gradle wrapper      # writes gradle/wrapper/gradle-wrapper.jar
./gradlew assembleDebug
```

Opening `android/` in Android Studio does the same thing for you — after that `./gradlew assembleDebug` and `./gradlew installDebug` work as usual.

Point the app at a server by editing the **Server URL** field in the app. The default is `ws://10.0.2.2:8080/ws`, which is the host machine as seen from the emulator; use your LAN IP for a real phone. Cleartext `ws://` is allowed in the manifest for development — turn `usesCleartextTraffic` off before shipping anything.

## Status

🚧 **Implemented end to end, not yet compiled.** The register → offer → answer → stream path is written in full; no Android SDK was available to build it, so treat the list below as written rather than verified.

- `signaling/Protocol.kt` — the full envelope + payload set, two-step polymorphic decode, `IceServer.urls` accepting either a string or an array.
- `signaling/SignalingClient.kt` — OkHttp WebSocket: `hello` → `register` → heartbeat loop at `HEARTBEAT_INTERVAL_MS` with the real battery level, incoming events as a `Flow`, reconnect with exponential backoff + jitter, `unregister` on a clean disconnect.
- `media/MediaEngine.kt` — `PeerConnectionFactory` with the hardware encoder factories, `JavaAudioDeviceModule` for the mic, and a `Camera2Enumerator` capturer feeding a `VideoSource` through a `SurfaceTextureHelper`. Capture is reference-counted per session, so the camera light is only on while somebody is watching.
- `media/PublisherSession.kt` — one session per subscriber: `setRemoteDescription` → `createAnswer` → `setLocalDescription`, trickled ICE both ways (remote candidates arriving before the answer are queued), teardown on `session-end` or ICE failure.
- `PublisherService.kt` — foreground service with `camera|microphone` type; owns the signaling client, the media engine, and the session map. Reports `streaming` in the heartbeat and the live viewer count to the UI.

### Why not CameraX

The tech stack originally said CameraX. Wiring it into WebRTC means taking `ImageAnalysis` frames and copying every `YUV_420_888` buffer into a `JavaI420Buffer` on the CPU, per frame, per session — which costs more than the encode does and caps the frame rate well below 30fps at 1080p. libwebrtc ships its own Camera2 capturer that delivers texture frames straight to the hardware encoder via `SurfaceTextureHelper`, so that is what `MediaEngine` uses. Same Camera2 API underneath; CameraX is simply the wrong seam here. Reintroducing it would be a `VideoCapturer` implementation in `media/` and nothing else would change.

## What's not done yet

- **Auth token handling** — `SignalingConfig.token` is plumbed through to the `hello` payload but nothing ever sets it; pairing/QR is still an open question in `docs/protocol.md`.
- **Camera selection** — always the first back-facing camera, at the resolution in `FunnelConfig.DEFAULT_CAPABILITIES`. No front/back switch, no torch, no zoom, no local preview.
- **`sdpMLineIndex` fallback** — the protocol types it nullable; a null becomes `0`, which is right for the bundled single-`m`-section case the dashboard produces and wrong in general.
- **Bitrate and degradation policy** — left at libwebrtc's defaults. No `RtpParameters` tuning, no explicit resolution scaling under CPU pressure.
- **Screen-off behaviour beyond the service itself** — no wake lock, no battery-optimisation opt-out prompt.
- Tests, lint config and CI. None, deliberately.
