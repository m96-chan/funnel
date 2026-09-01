/**
 * Entry point: HTTP server for health checks, WebSocket server for signaling.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { WebSocketServer } from 'ws';

import { loadConfig } from './config.js';
import { ConnectionHub } from './connection.js';
import { InMemoryDeviceRegistry } from './registry.js';

const SHUTDOWN_GRACE_MS = 5_000;

const config = loadConfig();
const registry = new InMemoryDeviceRegistry();
const hub = new ConnectionHub(config, registry);

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
  const path = (request.url ?? '/').split('?')[0];
  if (request.method === 'GET' && path === '/healthz') {
    json(response, 200, {
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      devices: registry.counts(),
      connections: hub.counts(),
    });
    return;
  }
  json(response, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (socket) => hub.accept(socket));
wss.on('error', (error) => console.error('[ws] server error', error));

httpServer.listen(config.port, config.host, () => {
  console.log(`[funnel] signaling on ws://${config.host}:${config.port}`);
  console.log(`[funnel] health on http://${config.host}:${config.port}/healthz`);
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[funnel] ${signal} received, shutting down`);

  hub.close();
  registry.close();
  wss.close();
  httpServer.close(() => process.exit(0));

  // Sockets that ignore the close frame must not hold the process forever.
  setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
