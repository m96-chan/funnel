# Funnel — Infra

Deployment and networking configuration: the STUN/TURN server, container setup, and environment templates.

## Contents (planned)

- `coturn/` — STUN/TURN (coturn) configuration for NAT/CGNAT traversal.
- `docker-compose.yml` — local stack: server + Redis + coturn.
- `.env.example` — environment variables for the server and TURN credentials.

## Why TURN is needed

Phones on mobile networks or behind symmetric NAT often cannot establish a direct WebRTC connection. A TURN relay (coturn) forwards the encrypted media so the session still works. Plan to run your own for reliable operation.

## Status

🚧 Not yet implemented.
