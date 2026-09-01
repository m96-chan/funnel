/**
 * Runtime helpers over the protocol types: parsing untrusted frames off the
 * wire and building well-formed ones. Kept dependency-free so the server, the
 * dashboard and any future JS client can all use it.
 */

import type {
  AnyMessage,
  ClientMessage,
  Envelope,
  ErrorCode,
  ServerMessage,
} from './protocol.js';

export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a raw WebSocket frame into an envelope.
 *
 * Only validates the envelope itself — payload shapes are checked by whoever
 * handles the specific message type, which keeps this cheap on the hot path.
 *
 * @throws {ProtocolError} when the frame is not a usable envelope.
 */
export function parseEnvelope(raw: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError('malformed-message', 'frame is not valid JSON');
  }

  if (!isPlainObject(parsed)) {
    throw new ProtocolError('malformed-message', 'frame is not an object');
  }
  if (typeof parsed['type'] !== 'string' || parsed['type'].length === 0) {
    throw new ProtocolError('malformed-message', 'missing "type"');
  }
  if (!isPlainObject(parsed['payload'])) {
    throw new ProtocolError('malformed-message', 'missing "payload" object');
  }

  return parsed as unknown as Envelope;
}

export function serialize(message: AnyMessage): string {
  return JSON.stringify(message);
}

/** Build a message addressed to the server. */
export function toServer<T extends ClientMessage>(
  type: T['type'],
  payload: T['payload'],
  extra?: { from?: string; requestId?: string },
): ClientMessage {
  return { type, to: null, payload, ...extra } as ClientMessage;
}

/** Build a message the broker should relay to `to`. */
export function toPeer<T extends ClientMessage>(
  type: T['type'],
  to: string,
  payload: T['payload'],
  extra?: { from?: string; requestId?: string },
): ClientMessage {
  return { type, to, payload, ...extra } as ClientMessage;
}

export function errorMessage(
  code: ErrorCode,
  message: string,
  requestId?: string,
): ServerMessage {
  return { type: 'error', to: null, requestId, payload: { code, message } };
}
