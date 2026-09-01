/**
 * Device registry: who is registered, and whether they are still alive.
 *
 * Presence is TTL-based — a device stays `online` as long as heartbeats keep
 * arriving inside PRESENCE_TTL_MS. A sweep timer flips stale devices offline
 * without waiting for the socket to notice it died.
 *
 * Redis is out of scope for this pass; `DeviceRegistry` exists so a
 * Redis-backed implementation can replace `InMemoryDeviceRegistry` without the
 * connection layer changing.
 */

import { HEARTBEAT_INTERVAL_MS, PRESENCE_TTL_MS } from '@funnel/shared';
import type {
  DeviceId,
  DeviceInfo,
  HeartbeatPayload,
  RegisterPayload,
} from '@funnel/shared';

export type RegistryEvent =
  | { type: 'device-updated'; device: DeviceInfo }
  | { type: 'device-removed'; deviceId: DeviceId };

export type RegistryListener = (event: RegistryEvent) => void;

export interface ListOptions {
  includeOffline?: boolean;
}

export interface RegistryCounts {
  total: number;
  online: number;
}

export interface DeviceRegistry {
  register(payload: RegisterPayload): DeviceInfo;
  /** Refreshes presence. Returns undefined when the device is unknown. */
  heartbeat(deviceId: DeviceId, payload: HeartbeatPayload): DeviceInfo | undefined;
  unregister(deviceId: DeviceId): boolean;
  /** Presence lost (socket closed) but the device stays in the registry. */
  markOffline(deviceId: DeviceId): DeviceInfo | undefined;
  get(deviceId: DeviceId): DeviceInfo | undefined;
  list(options?: ListOptions): DeviceInfo[];
  counts(): RegistryCounts;
  /** Returns an unsubscribe function. */
  subscribe(listener: RegistryListener): () => void;
  close(): void;
}

export class InMemoryDeviceRegistry implements DeviceRegistry {
  readonly #devices = new Map<DeviceId, DeviceInfo>();
  readonly #listeners = new Set<RegistryListener>();
  readonly #sweepTimer: NodeJS.Timeout;

  constructor(sweepIntervalMs: number = HEARTBEAT_INTERVAL_MS) {
    this.#sweepTimer = setInterval(() => this.#sweep(), sweepIntervalMs);
    // Presence sweeping must never be the reason the process stays alive.
    this.#sweepTimer.unref();
  }

  register(payload: RegisterPayload): DeviceInfo {
    const device: DeviceInfo = {
      deviceId: payload.deviceId,
      name: payload.name,
      capabilities: payload.capabilities,
      online: true,
      streaming: false,
      battery: payload.battery ?? null,
      lastSeenAt: Date.now(),
    };
    this.#devices.set(device.deviceId, device);
    this.#emit({ type: 'device-updated', device });
    return device;
  }

  heartbeat(deviceId: DeviceId, payload: HeartbeatPayload): DeviceInfo | undefined {
    const current = this.#devices.get(deviceId);
    if (current === undefined) return undefined;

    const next: DeviceInfo = {
      ...current,
      online: true,
      streaming: payload.streaming ?? current.streaming,
      battery: payload.battery === undefined ? current.battery : payload.battery,
      lastSeenAt: Date.now(),
    };
    this.#devices.set(deviceId, next);

    // Heartbeats are frequent; only wake subscribers when something they render
    // actually moved.
    if (
      next.online !== current.online ||
      next.streaming !== current.streaming ||
      next.battery !== current.battery
    ) {
      this.#emit({ type: 'device-updated', device: next });
    }
    return next;
  }

  unregister(deviceId: DeviceId): boolean {
    if (!this.#devices.delete(deviceId)) return false;
    this.#emit({ type: 'device-removed', deviceId });
    return true;
  }

  markOffline(deviceId: DeviceId): DeviceInfo | undefined {
    const current = this.#devices.get(deviceId);
    if (current === undefined) return undefined;
    if (!current.online && !current.streaming) return current;

    const next: DeviceInfo = { ...current, online: false, streaming: false };
    this.#devices.set(deviceId, next);
    this.#emit({ type: 'device-updated', device: next });
    return next;
  }

  get(deviceId: DeviceId): DeviceInfo | undefined {
    return this.#devices.get(deviceId);
  }

  list(options: ListOptions = {}): DeviceInfo[] {
    const devices = [...this.#devices.values()];
    return options.includeOffline === true
      ? devices
      : devices.filter((device) => device.online);
  }

  counts(): RegistryCounts {
    let online = 0;
    for (const device of this.#devices.values()) {
      if (device.online) online += 1;
    }
    return { total: this.#devices.size, online };
  }

  subscribe(listener: RegistryListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    clearInterval(this.#sweepTimer);
    this.#listeners.clear();
  }

  #sweep(): void {
    const deadline = Date.now() - PRESENCE_TTL_MS;
    for (const device of this.#devices.values()) {
      if (device.online && device.lastSeenAt < deadline) {
        this.markOffline(device.deviceId);
      }
    }
  }

  #emit(event: RegistryEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[registry] listener threw', error);
      }
    }
  }
}
