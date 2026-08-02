import {
  EPHEMERAL_LIFETIME_CHOICES,
  EPHEMERAL_POLICIES_EVENT_TYPE,
  MAX_EPHEMERAL_LIFETIME_MS,
  MIN_EPHEMERAL_LIFETIME_MS,
  encodeEphemeralPolicies,
  ephemeralPolicyOf,
  isUsableEphemeralLifetime,
  parseEphemeralPolicies,
  parseEphemeralPoliciesDocument,
  withEphemeralPolicy,
} from '@/lib/matrix/ephemeral/policy';
import type { AlloEphemeralPolicy } from '@/lib/matrix/types';

/**
 * The document that says which conversations disappear.
 *
 * It comes back from a homeserver, so every reading of it is a reading of
 * external input: another client, an older Allo, or a hostile server can put
 * anything in it. The rule this file pins down is which direction the doubt
 * falls in — a policy that cannot be understood is *no* policy, because the
 * other way round would put a timer on a conversation nobody asked to be
 * ephemeral.
 */

const ROOM = '!room:allo.you';
const HOUR = 3_600_000;

function document(rooms: Record<string, unknown>): unknown {
  return { rooms };
}

describe('parseEphemeralPolicies', () => {
  it('reads a conversation and its lifetime', () => {
    const policies = parseEphemeralPolicies(document({ [ROOM]: { lifetime_ms: HOUR } }));

    expect(policies.get(ROOM)).toEqual({ lifetimeMs: HOUR });
    expect(policies.size).toBe(1);
  });

  it('reads several', () => {
    const policies = parseEphemeralPolicies(
      document({ [ROOM]: { lifetime_ms: HOUR }, '!other:allo.you': { lifetime_ms: 86_400_000 } }),
    );

    expect([...policies.keys()].sort()).toEqual(['!other:allo.you', ROOM]);
  });

  it.each([
    ['nothing at all', undefined],
    ['a null', null],
    ['a string', 'ephemeral'],
    ['an array', []],
    ['an object with no rooms', {}],
    ['rooms that are not an object', { rooms: 'everything' }],
    ['rooms that are an array', { rooms: [] }],
  ])('treats %s as no ephemeral conversations', (_name, content) => {
    // The safe direction. A document this build cannot read must not become a
    // timer on somebody's conversations, and it must not throw either: it
    // arrives on the sync that draws the app.
    expect(parseEphemeralPolicies(content).size).toBe(0);
  });

  it.each([
    ['a lifetime that is a string', '3600000'],
    ['a lifetime that is not a whole number', 1.5],
    ['a negative lifetime', -HOUR],
    ['no lifetime at all', undefined],
    ['a lifetime of zero', 0],
    ['a lifetime below the floor', MIN_EPHEMERAL_LIFETIME_MS - 1],
    ['a lifetime above the ceiling', MAX_EPHEMERAL_LIFETIME_MS + 1],
    ['an infinite lifetime', Number.POSITIVE_INFINITY],
    ['a NaN lifetime', Number.NaN],
  ])('drops an entry with %s', (_name, lifetime) => {
    // Dropped rather than clamped. A conversation whose lifetime was corrected
    // to something the user did not choose is a conversation deleting messages
    // on a schedule nobody agreed to.
    expect(parseEphemeralPolicies(document({ [ROOM]: { lifetime_ms: lifetime } })).size).toBe(0);
  });

  it('drops an entry whose value is not an object', () => {
    expect(parseEphemeralPolicies(document({ [ROOM]: HOUR })).size).toBe(0);
  });

  it('keeps the entries around a broken one', () => {
    // One unusable entry must not cost the others: they are separate
    // conversations and only one of them is wrong.
    const policies = parseEphemeralPolicies(
      document({ [ROOM]: { lifetime_ms: HOUR }, '!broken:allo.you': { lifetime_ms: 'soon' } }),
    );

    expect([...policies.keys()]).toEqual([ROOM]);
  });

  it('keeps a lifetime exactly on each bound', () => {
    for (const lifetimeMs of [MIN_EPHEMERAL_LIFETIME_MS, MAX_EPHEMERAL_LIFETIME_MS]) {
      expect(
        parseEphemeralPolicies(document({ [ROOM]: { lifetime_ms: lifetimeMs } })).get(ROOM),
      ).toEqual({ lifetimeMs });
    }
  });

  it('ignores an entry with an empty room id', () => {
    expect(parseEphemeralPolicies(document({ '': { lifetime_ms: HOUR } })).size).toBe(0);
  });
});

describe('parseEphemeralPoliciesDocument', () => {
  it('reads the JSON the native binding hands over', () => {
    const json = JSON.stringify({ rooms: { [ROOM]: { lifetime_ms: HOUR } } });

    expect(parseEphemeralPoliciesDocument(json).get(ROOM)).toEqual({ lifetimeMs: HOUR });
  });

  it('treats an account with no such event as an account with none', () => {
    expect(parseEphemeralPoliciesDocument(undefined).size).toBe(0);
  });

  it('does not throw on text that is not JSON', () => {
    // It arrives on the same read as everything else. A throw here would take
    // the conversation list with it.
    expect(parseEphemeralPoliciesDocument('{not json').size).toBe(0);
  });
});

describe('encodeEphemeralPolicies', () => {
  it('round-trips through the document format', () => {
    const policies = new Map<string, AlloEphemeralPolicy>([[ROOM, { lifetimeMs: HOUR }]]);

    expect(parseEphemeralPolicies(encodeEphemeralPolicies(policies))).toEqual(policies);
  });

  it('writes the field name Matrix content uses', () => {
    // Read by every other Allo on this account, and by a future one. The name is
    // part of the format, not an implementation detail.
    expect(encodeEphemeralPolicies(new Map([[ROOM, { lifetimeMs: HOUR }]]))).toEqual({
      rooms: { [ROOM]: { lifetime_ms: HOUR } },
    });
  });

  it('writes an empty document for an account with none', () => {
    expect(encodeEphemeralPolicies(new Map())).toEqual({ rooms: {} });
  });
});

describe('withEphemeralPolicy', () => {
  const existing: ReadonlyMap<string, AlloEphemeralPolicy> = new Map([
    [ROOM, { lifetimeMs: HOUR }],
    ['!other:allo.you', { lifetimeMs: 86_400_000 }],
  ]);

  it('adds a conversation without touching the others', () => {
    const next = withEphemeralPolicy(existing, '!third:allo.you', { lifetimeMs: HOUR });

    expect(next.size).toBe(3);
    expect(next.get('!other:allo.you')).toEqual({ lifetimeMs: 86_400_000 });
  });

  it('changes one conversation and leaves the rest', () => {
    const next = withEphemeralPolicy(existing, ROOM, { lifetimeMs: 86_400_000 });

    expect(next.get(ROOM)).toEqual({ lifetimeMs: 86_400_000 });
    expect(next.get('!other:allo.you')).toEqual({ lifetimeMs: 86_400_000 });
  });

  it('removes a conversation when the policy is undefined', () => {
    const next = withEphemeralPolicy(existing, ROOM, undefined);

    expect(next.has(ROOM)).toBe(false);
    expect(next.size).toBe(1);
  });

  it('leaves the map it was given alone', () => {
    // The caller has just read it from the account data and may still be using
    // it; a mutation here would be a second, silent write.
    withEphemeralPolicy(existing, ROOM, undefined);

    expect(existing.size).toBe(2);
  });
});

describe('ephemeralPolicyOf', () => {
  it('accepts every lifetime the interface offers', () => {
    for (const lifetimeMs of EPHEMERAL_LIFETIME_CHOICES) {
      expect(ephemeralPolicyOf(lifetimeMs)).toEqual({ lifetimeMs });
    }
  });

  it('refuses a lifetime this build will not act on rather than clamping it', () => {
    expect(() => ephemeralPolicyOf(0)).toThrow(RangeError);
    expect(() => ephemeralPolicyOf(MAX_EPHEMERAL_LIFETIME_MS + 1)).toThrow(RangeError);
  });
});

describe('the format itself', () => {
  it('is namespaced to Allo', () => {
    // It is written into an account that other Matrix clients share. A generic
    // name would collide with somebody else's.
    expect(EPHEMERAL_POLICIES_EVENT_TYPE).toBe('so.oxy.allo.ephemeral_rooms');
  });

  it('offers only lifetimes it will read back', () => {
    // A choice the interface offers and the parser drops would be a switch that
    // turns itself off on the next launch.
    for (const lifetimeMs of EPHEMERAL_LIFETIME_CHOICES) {
      expect(isUsableEphemeralLifetime(lifetimeMs)).toBe(true);
    }
  });
});
