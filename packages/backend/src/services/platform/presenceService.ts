/**
 * Presence, and the four rules that decide who may see it.
 *
 * In check order, because the order is the design:
 *
 * 1. **Reciprocity.** An account with `privacy_show_online_status` off
 *    publishes nothing AND receives nothing. One switch, both directions.
 *    WhatsApp's rule, adopted here for the same reason: a one-way hide is a
 *    free observation post, and adding the other direction later would take
 *    something away from people who already had it.
 * 2. **A shared conversation.** You may ask about accounts you talk to.
 *    Presence is not a directory: without this rule an account id is enough to
 *    watch a stranger's sleep schedule, which is the published attack on every
 *    messenger that shipped an online dot.
 * 3. **Blocks, both ways.** Either direction of a block hides both accounts
 *    from each other.
 * 4. **Nothing else is distinguishable.** Hidden, blocked, never seen and
 *    plainly offline all answer `{ online: false, lastSeenAt: null }`. A
 *    client that could tell them apart could tell that it had been blocked.
 *
 * What the server knows regardless is in `threat-model.md` §5: it computes
 * presence, so the operator can see it. These rules are about everybody else.
 */

import {
  PRESENCE_LAST_SEEN_RESOLUTION_MS,
  type PresenceResponse,
  type PresenceState,
} from "@allo/shared-types";
import { getDb, type AlloDatabase } from "../../db";
import { listSharedAccountsAmong } from "../../db/platform/conversationRepository";
import { lastSeenOf, touchLastSeen } from "../../db/platform/presenceRepository";
import { blockedEitherWay } from "../../db/social/blockRepository";
import { showOnlineStatusOf } from "../../db/social/userSettingsRepository";
import { getPresenceStore, type PresenceStore } from "../../runtime/presenceStore";

export interface PresenceServiceDeps {
  db?: AlloDatabase;
  store?: PresenceStore;
  now?: () => Date;
}

/** The answer for an account this viewer may not see. The same one, four ways. */
export const hiddenPresence = (accountId: string): PresenceState => ({
  accountId,
  online: false,
  lastSeenAt: null,
});

/** Truncated to the minute: a second-accurate last seen tracks better than the dot beside it. */
function coarse(at: Date): string {
  return new Date(Math.floor(at.getTime() / PRESENCE_LAST_SEEN_RESOLUTION_MS) * PRESENCE_LAST_SEEN_RESOLUTION_MS).toISOString();
}

/**
 * Which of `accountIds` this viewer is allowed an honest answer about.
 *
 * Three queries, none of them per account. The result is worth caching for a
 * short while by a caller that asks repeatedly — the socket hub does — but not
 * for long: a block should stop being visible within a minute of being made,
 * not at the next sign-in.
 */
export async function visibleTo(
  viewerAccountId: string,
  accountIds: readonly string[],
  deps: PresenceServiceDeps = {},
): Promise<Set<string>> {
  const db = deps.db ?? getDb();
  const others = accountIds.filter((id) => id !== viewerAccountId);
  if (others.length === 0) return new Set();

  const publishers = await showOnlineStatusOf(db, [viewerAccountId]);
  if (!publishers.has(viewerAccountId)) return new Set(); // rule 1: hides, therefore blind

  const [shared, blocked, publishing] = await Promise.all([
    listSharedAccountsAmong(viewerAccountId, others, db),
    blockedEitherWay(db, viewerAccountId, others),
    showOnlineStatusOf(db, others),
  ]);
  return new Set(others.filter((id) => shared.has(id) && !blocked.has(id) && publishing.has(id)));
}

/** Whether this account publishes its own presence, which is also what decides if it receives any. */
export async function publishesPresence(accountId: string, deps: PresenceServiceDeps = {}): Promise<boolean> {
  const db = deps.db ?? getDb();
  return (await showOnlineStatusOf(db, [accountId])).has(accountId);
}

/**
 * The state of a watch set for one viewer: the online dot from the heartbeat
 * store, the last seen from Postgres, and the hidden answer for everything
 * this viewer may not see.
 */
export async function readPresence(
  viewerAccountId: string,
  accountIds: readonly string[],
  deps: PresenceServiceDeps = {},
): Promise<PresenceResponse> {
  const db = deps.db ?? getDb();
  const store = deps.store ?? getPresenceStore();
  const now = deps.now?.() ?? new Date();

  const publishing = await publishesPresence(viewerAccountId, deps);
  if (!publishing) return { presence: accountIds.map(hiddenPresence), publishing: false };

  const visible = await visibleTo(viewerAccountId, accountIds, deps);
  const subjects = [...visible];
  const [online, seen] = await Promise.all([store.onlineOf(subjects, now), lastSeenOf(db, subjects)]);

  return {
    presence: accountIds.map((accountId) => {
      if (!visible.has(accountId)) return hiddenPresence(accountId);
      const isOnline = online.has(accountId);
      const at = seen.get(accountId);
      return {
        accountId,
        online: isOnline,
        // An account that is online now is not also "last seen" — the dot is
        // the newer fact, and publishing both invites reading one as the other.
        lastSeenAt: isOnline || !at ? null : coarse(at),
      };
    }),
    publishing: true,
  };
}

/**
 * This instance is here. Moves the heartbeat deadline, and writes last seen at
 * most once per `PRESENCE_LAST_SEEN_RESOLUTION_MS` per account — a beat every
 * thirty seconds does not need a row write every thirty seconds.
 */
export async function beat(
  accountId: string,
  instanceId: string,
  deps: PresenceServiceDeps & { lastWrite?: Map<string, number> } = {},
): Promise<void> {
  const store = deps.store ?? getPresenceStore();
  const now = deps.now?.() ?? new Date();
  await store.beat(accountId, instanceId, now);

  const written = deps.lastWrite?.get(accountId) ?? 0;
  if (now.getTime() - written < PRESENCE_LAST_SEEN_RESOLUTION_MS) return;
  deps.lastWrite?.set(accountId, now.getTime());
  await touchLastSeen(deps.db ?? getDb(), accountId, now);
}

/** A clean goodbye: forget the instance now, and record when the account was here. */
export async function farewell(
  accountId: string,
  instanceId: string,
  deps: PresenceServiceDeps = {},
): Promise<void> {
  const store = deps.store ?? getPresenceStore();
  const now = deps.now?.() ?? new Date();
  await store.drop(accountId, instanceId);
  await touchLastSeen(deps.db ?? getDb(), accountId, now);
}
