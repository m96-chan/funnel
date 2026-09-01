/**
 * Typed WebSocket signaling client for the subscriber (dashboard) role.
 *
 * Owns the connection to the server in `../../server`: handshake, device
 * discovery, and relaying WebRTC messages to/from a publisher. Message shapes
 * come from `@funnel/shared` — nothing is redefined here.
 */

import {
  PROTOCOL_VERSION,
  ProtocolError,
  parseEnvelope,
  serialize,
  toPeer,
  toServer,
} from '@funnel/shared';
import type {
  AnswerPayload,
  ClientMessage,
  DeviceId,
  DeviceListPayload,
  DeviceRemovedPayload,
  DeviceUpdatedPayload,
  Envelope,
  ErrorPayload,
  HelloAckPayload,
  IceCandidatePayload,
  IceServer,
  OfferPayload,
  SessionEndPayload,
} from '@funnel/shared';

/** Narrows the shared `ClientMessage` union down to one message type. */
type ClientMessageOf<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>;

export type SignalingStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

/** A message the broker relayed from a publisher. */
export interface PeerEvent<TPayload> {
  from: DeviceId;
  payload: TPayload;
}

export interface SignalingEventMap {
  status: SignalingStatus;
  /** Handshake completed — the connection is usable. */
  ready: HelloAckPayload;
  'device-list': DeviceListPayload;
  'device-updated': DeviceUpdatedPayload;
  'device-removed': DeviceRemovedPayload;
  answer: PeerEvent<AnswerPayload>;
  'ice-candidate': PeerEvent<IceCandidatePayload>;
  'session-end': PeerEvent<SessionEndPayload>;
  error: ErrorPayload;
}

type Listener<K extends keyof SignalingEventMap> = (value: SignalingEventMap[K]) => void;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

export class SignalingClient {
  readonly url: string;

  private socket: WebSocket | null = null;
  private status: SignalingStatus = 'idle';
  private clientId: string | null = null;
  private iceServers: IceServer[] = [];
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private readonly listeners = new Map<string, Set<(value: never) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  get id(): string | null {
    return this.clientId;
  }

  get ice(): IceServer[] {
    return this.iceServers;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    this.closedByUser = false;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.send(
        toServer<ClientMessageOf<'hello'>>('hello', {
          protocolVersion: PROTOCOL_VERSION,
          role: 'subscriber',
        }),
      );
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        this.dispatch(parseEnvelope(event.data));
      } catch (err) {
        if (err instanceof ProtocolError) {
          this.emit('error', { code: err.code, message: err.message });
        } else {
          throw err;
        }
      }
    };

    socket.onclose = () => {
      this.socket = null;
      this.clientId = null;
      if (this.closedByUser) {
        this.setStatus('closed');
        return;
      }
      this.setStatus('reconnecting');
      this.scheduleReconnect();
    };

    // `onclose` always follows `onerror`, so reconnect is handled there.
    socket.onerror = () => {
      this.emit('error', { code: 'internal', message: 'signaling socket error' });
    };
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setStatus('closed');
  }

  listDevices(includeOffline = false): void {
    this.send(toServer<ClientMessageOf<'list-devices'>>('list-devices', { includeOffline }));
  }

  sendOffer(to: DeviceId, payload: OfferPayload): void {
    this.send(toPeer<ClientMessageOf<'offer'>>('offer', to, payload));
  }

  sendIceCandidate(to: DeviceId, payload: IceCandidatePayload): void {
    this.send(toPeer<ClientMessageOf<'ice-candidate'>>('ice-candidate', to, payload));
  }

  sendSessionEnd(to: DeviceId, payload: SessionEndPayload): void {
    this.send(toPeer<ClientMessageOf<'session-end'>>('session-end', to, payload));
  }

  on<K extends keyof SignalingEventMap>(type: K, listener: Listener<K>): () => void {
    const set = this.listeners.get(type) ?? new Set<(value: never) => void>();
    this.listeners.set(type, set);
    set.add(listener as (value: never) => void);
    return () => {
      set.delete(listener as (value: never) => void);
    };
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      console.warn('[signaling] dropped %s — socket not open', message.type);
      return;
    }
    this.socket.send(serialize(message));
  }

  private dispatch(envelope: Envelope): void {
    const from = envelope.from ?? '';

    switch (envelope.type) {
      case 'hello-ack': {
        const payload = envelope.payload as HelloAckPayload;
        this.clientId = payload.id;
        this.iceServers = payload.iceServers;
        this.setStatus('connected');
        this.emit('ready', payload);
        this.listDevices();
        return;
      }
      case 'device-list':
        this.emit('device-list', envelope.payload as DeviceListPayload);
        return;
      case 'device-updated':
        this.emit('device-updated', envelope.payload as DeviceUpdatedPayload);
        return;
      case 'device-removed':
        this.emit('device-removed', envelope.payload as DeviceRemovedPayload);
        return;
      case 'answer':
        this.emit('answer', { from, payload: envelope.payload as AnswerPayload });
        return;
      case 'ice-candidate':
        this.emit('ice-candidate', { from, payload: envelope.payload as IceCandidatePayload });
        return;
      case 'session-end':
        this.emit('session-end', { from, payload: envelope.payload as SessionEndPayload });
        return;
      case 'error':
        this.emit('error', envelope.payload as ErrorPayload);
        return;
      default:
        console.warn('[signaling] ignoring unexpected message %s', envelope.type);
    }
  }

  private emit<K extends keyof SignalingEventMap>(type: K, value: SignalingEventMap[K]): void {
    for (const listener of this.listeners.get(type) ?? []) {
      (listener as Listener<K>)(value);
    }
  }

  private setStatus(next: SignalingStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.emit('status', next);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.connect();
    }, delay);
  }
}

/** Build-time configured signaling endpoint; see `.env.example`. */
export const SIGNALING_URL: string =
  import.meta.env.VITE_SIGNALING_URL ?? 'ws://localhost:8080/ws';
