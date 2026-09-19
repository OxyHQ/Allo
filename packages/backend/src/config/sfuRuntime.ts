/**
 * The SFU configuration this process serves, read once at boot.
 *
 * Split from `livekit.ts` for the reason `iceRuntime.ts` is split from
 * `turn.ts`: reading the environment is a boot-time decision that should fail
 * loudly, and answering a request is a hot path that should not re-parse
 * anything.
 *
 * `null` is a legal state — 1:1 calls need no SFU — and the group-call ticket
 * refuses with `unavailable` rather than inventing a room.
 */

import type { LiveKitConfig } from "./livekit";

let current: LiveKitConfig | null = null;

/** Called once from `runtimeApp.ts`, so a half-configured SFU fails the boot. */
export function setLiveKitConfig(config: LiveKitConfig | null): void {
  current = config;
}

/** No SFU until one is configured, which is also what tests see. */
export function getLiveKitConfig(): LiveKitConfig | null {
  return current;
}

export function clearLiveKitConfig(): void {
  current = null;
}
