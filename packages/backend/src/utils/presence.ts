/**
 * Online-presence registry and pure helpers.
 *
 * This is a single-instance, in-memory presence store: it lives in the running
 * process and is therefore per-process. With a single Fargate task this is
 * sufficient (it mirrors the `lastSeenWrites` throttle in `server.ts`). If/when
 * the backend is horizontally scaled this registry and the audience fan-out
 * MUST move to a shared store — e.g. Redis pub/sub with one channel per user, or
 * presence keys with a short TTL — so a user connected to instance A is visible
 * to watchers connected to instance B.
 *
 * The pure helpers (`parseBootstrapUserIds`, `computeAudience`,
 * `resolveHiddenUserIds`, `maskHiddenEntries`, `buildPresencePayload`) are kept
 * side-effect free so they can be unit-tested in isolation and reused by both
 * the socket layer (`server.ts`) and the REST route (`routes/presence.ts`).
 */

/** Hard cap on how many watchers a single presence change fans out to. */
export const MAX_PRESENCE_AUDIENCE = 500;

/** Hard cap on how many user ids a single bootstrap REST request may resolve. */
export const MAX_PRESENCE_BOOTSTRAP_IDS = 100;

/** Wire-shape entry describing one user's presence. */
export interface PresenceEntry {
  online: boolean;
  /** ISO-8601 timestamp of when the user was last connected, or null if never. */
  lastSeenAt: string | null;
}

/**
 * In-memory presence registry.
 *
 * Tracks, per user, the set of live connection keys (one per socket) plus the
 * epoch-ms timestamp of the most recent connect/disconnect so an offline user
 * still reports a meaningful `lastSeenAt`. A user is "online" while it has at
 * least one live connection.
 *
 * The `lastSeenAt` map is in-memory: a process restart loses it (an offline
 * user then reports `lastSeenAt: null` until their next connect). That is an
 * acceptable trade-off for a single-instance deployment; see the file header
 * for the horizontal-scale path.
 */
export class PresenceRegistry {
  /** userId -> set of live device/connection keys (socket ids). */
  private readonly connections = new Map<string, Set<string>>();
  /** userId -> epoch ms of the most recent connect/disconnect. */
  private readonly lastSeen = new Map<string, number>();

  /**
   * Record a new live connection for a user.
   * @returns `becameOnline` true only on the 0 -> >=1 transition.
   */
  addConnection(userId: string, deviceKey: string): { becameOnline: boolean } {
    let keys = this.connections.get(userId);
    const wasOffline = keys === undefined || keys.size === 0;
    if (!keys) {
      keys = new Set<string>();
      this.connections.set(userId, keys);
    }
    keys.add(deviceKey);
    this.lastSeen.set(userId, Date.now());
    return { becameOnline: wasOffline };
  }

  /**
   * Remove a live connection for a user.
   * @returns `becameOffline` true on the >=1 -> 0 transition, along with the
   * ISO `lastSeenAt` recorded at that moment (null when the user was not
   * tracked at all).
   */
  removeConnection(
    userId: string,
    deviceKey: string
  ): { becameOffline: boolean; lastSeenAt: string | null } {
    const keys = this.connections.get(userId);
    if (!keys || keys.size === 0) {
      return { becameOffline: false, lastSeenAt: this.lastSeenIso(userId) };
    }
    keys.delete(deviceKey);
    if (keys.size > 0) {
      return { becameOffline: false, lastSeenAt: this.lastSeenIso(userId) };
    }
    // Last connection gone — the user is now offline.
    this.connections.delete(userId);
    const now = Date.now();
    this.lastSeen.set(userId, now);
    return { becameOffline: true, lastSeenAt: new Date(now).toISOString() };
  }

  /** True while the user has at least one live connection. */
  isOnline(userId: string): boolean {
    const keys = this.connections.get(userId);
    return keys !== undefined && keys.size > 0;
  }

  /** Presence entry for a single user (offline + null lastSeenAt when unknown). */
  getEntry(userId: string): PresenceEntry {
    return {
      online: this.isOnline(userId),
      lastSeenAt: this.lastSeenIso(userId),
    };
  }

  /** Presence entries for many users, keyed by user id. */
  getEntries(userIds: string[]): Record<string, PresenceEntry> {
    const result: Record<string, PresenceEntry> = {};
    for (const userId of userIds) {
      result[userId] = this.getEntry(userId);
    }
    return result;
  }

  /** Number of live connections for a user (used in tests). */
  connectionCount(userId: string): number {
    return this.connections.get(userId)?.size ?? 0;
  }

  private lastSeenIso(userId: string): string | null {
    const ts = this.lastSeen.get(userId);
    return ts === undefined ? null : new Date(ts).toISOString();
  }
}

/** Process-wide singleton presence registry. */
export const presenceRegistry = new PresenceRegistry();

/** Wire payload emitted on the `presence:update` socket event. */
export interface PresencePayload {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
}

/**
 * Build the `presence:update` wire payload. Centralizes the shape so the socket
 * emit and any reused logic agree on a single contract.
 */
export function buildPresencePayload(userId: string, entry: PresenceEntry): PresencePayload {
  return { userId, online: entry.online, lastSeenAt: entry.lastSeenAt };
}

/**
 * Parse a bootstrap `userIds` query value (a comma-separated string) into a
 * trimmed, de-duplicated, capped list. Returns `[]` for any non-string input.
 */
export function parseBootstrapUserIds(raw: unknown, cap: number): string[] {
  if (typeof raw !== "string") {
    return [];
  }
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id.length > 0) {
      seen.add(id);
    }
    if (seen.size >= cap) {
      break;
    }
  }
  return Array.from(seen);
}

/** Minimal conversation projection needed to compute a presence audience. */
export interface AudienceConversation {
  participants: { userId: string }[];
}

/**
 * Compute the set of users who share a conversation with `selfId` — i.e. the
 * watchers a presence change for `selfId` should fan out to. Flattens all
 * participants across the given conversations, removes `selfId`, de-duplicates,
 * and caps the result.
 */
export function computeAudience(
  conversations: AudienceConversation[],
  selfId: string,
  cap: number
): string[] {
  const seen = new Set<string>();
  for (const conversation of conversations) {
    for (const participant of conversation.participants) {
      const otherId = participant.userId;
      if (otherId && otherId !== selfId) {
        seen.add(otherId);
      }
    }
  }
  return Array.from(seen).slice(0, cap);
}

/** Minimal UserSettings projection needed to resolve presence privacy. */
export interface PrivacySettingsDoc {
  oxyUserId: string;
  privacy?: { showOnlineStatus?: boolean };
}

/**
 * Resolve the set of user ids that have opted OUT of presence (i.e.
 * `privacy.showOnlineStatus === false`). Unset or `true` is treated as visible
 * (default), so it is NOT included in the hidden set.
 */
export function resolveHiddenUserIds(settingsDocs: PrivacySettingsDoc[]): Set<string> {
  const hidden = new Set<string>();
  for (const doc of settingsDocs) {
    if (doc.privacy?.showOnlineStatus === false) {
      hidden.add(doc.oxyUserId);
    }
  }
  return hidden;
}

/**
 * Apply presence privacy to a result map: any hidden user is forced to
 * `{ online: false, lastSeenAt: null }` regardless of live state. Returns a new
 * map; the input is not mutated.
 */
export function maskHiddenEntries(
  entries: Record<string, PresenceEntry>,
  hidden: Set<string>
): Record<string, PresenceEntry> {
  const masked: Record<string, PresenceEntry> = {};
  for (const [userId, entry] of Object.entries(entries)) {
    masked[userId] = hidden.has(userId) ? { online: false, lastSeenAt: null } : entry;
  }
  return masked;
}

/**
 * Build the bootstrap REST result for the given ids: read each user's live
 * presence from the registry, then mask any privacy-hidden user to offline.
 */
export function buildBootstrapResult(
  ids: string[],
  registry: PresenceRegistry,
  hidden: Set<string>
): Record<string, PresenceEntry> {
  return maskHiddenEntries(registry.getEntries(ids), hidden);
}
