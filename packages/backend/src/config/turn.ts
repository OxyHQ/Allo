/**
 * The relay's configuration, and the credentials it accepts.
 *
 * A TURN server is what carries a call when a NAT will not let two devices
 * talk directly — the fifteen per cent or so — and, when somebody turns on
 * "hide my IP address in calls", every call they are in.
 *
 * **The credential is the 2013 REST scheme, which never became an RFC and is
 * what every TURN server implements**: `username = "<expiry>:<account>"`,
 * `credential = base64(HMAC-SHA1(secret, username))`, verified by the relay
 * against a shared secret without a round trip to us. coturn calls it
 * `use-auth-secret`; LiveKit's own external-TURN support reads the same shape,
 * so ONE relay and one secret serve both the peer-to-peer path and the SFU.
 *
 * Two deviations from the draft, both deliberate:
 *
 * - **A short TTL.** The draft suggested a day; this issues an hour, which is
 *   longer than a call and short enough that a leaked credential is not a
 *   standing grant.
 * - **The account id in the username.** The relay's own logs and quotas are
 *   then per account rather than per process, which is what makes abuse
 *   answerable.
 *
 * Unconfigured, this answers STUN only. That is honest — a call will still
 * connect whenever the network allows it directly — and it is what local
 * development looks like.
 */

import { createHmac } from "node:crypto";

export interface TurnConfig {
  /** `turn:` and `turns:` URLs, in the order a client should try them. */
  urls: readonly string[];
  /** Shared with the relay; never leaves this process. */
  secret: string;
  ttlSeconds: number;
}

export interface IceConfig {
  stunUrls: readonly string[];
  turn: TurnConfig | null;
}

/** An hour: longer than a call, short enough that a leaked credential expires while it still matters. */
export const DEFAULT_TURN_TTL_SECONDS = 3600;

/** Google's public STUN, which is what every WebRTC example uses and costs nothing. */
const DEFAULT_STUN = ["stun:stun.l.google.com:19302"] as const;

/**
 * Read once at boot, so a half-configured relay fails the boot rather than
 * every call: a `TURN_URLS` with no `TURN_SHARED_SECRET` is a configuration
 * somebody meant to finish.
 */
export function readIceConfig(env: NodeJS.ProcessEnv = process.env): IceConfig {
  const urls = (env.TURN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  const secret = (env.TURN_SHARED_SECRET ?? "").trim();
  const stunUrls = (env.STUN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  if (urls.length > 0 && secret.length === 0) {
    throw new Error("TURN_URLS is set without TURN_SHARED_SECRET: the relay would refuse every credential");
  }
  if (urls.length === 0 && secret.length > 0) {
    throw new Error("TURN_SHARED_SECRET is set without TURN_URLS: there is no relay to use it with");
  }

  const ttl = Number(env.TURN_TTL_SECONDS ?? DEFAULT_TURN_TTL_SECONDS);
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > 86_400) {
    throw new Error("TURN_TTL_SECONDS must be between 60 and 86400");
  }

  return {
    stunUrls: stunUrls.length > 0 ? stunUrls : [...DEFAULT_STUN],
    turn: urls.length > 0 ? { urls, secret, ttlSeconds: ttl } : null,
  };
}

export interface IceCredential {
  username: string;
  credential: string;
  expiresAt: Date;
}

/** One short-lived credential for one account. The relay verifies it with the shared secret alone. */
export function mintTurnCredential(turn: TurnConfig, accountId: string, now = new Date()): IceCredential {
  const expiry = Math.floor(now.getTime() / 1000) + turn.ttlSeconds;
  const username = `${expiry}:${accountId}`;
  const credential = createHmac("sha1", turn.secret).update(username).digest("base64");
  return { username, credential, expiresAt: new Date(expiry * 1000) };
}
