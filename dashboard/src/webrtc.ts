/**
 * Subscriber side of a Funnel media session.
 *
 * The dashboard only receives: it adds recvonly transceivers, offers, and lets
 * the phone answer. Media is peer-to-peer — the server sees signaling only.
 */

import type {
  DeviceId,
  IceCandidatePayload,
  IceServer,
  SessionId,
} from '@funnel/shared';
import type { SignalingClient } from './signaling';

export type SessionState = 'connecting' | 'connected' | 'failed' | 'closed';

export interface SubscriberSessionOptions {
  signaling: SignalingClient;
  deviceId: DeviceId;
  iceServers: IceServer[];
  onStream: (stream: MediaStream) => void;
  onState: (state: SessionState) => void;
}

export class SubscriberSession {
  /** The subscriber owns session identity; the publisher echoes it back. */
  readonly sessionId: SessionId = crypto.randomUUID();
  readonly deviceId: DeviceId;

  private readonly signaling: SignalingClient;
  private readonly options: SubscriberSessionOptions;
  private readonly pc: RTCPeerConnection;
  private readonly stream = new MediaStream();
  private readonly unsubscribes: Array<() => void> = [];
  /** ICE that arrived before the answer was applied. */
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private closed = false;

  constructor(options: SubscriberSessionOptions) {
    this.options = options;
    this.signaling = options.signaling;
    this.deviceId = options.deviceId;
    this.pc = new RTCPeerConnection({ iceServers: options.iceServers });

    this.pc.addTransceiver('video', { direction: 'recvonly' });
    this.pc.addTransceiver('audio', { direction: 'recvonly' });

    this.pc.ontrack = (event) => {
      this.stream.addTrack(event.track);
      this.options.onStream(this.stream);
    };

    this.pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.signaling.sendIceCandidate(this.deviceId, {
        sessionId: this.sessionId,
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      });
    };

    this.pc.onconnectionstatechange = () => {
      switch (this.pc.connectionState) {
        case 'connected':
          this.options.onState('connected');
          break;
        case 'failed':
          this.options.onState('failed');
          break;
        case 'closed':
          this.options.onState('closed');
          break;
        default:
          break;
      }
    };

    this.unsubscribes.push(
      this.signaling.on('answer', ({ from, payload }) => {
        if (!this.isForThisSession(from, payload.sessionId)) return;
        void this.applyAnswer(payload.sdp);
      }),
      this.signaling.on('ice-candidate', ({ from, payload }) => {
        if (!this.isForThisSession(from, payload.sessionId)) return;
        void this.addRemoteCandidate(payload);
      }),
      this.signaling.on('session-end', ({ from, payload }) => {
        if (!this.isForThisSession(from, payload.sessionId)) return;
        this.close(payload.reason ?? 'ended by device', { notifyPeer: false });
      }),
    );
  }

  async start(): Promise<void> {
    this.options.onState('connecting');
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.sendOffer(this.deviceId, {
      sessionId: this.sessionId,
      sdp: this.pc.localDescription?.sdp ?? offer.sdp ?? '',
    });
  }

  close(reason = 'closed by user', opts: { notifyPeer?: boolean } = {}): void {
    if (this.closed) return;
    this.closed = true;

    if (opts.notifyPeer !== false) {
      this.signaling.sendSessionEnd(this.deviceId, { sessionId: this.sessionId, reason });
    }
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    for (const track of this.stream.getTracks()) track.stop();

    this.pc.ontrack = null;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
    this.options.onState('closed');
  }

  private isForThisSession(from: DeviceId, sessionId: SessionId): boolean {
    return !this.closed && from === this.deviceId && sessionId === this.sessionId;
  }

  private async applyAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    this.remoteDescriptionSet = true;
    for (const candidate of this.pendingCandidates.splice(0)) {
      await this.pc.addIceCandidate(candidate);
    }
  }

  private async addRemoteCandidate(payload: IceCandidatePayload): Promise<void> {
    const candidate: RTCIceCandidateInit = {
      candidate: payload.candidate,
      sdpMid: payload.sdpMid,
      sdpMLineIndex: payload.sdpMLineIndex,
    };
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate);
  }
}
