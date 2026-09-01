/**
 * React state over the signaling client: one connection per mount, the device
 * registry it pushes, and at most one active media session.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceId, DeviceInfo, IceServer } from '@funnel/shared';
import { SIGNALING_URL, SignalingClient } from './signaling';
import type { SignalingStatus } from './signaling';
import { SubscriberSession } from './webrtc';
import type { SessionState } from './webrtc';

export interface UseDevices {
  status: SignalingStatus;
  devices: DeviceInfo[];
  selectedDeviceId: DeviceId | null;
  sessionState: SessionState | null;
  stream: MediaStream | null;
  error: string | null;
  view: (deviceId: DeviceId) => void;
  disconnect: () => void;
  refresh: () => void;
}

function upsert(devices: DeviceInfo[], device: DeviceInfo): DeviceInfo[] {
  const index = devices.findIndex((d) => d.deviceId === device.deviceId);
  if (index === -1) return [...devices, device];
  const next = devices.slice();
  next[index] = device;
  return next;
}

export function useDevices(url: string = SIGNALING_URL): UseDevices {
  const [status, setStatus] = useState<SignalingStatus>('idle');
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<DeviceId | null>(null);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<SignalingClient | null>(null);
  const sessionRef = useRef<SubscriberSession | null>(null);
  const iceServersRef = useRef<IceServer[]>([]);

  const endSession = useCallback((reason?: string) => {
    sessionRef.current?.close(reason);
    sessionRef.current = null;
    setStream(null);
    setSessionState(null);
    setSelectedDeviceId(null);
  }, []);

  useEffect(() => {
    const client = new SignalingClient(url);
    clientRef.current = client;

    const unsubscribes = [
      client.on('status', setStatus),
      client.on('ready', (ack) => {
        iceServersRef.current = ack.iceServers;
        setError(null);
      }),
      client.on('device-list', ({ devices: list }) => setDevices(list)),
      client.on('device-updated', ({ device }) => setDevices((prev) => upsert(prev, device))),
      client.on('device-removed', ({ deviceId }) => {
        setDevices((prev) => prev.filter((d) => d.deviceId !== deviceId));
        if (sessionRef.current?.deviceId === deviceId) endSession('device removed');
      }),
      client.on('error', (payload) => setError(`${payload.code}: ${payload.message}`)),
    ];

    client.connect();

    return () => {
      sessionRef.current?.close('dashboard closed');
      sessionRef.current = null;
      for (const unsubscribe of unsubscribes) unsubscribe();
      client.close();
      clientRef.current = null;
    };
  }, [url, endSession]);

  const view = useCallback(
    (deviceId: DeviceId) => {
      const client = clientRef.current;
      if (!client || !client.connected) {
        setError('not connected to the signaling server');
        return;
      }
      sessionRef.current?.close('switching device');
      setStream(null);
      setError(null);
      setSelectedDeviceId(deviceId);

      const session = new SubscriberSession({
        signaling: client,
        deviceId,
        iceServers: iceServersRef.current,
        onStream: setStream,
        onState: (next) => {
          setSessionState(next);
          if (next === 'closed' && sessionRef.current === session) {
            sessionRef.current = null;
            setStream(null);
            setSelectedDeviceId(null);
          }
        },
      });
      sessionRef.current = session;
      session.start().catch((err: unknown) => {
        setError(`failed to start session: ${String(err)}`);
        endSession('offer failed');
      });
    },
    [endSession],
  );

  const disconnect = useCallback(() => endSession(), [endSession]);
  const refresh = useCallback(() => clientRef.current?.listDevices(), []);

  return {
    status,
    devices,
    selectedDeviceId,
    sessionState,
    stream,
    error,
    view,
    disconnect,
    refresh,
  };
}
