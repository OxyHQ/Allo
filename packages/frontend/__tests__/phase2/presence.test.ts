/**
 * Presence, as a local placeholder.
 *
 * The interesting part is the wording: "we have not heard from this account" and
 * "they were here three hours ago" are different facts, and a placeholder that
 * invents a time for the first is the failure this file guards against.
 */
import {
  lastSeenLabel,
  presenceLabel,
  PRESENCE_UNKNOWN,
  usePresenceStore,
  type PresenceEntry,
} from '@/lib/phase2/presence';
import en from '@/locales/en.json';

const ANA = '6700000000000000000000a2';
const TEODOR = '6700000000000000000000a3';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const store = () => usePresenceStore.getState();

/**
 * The REAL English from the shipped bundle, interpolated.
 *
 * Reading `locales/en.json` rather than inlining the copy means a key this
 * module asks for that the bundle does not carry fails HERE — loudly — instead
 * of reaching a screen as a raw dotted key.
 */
const t = (key: string, options: Record<string, unknown> = {}): string => {
  const template = (en as Record<string, string>)[key];
  if (template === undefined) throw new Error(`missing i18n key: ${key}`);
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name] ?? ''));
};

const NOW = new Date('2026-09-18T20:00:00').getTime();
const label = (entry: PresenceEntry) => lastSeenLabel(entry, { now: NOW, locale: 'en-US', t });

beforeEach(() => {
  usePresenceStore.setState({ byAccountId: {} });
});

describe('presenceLabel', () => {
  it('names all four states', () => {
    expect(presenceLabel('online', t)).toBe('online');
    expect(presenceLabel('idle', t)).toBe('away');
    expect(presenceLabel('busy', t)).toBe('busy');
    expect(presenceLabel('offline', t)).toBe('offline');
  });
});

describe('lastSeenLabel', () => {
  it('lets a live state speak for itself and ignores any stale last-seen', () => {
    expect(label({ status: 'online', lastSeenAt: NOW - 5 * HOUR })).toBe('online');
    expect(label({ status: 'busy' })).toBe('busy');
  });

  it('says it does not know rather than inventing a time', () => {
    // The whole point of the placeholder: an unknown account must not be
    // reported as "last seen just now" because zero is a convenient default.
    expect(label({ status: 'offline' })).toBe('last seen a while ago');
    expect(label(PRESENCE_UNKNOWN)).toBe('last seen a while ago');
  });

  it('walks the units up as the gap grows', () => {
    expect(label({ status: 'offline', lastSeenAt: NOW - 20_000 })).toBe('last seen just now');
    expect(label({ status: 'offline', lastSeenAt: NOW - 12 * MINUTE })).toBe('last seen 12 min ago');
    expect(label({ status: 'offline', lastSeenAt: NOW - 3 * HOUR })).toContain('last seen today at');
    expect(label({ status: 'offline', lastSeenAt: NOW - 30 * HOUR })).toContain(
      'last seen yesterday at',
    );
    expect(label({ status: 'offline', lastSeenAt: NOW - 8 * 24 * HOUR })).toContain('last seen ');
  });

  it('crosses midnight by the calendar, not by twenty-four hours', () => {
    // 01:00 today and 23:00 yesterday are two hours apart and belong to
    // different days; an elapsed-time rule would call the second one "today".
    const justAfterMidnight = new Date('2026-09-18T01:00:00').getTime();
    const lateYesterday = new Date('2026-09-17T23:00:00').getTime();

    expect(
      lastSeenLabel({ status: 'offline', lastSeenAt: lateYesterday }, {
        now: justAfterMidnight,
        locale: 'en-US',
        t,
      }),
    ).toContain('yesterday');
  });

  it('never counts backwards for a clock that has slipped', () => {
    expect(label({ status: 'offline', lastSeenAt: NOW + 5 * MINUTE })).toBe('last seen just now');
  });
});

describe('the store', () => {
  it('sets one account and a batch, and the batch wins for the ids it names', () => {
    store().setPresence(ANA, { status: 'online' });
    store().setMany({ [ANA]: { status: 'busy' }, [TEODOR]: { status: 'idle' } });

    expect(store().byAccountId[ANA].status).toBe('busy');
    expect(store().byAccountId[TEODOR].status).toBe('idle');
  });

  it('leaves accounts a batch did not mention alone', () => {
    store().setPresence(ANA, { status: 'online' });
    store().setMany({ [TEODOR]: { status: 'idle' } });

    expect(store().byAccountId[ANA].status).toBe('online');
  });

  it('forgets everything on clear', () => {
    store().setPresence(ANA, { status: 'online' });
    store().clear();

    expect(store().byAccountId).toEqual({});
  });
});
