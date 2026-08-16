# Funnel — Dashboard

The browser UI for managing and consuming devices. Lists registered phones, shows their status, and lets you select one to view/listen to as a remote camera + microphone.

- **Framework:** React
- **Media:** WebRTC browser APIs (`RTCPeerConnection`, `getUserMedia` not required — subscribe only)

## Responsibilities

- Show all registered devices and live status (online, streaming, battery).
- Initiate a WebRTC session with a selected device (subscriber role).
- Render the remote video and play the remote audio.
- Trigger unregister / session teardown.

> For the simplest deployment, the dashboard can be served directly by [`../server`](../server). It lives in its own folder so it can be split out later if it grows.

## Status

🚧 Not yet implemented.
