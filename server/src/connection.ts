/**
 * Per-connection state machine and the hub that routes between connections.
 *
 * A connection is anonymous until it completes the `hello` handshake, after
 * which it holds a server-assigned id and a role. Publishers additionally bind
 * a `deviceId` alias once they register, so subscribers can address a phone by
 * the id they saw in `device-list`.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';

import {
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  ProtocolError,
  errorMessage,
  isRelayedMessageType,
  parseEnvelope,
  serialize,
} from '@funnel/shared';
import type {
  DeviceCapabilities,
  Envelope,
  ErrorCode,
  Role,
  ServerMessage,
} from '@funnel/shared';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';

import type { ServerConfig } from './config.js';
import type { DeviceRegistry, RegistryEvent } from './registry.js';

/** How long an un-handshaked socket may stay connected. */
const HELLO_TIMEOUT_MS = 10_000;

export interface HubCounts {
  total: number;
  publishers: number;
  subscribers: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCapabilities(value: unknown): DeviceCapabilities | null {
  if (!isRecord(value)) return null;
  const { video, audio, maxResolution } = value;
  if (
    typeof video !== 'boolean' ||
    typeof audio !== 'boolean' ||
    typeof maxResolution !== 'string'
  ) {
    return null;
  }
  return { video, audio, maxResolution };
}

function parseRole(value: unknown): Role | null {
  return value === 'publisher' || value === 'subscriber' ? (value as Role) : null;
}

/** Battery is 0..1, or null when the device does not report it. */
function parseBattery(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

class Connection {
  readonly socket: WebSocket;
  /** Assigned at `hello`; null while the connection is still anonymous. */
  id: string | null = null;
  role: Role | null = null;
  deviceId: string | null = null;
  /** Flipped by the pong handler; the liveness sweep terminates stale sockets. */
  alive = true;
  /** Cleared once `hello` lands; an anonymous socket is not allowed to linger. */
  helloTimer: NodeJS.Timeout | null = null;

  constructor(socket: WebSocket) {
    this.socket = socket;
  }

  send(message: ServerMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(serialize(message));
  }

  sendError(code: ErrorCode, message: string, requestId?: string): void {
    this.send(errorMessage(code, message, requestId));
  }

  get label(): string {
    return this.id ?? 'anonymous';
  }
}

export class ConnectionHub {
  readonly #config: ServerConfig;
  readonly #registry: DeviceRegistry;
  /** Every live socket, including ones that have not handshaked yet. */
  readonly #all = new Set<Connection>();
  /** Handshaked connections, by server-assigned id. */
  readonly #connections = new Map<string, Connection>();
  /** deviceId -> connection, for publishers that have registered. */
  readonly #devices = new Map<string, Connection>();
  readonly #unsubscribe: () => void;
  readonly #livenessTimer: NodeJS.Timeout;

  constructor(config: ServerConfig, registry: DeviceRegistry) {
    this.#config = config;
    this.#registry = registry;
    this.#unsubscribe = registry.subscribe((event) => this.#pushToSubscribers(event));
    this.#livenessTimer = setInterval(() => this.#sweepLiveness(), HEARTBEAT_INTERVAL_MS);
    this.#livenessTimer.unref();
  }

  accept(socket: WebSocket): void {
    const connection = new Connection(socket);
    this.#all.add(connection);
    connection.helloTimer = setTimeout(() => {
      if (connection.id === null) socket.close(1008, 'handshake timeout');
    }, HELLO_TIMEOUT_MS);

    socket.on('message', (data: RawData) => this.#onMessage(connection, data));
    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('error', (error) => {
      console.error(`[hub] socket error (${connection.label})`, error);
    });
    socket.on('close', () => this.#onClose(connection));
  }

  counts(): HubCounts {
    let publishers = 0;
    let subscribers = 0;
    for (const connection of this.#connections.values()) {
      if (connection.role === 'publisher') publishers += 1;
      else if (connection.role === 'subscriber') subscribers += 1;
    }
    return { total: this.#connections.size, publishers, subscribers };
  }

  close(): void {
    clearInterval(this.#livenessTimer);
    this.#unsubscribe();
    for (const connection of this.#all) {
      connection.socket.close(1001, 'server shutting down');
    }
  }

  /* ---------------------------------------------------------------- *
   * Message dispatch
   * ---------------------------------------------------------------- */

  #onMessage(connection: Connection, data: RawData): void {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(data.toString());
    } catch (error) {
      const code: ErrorCode = error instanceof ProtocolError ? error.code : 'internal';
      connection.sendError(code, error instanceof Error ? error.message : 'bad frame');
      return;
    }

    const requestId = envelope.requestId;

    try {
      if (connection.id === null) {
        if (envelope.type !== 'hello') {
          connection.sendError('unauthorized', 'send "hello" first', requestId);
          connection.socket.close(1008, 'handshake required');
          return;
        }
        this.#onHello(connection, envelope);
        return;
      }

      if (isRelayedMessageType(envelope.type)) {
        this.#relay(connection, envelope);
        return;
      }

      switch (envelope.type) {
        case 'hello':
          connection.sendError('malformed-message', 'already handshaked', requestId);
          return;
        case 'register':
        case 'heartbeat':
        case 'unregister':
          this.#onPresence(connection, envelope);
          return;
        case 'list-devices':
          this.#onListDevices(connection, envelope);
          return;
        default:
          connection.sendError(
            'malformed-message',
            `unsupported message type "${envelope.type}"`,
            requestId,
          );
      }
    } catch (error) {
      console.error(`[hub] handler failed (${connection.label})`, error);
      connection.sendError('internal', 'internal server error', requestId);
    }
  }

  #onHello(connection: Connection, envelope: Envelope): void {
    const payload = envelope.payload as Record<string, unknown>;
    const requestId = envelope.requestId;

    const version = payload['protocolVersion'];
    if (typeof version !== 'number' || version !== PROTOCOL_VERSION) {
      connection.sendError(
        'protocol-version-mismatch',
        `server speaks protocol version ${PROTOCOL_VERSION}`,
        requestId,
      );
      connection.socket.close(1008, 'protocol version mismatch');
      return;
    }

    const role = parseRole(payload['role']);
    if (role === null) {
      connection.sendError('malformed-message', 'role must be publisher or subscriber', requestId);
      connection.socket.close(1008, 'invalid role');
      return;
    }

    if (this.#config.authToken !== null && !tokenMatches(this.#config.authToken, payload['token'])) {
      connection.sendError('unauthorized', 'invalid or missing token', requestId);
      connection.socket.close(1008, 'unauthorized');
      return;
    }

    if (connection.helloTimer !== null) {
      clearTimeout(connection.helloTimer);
      connection.helloTimer = null;
    }
    connection.id = randomUUID();
    connection.role = role;
    this.#connections.set(connection.id, connection);

    connection.send({
      type: 'hello-ack',
      to: connection.id,
      requestId,
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        id: connection.id,
        iceServers: this.#config.iceServers,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      },
    });

    console.log(`[hub] ${role} connected (${connection.id})`);

    if (role === 'subscriber') {
      connection.send({
        type: 'device-list',
        to: connection.id,
        payload: { devices: this.#registry.list() },
      });
    }
  }

  #onPresence(connection: Connection, envelope: Envelope): void {
    const requestId = envelope.requestId;
    if (connection.role !== 'publisher') {
      connection.sendError('unauthorized', `"${envelope.type}" requires the publisher role`, requestId);
      return;
    }
    const payload = envelope.payload as Record<string, unknown>;

    if (envelope.type === 'register') {
      const deviceId = payload['deviceId'];
      const name = payload['name'];
      const capabilities = parseCapabilities(payload['capabilities']);
      if (typeof deviceId !== 'string' || deviceId.length === 0) {
        connection.sendError('malformed-message', 'register requires a "deviceId"', requestId);
        return;
      }
      if (typeof name !== 'string' || name.length === 0) {
        connection.sendError('malformed-message', 'register requires a "name"', requestId);
        return;
      }
      if (capabilities === null) {
        connection.sendError('malformed-message', 'register requires valid "capabilities"', requestId);
        return;
      }

      // A reconnecting phone re-registers the same deviceId; the newest socket
      // owns the alias and the stale one keeps only its assigned id.
      const previous = this.#devices.get(deviceId);
      if (previous !== undefined && previous !== connection) {
        previous.deviceId = null;
      }
      if (connection.deviceId !== null && connection.deviceId !== deviceId) {
        this.#devices.delete(connection.deviceId);
      }

      connection.deviceId = deviceId;
      this.#devices.set(deviceId, connection);

      const device = this.#registry.register({
        deviceId,
        name,
        capabilities,
        battery: parseBattery(payload['battery']) ?? null,
      });
      connection.send({ type: 'registered', to: connection.id, requestId, payload: { device } });
      return;
    }

    if (connection.deviceId === null) {
      connection.sendError('not-registered', 'register before sending presence updates', requestId);
      return;
    }

    if (envelope.type === 'heartbeat') {
      const streaming = payload['streaming'];
      const updated = this.#registry.heartbeat(connection.deviceId, {
        battery: parseBattery(payload['battery']),
        ...(typeof streaming === 'boolean' ? { streaming } : {}),
      });
      if (updated === undefined) {
        connection.sendError('unknown-device', 'device is no longer registered', requestId);
      }
      return;
    }

    // unregister — the client may name a device, but it may only drop its own.
    const target = payload['deviceId'];
    if (typeof target === 'string' && target !== connection.deviceId) {
      connection.sendError('unauthorized', 'cannot unregister another device', requestId);
      return;
    }
    this.#registry.unregister(connection.deviceId);
    this.#devices.delete(connection.deviceId);
    connection.deviceId = null;
  }

  #onListDevices(connection: Connection, envelope: Envelope): void {
    const requestId = envelope.requestId;
    if (connection.role !== 'subscriber') {
      connection.sendError('unauthorized', '"list-devices" requires the subscriber role', requestId);
      return;
    }
    const includeOffline = (envelope.payload as Record<string, unknown>)['includeOffline'] === true;
    connection.send({
      type: 'device-list',
      to: connection.id,
      requestId,
      payload: { devices: this.#registry.list({ includeOffline }) },
    });
  }

  #relay(connection: Connection, envelope: Envelope): void {
    const requestId = envelope.requestId;
    const to = envelope.to;
    if (typeof to !== 'string' || to.length === 0) {
      connection.sendError('malformed-message', `"${envelope.type}" requires a "to" recipient`, requestId);
      return;
    }

    // Assigned ids are resolved first so a client cannot hijack a peer by
    // registering a deviceId that mimics someone's connection id.
    const target = this.#connections.get(to) ?? this.#devices.get(to);
    if (target === undefined || target.socket.readyState !== WebSocket.OPEN) {
      const known = this.#registry.get(to) !== undefined;
      connection.sendError(
        known ? 'device-offline' : 'unknown-device',
        `no connected peer "${to}"`,
        requestId,
      );
      return;
    }

    target.send({
      type: envelope.type,
      // `from` is always the server's view of the sender, never the client's
      // claim. A registered publisher is identified by its deviceId, because
      // that is the only id a subscriber ever sees (it comes from
      // `device-list`) and the only one it can match a reply against.
      from: connection.deviceId ?? connection.id ?? undefined,
      to,
      ...(requestId === undefined ? {} : { requestId }),
      payload: envelope.payload,
    } as ServerMessage);
  }

  /* ---------------------------------------------------------------- *
   * Fan-out & lifecycle
   * ---------------------------------------------------------------- */

  #pushToSubscribers(event: RegistryEvent): void {
    for (const connection of this.#connections.values()) {
      if (connection.role !== 'subscriber') continue;
      connection.send(
        event.type === 'device-updated'
          ? { type: 'device-updated', to: connection.id, payload: { device: event.device } }
          : { type: 'device-removed', to: connection.id, payload: { deviceId: event.deviceId } },
      );
    }
  }

  #onClose(connection: Connection): void {
    this.#all.delete(connection);
    if (connection.helloTimer !== null) {
      clearTimeout(connection.helloTimer);
      connection.helloTimer = null;
    }
    if (connection.id !== null) {
      this.#connections.delete(connection.id);
      console.log(`[hub] ${connection.role ?? 'client'} disconnected (${connection.id})`);
    }
    if (connection.deviceId !== null) {
      // A dropped socket is presence lost, not an unregister — the device keeps
      // its registry entry so the dashboard can show it as offline.
      if (this.#devices.get(connection.deviceId) === connection) {
        this.#devices.delete(connection.deviceId);
        this.#registry.markOffline(connection.deviceId);
      }
      connection.deviceId = null;
    }
  }

  #sweepLiveness(): void {
    for (const connection of this.#all) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }
}
