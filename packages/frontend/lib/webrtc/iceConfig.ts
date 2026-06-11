/**
 * Centralized ICE (STUN/TURN) server configuration.
 *
 * Single source of truth consumed by BOTH the call peer connections
 * (`stores/callsStore.ts`) and the P2P data-channel manager
 * (`lib/p2pMessaging.ts`). Keeping it here means TURN credentials, STUN hosts
 * and any future relay policy live in exactly one place.
 *
 * Defaults to Google's public STUN servers (sufficient for most direct/NAT
 * traversal). A TURN relay is added when the deployment provides one via env:
 *   - `EXPO_PUBLIC_TURN_URL`   e.g. `turn:turn.example.com:3478`
 *   - `EXPO_PUBLIC_TURN_USER`  TURN username (optional but usual)
 *   - `EXPO_PUBLIC_TURN_PASS`  TURN credential (optional but usual)
 *
 * Without a TURN server, calls between peers behind symmetric NATs may fail to
 * connect — that's the documented production limitation (see report/concerns),
 * not a bug in this module.
 */

/** Public STUN servers used for NAT discovery when no override is configured. */
export const DEFAULT_STUN_URLS: readonly string[] = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

/**
 * Build the ICE server list. STUN defaults are always present; a TURN relay is
 * appended when `EXPO_PUBLIC_TURN_URL` is set. The result is a fresh array on
 * every call so callers can't accidentally mutate shared config.
 */
export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: [...DEFAULT_STUN_URLS] }];

  const turnUrl = process.env.EXPO_PUBLIC_TURN_URL;
  if (turnUrl) {
    const turnUser = process.env.EXPO_PUBLIC_TURN_USER;
    const turnPass = process.env.EXPO_PUBLIC_TURN_PASS;
    const turnServer: RTCIceServer = { urls: turnUrl };
    if (turnUser) turnServer.username = turnUser;
    if (turnPass) turnServer.credential = turnPass;
    servers.push(turnServer);
  }

  return servers;
}

/** True when a TURN relay is configured (useful for diagnostics/telemetry). */
export function hasTurnServer(): boolean {
  return !!process.env.EXPO_PUBLIC_TURN_URL;
}
