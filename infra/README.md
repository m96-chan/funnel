# Funnel — Infra

Deployment and networking configuration: the STUN/TURN server, container setup, and environment templates.

## Contents

- `docker-compose.yml` — local stack: signaling server + Redis + coturn.
- `server.Dockerfile` — multi-stage build for the signaling server. Its build context is the **repository root** (the server is an npm workspace that depends on `shared/`), which is why compose sets `context: ..`.
- `server.Dockerfile.dockerignore` — build-context excludes, so the whole repo isn't shipped to the daemon on every build.
- `coturn/turnserver.conf` — STUN/TURN configuration for NAT/CGNAT traversal.
- `.env.example` — environment variables for the server and TURN credentials.

## Why TURN is needed

Phones on mobile networks or behind symmetric NAT often cannot establish a direct WebRTC connection. A TURN relay (coturn) forwards the encrypted media so the session still works. Plan to run your own for reliable operation.

## Quick start

```sh
cd infra
cp .env.example .env
$EDITOR .env            # set FUNNEL_AUTH_TOKEN, change the TURN credentials
docker compose up --build
```

Then:

- signaling — `ws://localhost:8080/ws`
- health — `curl localhost:8080/healthz`
- STUN/TURN — `localhost:3478`

Two things to know before the first run:

- **TURN credentials live in two files.** `TURN_USERNAME` / `TURN_CREDENTIAL` in `.env` are what the server hands to peers; the `user=` line in `coturn/turnserver.conf` is what coturn checks them against. They have to match, and nothing verifies that for you.
- **coturn uses host networking.** That is a no-op on Docker Desktop for macOS and Windows — TURN will not work there. Use a Linux host, or run coturn natively. The comment on the service in `docker-compose.yml` explains why host networking is required at all.

The stack needs these ports:

| Port          | Proto    | Service | Notes                                                   |
| ------------- | -------- | ------- | ------------------------------------------------------- |
| 8080          | TCP      | server  | HTTP + WebSocket signaling (`PORT`).                     |
| 3478          | UDP, TCP | coturn  | STUN + TURN.                                             |
| 5349          | TCP      | coturn  | TURN over TLS. Not enabled yet — no certificates.        |
| 49160–49200   | UDP      | coturn  | Relay allocations. Widen for production.                 |

Redis is deliberately not published — only the server needs it.

## Verifying TURN works

The practical check is Google's [Trickle ICE page](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/). Remove the default STUN entry, add your server:

```
STUN or TURN URI:  turn:<your-host>:3478?transport=udp
TURN username:     funnel                     (your TURN_USERNAME)
TURN password:     change-me-turn-password    (your TURN_CREDENTIAL)
```

Click **Gather candidates**. You want a row with type `relay`. That, and only that, proves the relay allocated a port and handed back a usable address:

- `host` only — the page never reached your server.
- `host` + `srflx` — STUN works, TURN authentication or allocation failed.
- a `relay` row — TURN works.

**No `relay` candidate is almost always one of two things:** `external-ip` in `turnserver.conf` is wrong or unset (coturn is advertising a private address it can see but nobody else can reach), or the `min-port`–`max-port` UDP range is blocked by the host firewall or cloud security group. Check those before anything else; credential errors show up as an explicit `401` in `docker compose logs coturn`, so a silent failure points at the network.

## Production notes

- **Run coturn on a public IP.** A relay behind NAT needs `external-ip=<public>/<private>` set correctly, and the relay UDP range (`min-port`–`max-port`) open inbound. Size the range at roughly two ports per concurrent relayed stream — the local default of 41 ports is for testing only; coturn's own default is `49152-65535`.
- **Turn on TLS.** Uncomment `tls-listening-port=5349` plus `cert`/`pkey` and hand out a `turns:` URL alongside the `turn:` one. Browsers on networks that block UDP fall back to TURN over TLS/443-style paths, and a `wss://` dashboard cannot always talk to plaintext infrastructure without complaints.
- **Rotate credentials — properly.** The static `user=funnel:...` in `turnserver.conf` is a development convenience: it is committed-adjacent, shared by every client, and never expires. The real answer is time-limited credentials: set `use-auth-secret` + `static-auth-secret` in coturn, and have the signaling server mint `username = <expiry-unix-ts>:<peer-id>` with `credential = base64(hmac_sha1(secret, username))` per session. They expire on their own, so a leaked credential is worthless in minutes and there is nothing to rotate by hand.
- **Never leave the relay open.** The `denied-peer-ip` block in `turnserver.conf` is what stops the relay being used as a scanner pointed at your own internal network — including the cloud metadata endpoint at `169.254.169.254`. Keep it.
- **Server bandwidth stays low.** The signaling server carries SDP, ICE candidates and heartbeats only; media is peer-to-peer. The exception is TURN: every relayed session pushes full media through coturn in both directions, so plan bandwidth and instance size around the fraction of sessions you expect to need a relay, not around the server.

## What's not done yet

- **TLS.** No certificates, no termination. Signaling runs as `ws://` and TURN has no `turns:` listener. Production needs both (`wss://` for signaling, 5349 for TURN), which means a certificate source and probably a reverse proxy in front of the server.
- **Credential rotation.** TURN uses a static user from `.env`. The `use-auth-secret` path above is documented in `coturn/turnserver.conf` but not wired into the server.
- **Redis is unused.** It runs in the stack, but the device registry is still an in-memory map in the server. Redis is here so presence can move to it — TTL expiry that survives a restart, and a shared registry across more than one server instance — without a compose change.
- **No lockfile.** `server.Dockerfile` falls back to `npm install` when `package-lock.json` is absent, so image builds are not yet reproducible. It switches to `npm ci` on its own once a lockfile is committed.
