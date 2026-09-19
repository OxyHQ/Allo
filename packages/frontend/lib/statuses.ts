/**
 * Status updates, projected for the screens.
 *
 * The state is the SDK's (`useStatuses`): a flat list of what this device can
 * decrypt, newest first. What the screens draw is one entry per AUTHOR — a
 * ring, a name, and however many updates that person has — so this file is the
 * grouping, the ring state and the words, and it is pure.
 *
 * `seen` is a fact of this device. The SDK tells the author it was seen, and
 * whether that carries a name is the viewer's own setting; nothing here
 * pretends to know what anybody else saw.
 */
import type { StoryRingState } from '@oxy.so/bloom/chat-indicators';
import type { StatusView } from '@allo/react';

/** Wording is the caller's; this file only decides which sentence to ask for. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** One person's updates, newest first, as a row or a ring. */
export interface StatusAuthor {
  readonly accountId: string;
  readonly statuses: readonly StatusView[];
  /** The newest one's time, which is what the list sorts by. */
  readonly latestAt: number;
  readonly mine: boolean;
  /** How many this device has not told the author about yet. */
  readonly unseen: number;
}

/**
 * Group by author, newest author first, with each author's own updates newest
 * first. Your own come first whatever their time: the row you tap to add one
 * is the row that shows what you already added.
 */
export function statusAuthors(statuses: readonly StatusView[]): StatusAuthor[] {
  const byAuthor = new Map<string, StatusView[]>();
  for (const status of statuses) {
    const held = byAuthor.get(status.authorAccountId);
    if (held) held.push(status);
    else byAuthor.set(status.authorAccountId, [status]);
  }

  const authors: StatusAuthor[] = [];
  for (const [accountId, own] of byAuthor) {
    const sorted = [...own].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    authors.push({
      accountId,
      statuses: sorted,
      latestAt: new Date(sorted[0].createdAt).getTime(),
      mine: sorted[0].mine,
      unseen: sorted.filter((status) => !status.seen).length,
    });
  }
  return authors.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    return b.latestAt - a.latestAt;
  });
}

/** The ring Bloom draws: unseen while anything is, seen once everything has been. */
export function ringState(author: StatusAuthor | undefined): StoryRingState {
  if (!author || author.statuses.length === 0) return 'none';
  return author.unseen > 0 ? 'unseen' : 'seen';
}

/** Which one the viewer should open first: the oldest they have not seen, else the first. */
export function firstUnseenIndex(author: StatusAuthor | undefined): number {
  if (!author || author.statuses.length === 0) return 0;
  // `statuses` is newest first, so the oldest unseen is the LAST unseen here.
  for (let index = author.statuses.length - 1; index >= 0; index -= 1) {
    if (!author.statuses[index].seen) return index;
  }
  return 0;
}

/** "just now", "20 min", "3 h" — how long ago one was posted. */
export function statusAgeLabel(createdAt: string, now: Date, t: Translate): string {
  const elapsed = now.getTime() - new Date(createdAt).getTime();
  if (Number.isNaN(elapsed) || elapsed < 2 * MINUTE) return t('stories.age.justNow');
  if (elapsed < HOUR) return t('stories.age.minutes', { count: Math.round(elapsed / MINUTE) });
  return t('stories.age.hours', { count: Math.max(1, Math.floor(elapsed / HOUR)) });
}

/**
 * How long one of yours has left.
 *
 * Shown on your own updates only, because the deadline is a promise made to
 * the people who can see it and the person who owes it is you.
 */
export function statusRemainingLabel(expiresAt: string, now: Date, t: Translate): string {
  const left = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(left) || left <= 0) return t('stories.remaining.gone');
  if (left < HOUR) return t('stories.remaining.minutes', { count: Math.max(1, Math.round(left / MINUTE)) });
  return t('stories.remaining.hours', { count: Math.floor(left / HOUR) });
}
