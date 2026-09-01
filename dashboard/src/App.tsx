import { useEffect, useRef } from 'react';
import type { DeviceInfo } from '@funnel/shared';
import { SIGNALING_URL } from './signaling';
import { useDevices } from './useDevices';

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  connecting: 'connecting…',
  connected: 'connected',
  reconnecting: 'reconnecting…',
  closed: 'disconnected',
};

function formatBattery(battery: number | null): string {
  return battery === null ? '—' : `${Math.round(battery * 100)}%`;
}

function formatLastSeen(lastSeenAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - lastSeenAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function DeviceRow({
  device,
  selected,
  onView,
}: {
  device: DeviceInfo;
  selected: boolean;
  onView: () => void;
}) {
  return (
    <tr className={selected ? 'selected' : undefined}>
      <td>
        <span className="device-name">{device.name}</span>
        <span className="device-id">{device.deviceId}</span>
      </td>
      <td>
        <span className={device.online ? 'dot online' : 'dot offline'} />
        {device.online ? 'online' : 'offline'}
      </td>
      <td>{device.streaming ? 'streaming' : 'idle'}</td>
      <td>{formatBattery(device.battery)}</td>
      <td>{formatLastSeen(device.lastSeenAt)}</td>
      <td>
        <button type="button" onClick={onView} disabled={!device.online || selected}>
          {selected ? 'Viewing' : 'View'}
        </button>
      </td>
    </tr>
  );
}

export function App() {
  const { status, devices, selectedDeviceId, sessionState, stream, error, view, disconnect, refresh } =
    useDevices();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
  }, [stream]);

  const selected = devices.find((d) => d.deviceId === selectedDeviceId) ?? null;

  return (
    <div className="app">
      <header>
        <h1>Funnel</h1>
        <div className="connection">
          <span className={`dot ${status === 'connected' ? 'online' : 'offline'}`} />
          {STATUS_LABEL[status] ?? status}
          <code>{SIGNALING_URL}</code>
          <button type="button" onClick={refresh} disabled={status !== 'connected'}>
            Refresh
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <section className="viewer">
        <video ref={videoRef} autoPlay playsInline className={stream ? undefined : 'empty'} />
        <div className="viewer-bar">
          <span>
            {selected
              ? `${selected.name} — ${sessionState ?? 'idle'}`
              : 'No device selected'}
          </span>
          <button type="button" onClick={disconnect} disabled={!selectedDeviceId}>
            Disconnect
          </button>
        </div>
      </section>

      <section className="devices">
        <h2>Devices</h2>
        {devices.length === 0 ? (
          <p className="empty-state">No devices registered yet. Start the Funnel app on a phone.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Presence</th>
                <th>State</th>
                <th>Battery</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <DeviceRow
                  key={device.deviceId}
                  device={device}
                  selected={device.deviceId === selectedDeviceId}
                  onView={() => view(device.deviceId)}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
