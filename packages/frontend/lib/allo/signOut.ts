/**
 * SIGNING OUT OF ALLO — the one deliberate act that takes this device off the
 * account, and the only thing allowed to destroy its keys.
 *
 * The distinction this module exists to keep is between a session that has
 * GONE and a person who has LEFT.
 *
 * Oxy's `HttpService` clears the bearer on an unrecoverable 401 and emits
 * `onTokensChanged(null)`; `OxyContext` turns that into a locally signed-out
 * state while deliberately keeping the persisted session, because it treats
 * the null as transient — a cold-boot race, a refresh landing late, one 5xx on
 * a private endpoint — and expects a later reload to restore it. `AlloRoot`
 * used to read that same null as "the account went away" and reset the
 * client. That cost the device its signing key, and the revoke that went with
 * it could never land, because the credential it needed was the bearer that
 * had just gone. What the server kept was an ACTIVE instance nobody could
 * prove they owned, and what the person got, on their next reload, was
 * "approve this device" from a ghost that could never approve anything.
 *
 * So the order here is not decoration:
 *
 *   1. the push token goes first, while the session can still carry it;
 *   2. `client.reset()` revokes and wipes, also while the session is alive,
 *      which is the only moment the revoke can succeed;
 *   3. Oxy is told last.
 *
 * And the outcome is returned rather than swallowed. A revoke that did not
 * land leaves a device listed on the account that no device can remove from
 * the outside; the person is the one who has to hear that, in the one screen
 * that can act on it.
 */
import type { AlloClient, ResetOutcome } from '@allo/core';
import { logger } from '@/utils/logger';
import { clearPushToken } from './push';

/** Signs out of Oxy. `useOxy().logout`, narrowed to what this needs. */
export type Logout = () => Promise<unknown>;

/**
 * Leaves this device and then signs out of Oxy.
 *
 * Throws only what `logout` throws: the device is wiped either way, and a
 * failure to say so to the server is reported through {@link ResetOutcome}
 * rather than by refusing to sign out — somebody asking to leave a device,
 * possibly a borrowed one, is not made to stay on it by a network error.
 */
export async function signOutOfAllo(client: AlloClient, logout: Logout): Promise<ResetOutcome> {
  let outcome: ResetOutcome = { revoked: 'not-needed' };
  try {
    await clearPushToken(client);
  } catch (error) {
    logger.warn('[allo] clearing the push token on sign-out failed', error);
  }
  try {
    outcome = await client.reset();
  } catch (error) {
    // `reset()` wipes what it can regardless; there is no state worth keeping
    // on a device whose person has just left it.
    logger.error('[allo] resetting this device on sign-out failed', error);
  }
  await logout();
  return outcome;
}
