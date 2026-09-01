/**
 * Funnel signaling protocol.
 *
 * The wire contract between the Android app (publisher), the server (registry +
 * signaling broker) and the dashboard (subscriber). Mirrors `docs/protocol.md`;
 * that document is the prose, this file is the enforced shape.
 */

/** Protocol version carried in the `hello` handshake. Bump on breaking changes. */
export const PROTOCOL_VERSION = 1;

/** How often a publisher is expected to send a heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Presence TTL — a device with no heartbeat inside this window goes offline. */
export const PRESENCE_TTL_MS = 30_000;

export type Role = 'publisher' | 'subscriber';

export type DeviceId = string;
export type ClientId = string;
export type SessionId = string;

export interface DeviceCapabilities {
  video: boolean;
  audio: boolean;
  /** e.g. "720p", "1080p" — best resolution the device will publish. */
  maxResolution: string;
}

/** A device as the registry knows it. */
export interface DeviceInfo {
  deviceId: DeviceId;
  name: string;
  capabilities: DeviceCapabilities;
  online: boolean;
  streaming: boolean;
  /** 0..1, or null when the device does not report it. */
  battery: number | null;
  /** Epoch ms of the last heartbeat the server accepted. */
  lastSeenAt: number;
}

/** ICE server entry handed to both peers so they agree on STUN/TURN. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

/**
 * Every signaling message shares this envelope.
 *
 * `to` is null for messages addressed to the server itself (register,
 * heartbeat, list) and set to a peer id for messages the broker relays.
 */
export interface Envelope<TType extends string = string, TPayload = unknown> {
  type: TType;
  /** Sender id. Omitted on the first message; the server fills it in. */
  from?: DeviceId | ClientId;
  /** Recipient id, or null when the server is the recipient. */
  to?: DeviceId | ClientId | null;
  /** Correlates a request with its reply. */
  requestId?: string;
  payload: TPayload;
}

/* ------------------------------------------------------------------ *
 * Handshake
 * ------------------------------------------------------------------ */

export interface HelloPayload {
  protocolVersion: number;
  role: Role;
  /** Pairing/auth token. See "Open questions" in docs/protocol.md. */
  token?: string;
}

export interface HelloAckPayload {
  protocolVersion: number;
  /** Id the server assigned to this connection. */
  id: DeviceId | ClientId;
  iceServers: IceServer[];
  heartbeatIntervalMs: number;
}

/* ------------------------------------------------------------------ *
 * Registration & presence (publisher -> server)
 * ------------------------------------------------------------------ */

export interface RegisterPayload {
  deviceId: DeviceId;
  name: string;
  capabilities: DeviceCapabilities;
  battery?: number | null;
}

export interface RegisteredPayload {
  device: DeviceInfo;
}

export interface HeartbeatPayload {
  battery?: number | null;
  streaming?: boolean;
}

export interface UnregisterPayload {
  deviceId: DeviceId;
}

/* ------------------------------------------------------------------ *
 * Discovery (subscriber <-> server)
 * ------------------------------------------------------------------ */

export interface ListDevicesPayload {
  /** Include devices whose presence has expired. Defaults to false. */
  includeOffline?: boolean;
}

export interface DeviceListPayload {
  devices: DeviceInfo[];
}

export interface DeviceUpdatedPayload {
  device: DeviceInfo;
}

export interface DeviceRemovedPayload {
  deviceId: DeviceId;
}

/* ------------------------------------------------------------------ *
 * WebRTC signaling (relayed peer to peer by the broker)
 * ------------------------------------------------------------------ */

export interface OfferPayload {
  sessionId: SessionId;
  sdp: string;
}

export interface AnswerPayload {
  sessionId: SessionId;
  sdp: string;
}

export interface IceCandidatePayload {
  sessionId: SessionId;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export interface SessionEndPayload {
  sessionId: SessionId;
  reason?: string;
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export type ErrorCode =
  | 'unauthorized'
  | 'protocol-version-mismatch'
  | 'malformed-message'
  | 'unknown-device'
  | 'device-offline'
  | 'not-registered'
  | 'internal';

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
}

/* ------------------------------------------------------------------ *
 * Message unions
 * ------------------------------------------------------------------ */

/** Messages a client (publisher or subscriber) may send. */
export type ClientMessage =
  | Envelope<'hello', HelloPayload>
  | Envelope<'register', RegisterPayload>
  | Envelope<'heartbeat', HeartbeatPayload>
  | Envelope<'unregister', UnregisterPayload>
  | Envelope<'list-devices', ListDevicesPayload>
  | Envelope<'offer', OfferPayload>
  | Envelope<'answer', AnswerPayload>
  | Envelope<'ice-candidate', IceCandidatePayload>
  | Envelope<'session-end', SessionEndPayload>;

/** Messages the server may send. */
export type ServerMessage =
  | Envelope<'hello-ack', HelloAckPayload>
  | Envelope<'registered', RegisteredPayload>
  | Envelope<'device-list', DeviceListPayload>
  | Envelope<'device-updated', DeviceUpdatedPayload>
  | Envelope<'device-removed', DeviceRemovedPayload>
  | Envelope<'offer', OfferPayload>
  | Envelope<'answer', AnswerPayload>
  | Envelope<'ice-candidate', IceCandidatePayload>
  | Envelope<'session-end', SessionEndPayload>
  | Envelope<'error', ErrorPayload>;

export type AnyMessage = ClientMessage | ServerMessage;

export type ClientMessageType = ClientMessage['type'];
export type ServerMessageType = ServerMessage['type'];

/** Message types the broker relays verbatim between two peers. */
export const RELAYED_MESSAGE_TYPES = [
  'offer',
  'answer',
  'ice-candidate',
  'session-end',
] as const satisfies readonly ClientMessageType[];

export type RelayedMessageType = (typeof RELAYED_MESSAGE_TYPES)[number];

export function isRelayedMessageType(type: string): type is RelayedMessageType {
  return (RELAYED_MESSAGE_TYPES as readonly string[]).includes(type);
}
