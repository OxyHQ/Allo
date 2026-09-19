/**
 * The ICE configuration this process serves, read once at boot.
 *
 * Separate from `turn.ts` for the same reason the push config is separate from
 * its senders: reading the environment is a boot-time decision that should
 * fail loudly, and answering a request is a hot path that should not re-parse
 * anything.
 */

import { readIceConfig, type IceConfig } from "./turn";

let current: IceConfig | null = null;

/** Called once from `server.ts`, so a half-configured relay fails the boot. */
export function setIceConfig(config: IceConfig): void {
  current = config;
}

/** STUN only until a relay is configured, which is also what tests see. */
export function getIceConfig(): IceConfig {
  return current ?? (current = readIceConfig({}));
}

export function clearIceConfig(): void {
  current = null;
}
