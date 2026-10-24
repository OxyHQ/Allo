/**
 * The words for somebody's presence. Pure, so no client is needed — and the
 * cases that matter are the ones where the right answer is to say NOTHING.
 */
import type { PresenceView } from '@allo/react';

import { presenceDot, presenceLine } from '@/lib/presence';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${Object.values(options).join(',')}` : key;
const line = (presence: PresenceView) => presenceLine(presence, { t, locale: 'en-US', now: NOW });

const view = (over: Partial<PresenceView> = {}): PresenceView => ({
  online: false,
  lastSeenAt: null,
  known: true,
  ...over,
});
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('presenceDot', () => {
  it('is drawn only for somebody who is there', () => {
    expect(presenceDot(view({ online: true }))).toBe('online');
    expect(presenceDot(view())).toBeUndefined();
  });

  it('is absent while nothing has been answered, rather than a grey dot that reads as away', () => {
    expect(presenceDot(view({ known: false }))).toBeUndefined();
    expect(presenceDot(view({ known: false, online: true }))).toBeUndefined();
  });
});

describe('presenceLine', () => {
  it('says online, and says nothing at all about an unanswered account', () => {
    expect(line(view({ online: true }))).toBe('presence.online');
    expect(line(view({ known: false }))).toBeUndefined();
  });

  it('says nothing for an account with no last seen — hidden, blocked and never seen are one answer', () => {
    expect(line(view())).toBeUndefined();
  });

  it('scales the last seen with how long ago it was', () => {
    expect(line(view({ lastSeenAt: ago(30_000) }))).toBe('presence.lastSeen.justNow');
    expect(line(view({ lastSeenAt: ago(20 * 60_000) }))).toBe('presence.lastSeen.minutes:20');
    expect(line(view({ lastSeenAt: ago(5 * 3_600_000) }))).toBe('presence.lastSeen.hours:5');
    expect(line(view({ lastSeenAt: ago(30 * 3_600_000) }))).toBe('presence.lastSeen.yesterday');
    expect(line(view({ lastSeenAt: ago(5 * 24 * 3_600_000) }))).toMatch(/^presence\.lastSeen\.on:/);
  });

  it('is silent about a last seen in the future or a broken one, rather than saying "in -3 minutes"', () => {
    expect(
      line(view({ lastSeenAt: new Date(NOW.getTime() + 60_000).toISOString() })),
    ).toBeUndefined();
    expect(line(view({ lastSeenAt: 'not a date' }))).toBeUndefined();
  });

  it('never says both: an online account has no last seen to show', () => {
    expect(line(view({ online: true, lastSeenAt: ago(60 * 60_000) }))).toBe('presence.online');
  });
});

describe('presenceLine in the real copy', () => {
  // The header has the avatar, the name, and three buttons beside it on a
  // phone: "last seen 53 minutes ago" truncated to "last seen 53 minut…" on a
  // Pixel 8a. The short forms fit, and "1 hours ago" is gone with them.
  const en = require('../locales/en.json') as Record<string, string>;
  const real = (key: string, options?: Record<string, unknown>) =>
    (en[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name]));
  const say = (presence: PresenceView) =>
    presenceLine(presence, { t: real, locale: 'en-US', now: NOW });

  it('is short enough for a phone header', () => {
    expect(say(view({ lastSeenAt: ago(53 * 60_000) }))).toBe('last seen 53 min ago');
    expect(say(view({ lastSeenAt: ago(60 * 60_000) }))).toBe('last seen 1 h ago');
    expect(say(view({ lastSeenAt: ago(23 * 3_600_000) }))).toBe('last seen 23 h ago');
    for (const ms of [3 * 60_000, 59 * 60_000, 5 * 3_600_000, 23.9 * 3_600_000]) {
      expect((say(view({ lastSeenAt: ago(ms) })) ?? '').length).toBeLessThanOrEqual(20);
    }
  });

  it('keeps the short forms in every bundle', () => {
    for (const locale of ['en', 'es', 'it']) {
      const bundle = require(`../locales/${locale}.json`) as Record<string, string>;
      for (const key of ['presence.lastSeen.minutes', 'presence.lastSeen.hours']) {
        expect(bundle[key]).toContain('{{count}}');
        expect(bundle[key].replace('{{count}}', '53').length).toBeLessThanOrEqual(20);
      }
    }
  });
});
