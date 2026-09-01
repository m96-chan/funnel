/**
 * Environment-driven server configuration. Read once at boot; everything else
 * takes a `ServerConfig` so nothing else has to touch `process.env`.
 */

import 'dotenv/config';

import type { IceServer } from '@funnel/shared';

export interface ServerConfig {
  host: string;
  port: number;
  /** Shared token every client must present in `hello`. Null disables auth. */
  authToken: string | null;
  iceServers: IceServer[];
}

const DEFAULT_STUN_URLS = 'stun:stun.l.google.com:19302';

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function readOptional(name: string): string | null {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? null : raw.trim();
}

function readPort(name: string, fallback: number): number {
  const raw = readOptional(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be a valid port number, got "${raw}"`);
  }
  return parsed;
}

/** Comma-separated list, e.g. `stun:a:3478,turn:b:3478?transport=udp`. */
function readList(name: string, fallback = ''): string[] {
  return readString(name, fallback)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function buildIceServers(): IceServer[] {
  const iceServers: IceServer[] = [];

  const stunUrls = readList('STUN_URLS', DEFAULT_STUN_URLS);
  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls });
  }

  const turnUrls = readList('TURN_URLS');
  if (turnUrls.length > 0) {
    const username = readOptional('TURN_USERNAME');
    const credential = readOptional('TURN_CREDENTIAL');
    if (username === null || credential === null) {
      console.warn(
        '[config] TURN_URLS is set without TURN_USERNAME/TURN_CREDENTIAL — most TURN servers will reject the relay allocation.',
      );
    }
    iceServers.push({
      urls: turnUrls,
      ...(username === null ? {} : { username }),
      ...(credential === null ? {} : { credential }),
    });
  }

  return iceServers;
}

export function loadConfig(): ServerConfig {
  const authToken = readOptional('FUNNEL_AUTH_TOKEN');
  if (authToken === null) {
    console.warn(
      '[config] ############################################################\n' +
        '[config] FUNNEL_AUTH_TOKEN is not set — AUTHENTICATION IS DISABLED.\n' +
        '[config] Any client that can reach this port may register a device,\n' +
        '[config] list devices and relay signaling. Development use only.\n' +
        '[config] ############################################################',
    );
  }

  return {
    host: readString('HOST', '0.0.0.0'),
    port: readPort('PORT', 8080),
    authToken,
    iceServers: buildIceServers(),
  };
}
