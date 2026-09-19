/**
 * Grouping status updates by author, and the words around them. Pure.
 */
import type { StatusView } from '@allo/react';

import { firstUnseenIndex, ringState, statusAgeLabel, statusAuthors, statusRemainingLabel } from '@/lib/statuses';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${Object.values(options).join(',')}` : key;

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function status(over: Partial<StatusView> = {}): StatusView {
  return {
    id: 's1',
    authorAccountId: 'acc-ana',
    kind: 'image',
    hasMedia: true,
    createdAt: ago(60_000),
    expiresAt: new Date(NOW.getTime() + 23 * 3_600_000).toISOString(),
    mine: false,
    seen: false,
    ...over,
  };
}

describe('statusAuthors', () => {
  it('groups by author, newest first, with your own row first whatever its time', () => {
    const authors = statusAuthors([
      status({ id: 'a1', authorAccountId: 'acc-ana', createdAt: ago(60_000) }),
      status({ id: 'a2', authorAccountId: 'acc-ana', createdAt: ago(3_600_000) }),
      status({ id: 'm1', authorAccountId: 'acc-me', mine: true, seen: true, createdAt: ago(7_200_000) }),
      status({ id: 'b1', authorAccountId: 'acc-bo', createdAt: ago(120_000) }),
    ]);

    expect(authors.map((a) => a.accountId)).toEqual(['acc-me', 'acc-ana', 'acc-bo']);
    // Each author's own are newest first.
    expect(authors[1].statuses.map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(authors[1].unseen).toBe(2);
    expect(authors[0].mine).toBe(true);
  });

  it('is empty for nothing at all', () => {
    expect(statusAuthors([])).toEqual([]);
  });
});

describe('ringState', () => {
  it('is unseen while anything is, seen once everything has been, and nothing for nobody', () => {
    const [unseen] = statusAuthors([status()]);
    expect(ringState(unseen)).toBe('unseen');
    const [seen] = statusAuthors([status({ seen: true })]);
    expect(ringState(seen)).toBe('seen');
    expect(ringState(undefined)).toBe('none');
  });
});

describe('firstUnseenIndex', () => {
  it('opens the OLDEST one not yet seen', () => {
    const [author] = statusAuthors([
      status({ id: 'new', createdAt: ago(60_000), seen: false }),
      status({ id: 'mid', createdAt: ago(120_000), seen: false }),
      status({ id: 'old', createdAt: ago(180_000), seen: true }),
    ]);
    // Newest first: ["new", "mid", "old"] → the oldest unseen is "mid".
    expect(author.statuses[firstUnseenIndex(author)].id).toBe('mid');
  });

  it('opens the newest when everything has been seen', () => {
    const [author] = statusAuthors([
      status({ id: 'new', createdAt: ago(60_000), seen: true }),
      status({ id: 'old', createdAt: ago(180_000), seen: true }),
    ]);
    expect(author.statuses[firstUnseenIndex(author)].id).toBe('new');
  });
});

describe('the words', () => {
  it('scales the age', () => {
    expect(statusAgeLabel(ago(30_000), NOW, t)).toBe('stories.age.justNow');
    expect(statusAgeLabel(ago(20 * 60_000), NOW, t)).toBe('stories.age.minutes:20');
    expect(statusAgeLabel(ago(5 * 3_600_000), NOW, t)).toBe('stories.age.hours:5');
  });

  it('counts down what is left of one of yours, and says so once it is gone', () => {
    const inMinutes = new Date(NOW.getTime() + 20 * 60_000).toISOString();
    expect(statusRemainingLabel(inMinutes, NOW, t)).toBe('stories.remaining.minutes:20');
    const inHours = new Date(NOW.getTime() + 5 * 3_600_000).toISOString();
    expect(statusRemainingLabel(inHours, NOW, t)).toBe('stories.remaining.hours:5');
    expect(statusRemainingLabel(ago(1000), NOW, t)).toBe('stories.remaining.gone');
    expect(statusRemainingLabel('not a date', NOW, t)).toBe('stories.remaining.gone');
  });
});
