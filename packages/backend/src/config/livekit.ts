/**
 * The SFU, for group calls.
 *
 * A 1:1 call is peer to peer (or through the TURN relay; see `turn.ts`). A
 * group call goes through LiveKit, because a mesh caps the feature at about
 * four people — `docs/adr/0002-calls-status-presence.md`, Decision 1.
 *
 * **The credentials are shared across Oxy and this app does not own them.**
 * `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` live at `/oxy/_shared/` in SSM,
 * are written by OxyHQServices, and are bound to each service by terraform in
 * `oxy-infra`. Nothing in Allo may `sync_secret` them: that would overwrite
 * the value every other Oxy app is using. `LIVEKIT_URL` is a plain container
 * environment variable, `wss://livekit.oxy.so`.
 *
 * Unconfigured is a legal state and not an error at boot: 1:1 calls work
 * without an SFU, so a deployment with no LiveKit refuses the group-call
 * ticket with a reason and leaves everything else alone. A HALF-configured one
 * is not legal — somebody meant to finish it — and fails the boot, the same
 * rule `turn.ts` follows.
 */

export interface LiveKitConfig {
  /** The `wss://` URL a client connects to. */
  url: string;
  apiKey: string;
  apiSecret: string;
  ttlSeconds: number;
}

/**
 * An hour, the same as a TURN credential and for the same reason: longer than
 * a call, short enough that a leaked one expires while it still matters. A
 * longer call refreshes, which is what `expiresAt` in the response is for.
 */
export const DEFAULT_SFU_TTL_SECONDS = 3600;

export function readLiveKitConfig(env: NodeJS.ProcessEnv = process.env): LiveKitConfig | null {
  const url = (env.LIVEKIT_URL ?? "").trim();
  const apiKey = (env.LIVEKIT_API_KEY ?? "").trim();
  const apiSecret = (env.LIVEKIT_API_SECRET ?? "").trim();
  const present = [url, apiKey, apiSecret].filter((value) => value.length > 0).length;
  if (present === 0) return null;
  if (present < 3) {
    throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set together or not at all");
  }

  const ttl = Number(env.LIVEKIT_TTL_SECONDS ?? DEFAULT_SFU_TTL_SECONDS);
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > 86_400) {
    throw new Error("LIVEKIT_TTL_SECONDS must be between 60 and 86400");
  }
  return { url, apiKey, apiSecret, ttlSeconds: ttl };
}

/** One room per call. Prefixed so a LiveKit console shows what a room is for. */
export function callRoomName(callId: string): string {
  return `allo_call_${callId}`;
}
