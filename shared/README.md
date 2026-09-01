# Funnel — Shared

The contract between the app, server, and dashboard: signaling message types, device-registration schema, and protocol constants. Keeping this in one place stops the app and server from drifting apart.

- Protocol specification (prose): [`../docs/protocol.md`](../docs/protocol.md)
- Protocol contract (enforced): [`src/protocol.ts`](./src/protocol.ts)

The Android app cannot consume TypeScript, so it mirrors these shapes by hand in Kotlin. When a message changes here, `android/app/src/main/java/.../signaling/Protocol.kt` changes with it.

## Contents

| File                                 | What it holds                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| [`src/protocol.ts`](./src/protocol.ts) | Envelope, every message payload, `DeviceInfo`, error codes, and the timing constants.     |
| [`src/messages.ts`](./src/messages.ts) | Runtime helpers: `parseEnvelope`, `serialize`, `toServer`, `toPeer`, `errorMessage`.      |

`ClientMessage` and `ServerMessage` are discriminated unions on `type`, so adding a message type without handling it is a compile error on both sides.

## Usage

Consumed as an npm workspace — `"@funnel/shared": "*"`. It compiles to `dist/`, and its `prepare` script runs on `npm install` from the repo root, so consumers resolve it without a manual build step. While editing the protocol, run `npm run dev --workspace @funnel/shared` to keep `dist/` in sync.

```ts
import { PROTOCOL_VERSION, parseEnvelope, toServer } from '@funnel/shared';
```

## Constants worth knowing

| Constant                | Value    | Meaning                                                        |
| ----------------------- | -------- | -------------------------------------------------------------- |
| `PROTOCOL_VERSION`      | `1`      | Sent in `hello`; the server rejects a mismatch.                |
| `HEARTBEAT_INTERVAL_MS` | `10_000` | How often a publisher is expected to heartbeat.                |
| `PRESENCE_TTL_MS`       | `30_000` | No heartbeat inside this window and the device goes `offline`. |

## Status

✅ Protocol types and helpers defined. Payload shapes are validated by whoever handles each message type — `parseEnvelope` only guarantees the envelope.
