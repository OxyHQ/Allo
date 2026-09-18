/**
 * PRESENCE, AS A LOCAL PLACEHOLDER — NOTHING HERE REACHES THE NETWORK.
 *
 * Who is online is a server fact and Allo's has none: there is no presence
 * topic on the SDK, no subscription and no publish. This module is the seam a
 * transport replaces. To do that it has to supply exactly two things: a stream
 * of `(accountId, PresenceEntry)` updates for the accounts the screens are
 * showing — pushed into `usePresenceStore.getState().setMany()` — and a way to
 * say which accounts are being watched, so the server is not asked about the
 * whole address book. Everything else here (the store shape, `usePresence`,
 * `lastSeenLabel`) is the app's side of that contract and survives the swap;
 * `DEMO_PRESENCE` is the only part that must be deleted, and it is the only
 * thing in this file that invents a fact. Nothing in this module opens a
 * socket, makes a request or persists anything: the state lives in memory for
 * as long as the tab does.
 */
import { create } from 'zustand';
import type { PresenceStatus } from '@oxy.so/bloom/chat-indicators';
import { SEED_DEMO_DATA } from './demo';

export type { PresenceStatus };

/** Wording is the caller's; this file only decides which sentence to ask for. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface PresenceEntry {
  readonly status: PresenceStatus;
  /**
   * Epoch milliseconds of the last moment the account was known to be online.
   * Absent when nothing is known — which is not the same as "a long time ago",
   * and `lastSeenLabel` keeps them apart.
   */
  readonly lastSeenAt?: number;
}

/**
 * What is known about an account nobody has told us about. A module constant,
 * not a fresh object: `usePresence` hands it straight to a component, and a new
 * object per render is a new snapshot per render.
 */
export const PRESENCE_UNKNOWN: PresenceEntry = Object.freeze({ status: 'offline' });

export interface PresenceState {
  readonly byAccountId: Readonly<Record<string, PresenceEntry>>;
  /** One account changed. */
  setPresence: (accountId: string, entry: PresenceEntry) => void;
  /** A batch — what a transport's update frame would carry. */
  setMany: (entries: Readonly<Record<string, PresenceEntry>>) => void;
  /** Forgets everything. A sign-out, or a transport taking over. */
  clear: () => void;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * SAMPLE DATA, and the only dishonest line in this file.
 *
 * The ids are the local harness's fake accounts (`harness/oxy-services.tsx`),
 * which exist nowhere else, so this cannot claim anything about a real person.
 * It is here so the screens show the four states side by side while the
 * transport does not exist. A transport landing deletes this constant and the
 * store starts empty.
 */
export const DEMO_PRESENCE: Readonly<Record<string, PresenceEntry>> = Object.freeze({
  '6700000000000000000000a2': { status: 'online' },
  '6700000000000000000000a3': { status: 'idle', lastSeenAt: Date.now() - 12 * MINUTE },
  '6700000000000000000000a4': { status: 'busy' },
  '6700000000000000000000a5': { status: 'offline', lastSeenAt: Date.now() - 3 * HOUR },
  '6700000000000000000000a6': { status: 'offline', lastSeenAt: Date.now() - 30 * HOUR },
  '6700000000000000000000a7': { status: 'offline' },
});

export const usePresenceStore = create<PresenceState>((set) => ({
  byAccountId: SEED_DEMO_DATA ? { ...DEMO_PRESENCE } : {},
  setPresence: (accountId, entry) =>
    set((state) => ({ byAccountId: { ...state.byAccountId, [accountId]: entry } })),
  setMany: (entries) => set((state) => ({ byAccountId: { ...state.byAccountId, ...entries } })),
  clear: () => set({ byAccountId: {} }),
}));

/**
 * What is known about one account, for a row or a header to draw.
 *
 * Always an entry, never `undefined`: a caller drawing a dot has to draw
 * something, and "we have not heard" is `offline` with no last-seen — which
 * `lastSeenLabel` says in words rather than inventing a time.
 */
export function usePresence(accountId: string | undefined): PresenceEntry {
  return usePresenceStore((state) =>
    accountId ? (state.byAccountId[accountId] ?? PRESENCE_UNKNOWN) : PRESENCE_UNKNOWN,
  );
}

/** The four states as words, for a subtitle or an accessible name. */
export function presenceLabel(status: PresenceStatus, t: Translate): string {
  switch (status) {
    case 'online':
      return t('presence.online');
    case 'idle':
      return t('presence.idle');
    case 'busy':
      return t('presence.busy');
    default:
      return t('presence.offline');
  }
}

/**
 * One line for a header or a contact row: the live states say themselves, and
 * an offline account says when it was last seen — or says that it does not
 * know, which is the case a placeholder must not paper over.
 *
 * Pure, and takes `now`, so a test can hold the clock still.
 */
export function lastSeenLabel(
  entry: PresenceEntry,
  options: { now: number; locale: string; t: Translate },
): string {
  const { now, locale, t } = options;
  if (entry.status !== 'offline') return presenceLabel(entry.status, t);
  if (entry.lastSeenAt === undefined) return t('presence.lastSeen.unknown');

  const elapsed = Math.max(0, now - entry.lastSeenAt);
  if (elapsed < MINUTE) return t('presence.lastSeen.justNow');
  if (elapsed < HOUR) {
    return t('presence.lastSeen.minutes', { count: Math.floor(elapsed / MINUTE) });
  }

  const seen = new Date(entry.lastSeenAt);
  const time = seen.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (isSameDay(seen, new Date(now))) return t('presence.lastSeen.today', { time });
  if (isSameDay(seen, new Date(now - 24 * HOUR))) {
    return t('presence.lastSeen.yesterday', { time });
  }
  return t('presence.lastSeen.date', {
    date: seen.toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
