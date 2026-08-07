import {
  ephemeralRefusalMessage,
  REFUSAL_NAMING_NOBODY_KEY,
  REFUSAL_NAMING_PEOPLE_KEY,
  REFUSAL_OWN_DEVICE_KEY,
  UNKNOWN_PERSON_KEY,
  type Translate,
} from '@/components/matrix/ephemeralRefusal';
import { NO_CHAT_PEOPLE, type ChatPeopleLookup, type ChatPerson } from '@/lib/chat/people';
import { MatrixEphemeralUntrustedError } from '@/lib/matrix/errors';

/**
 * WHAT THE COMPOSER SAYS WHEN AN EPHEMERAL CONVERSATION REFUSES TO SEND.
 *
 * The refusal names people, and the port hands it Matrix user ids. Joined
 * straight into the sentence, the toast read "it does not recognise the identity
 * of @507f1f77bcf86cd799439011:allo.you" — which the reader cannot act on,
 * because they have no idea who that is. `EphemeralSection` has taken a name
 * mapper for exactly this reason since it was written; the composer had none.
 */

const ALBA = '@507f1f77bcf86cd799439011:allo.you';
const BRUNO = '@507f1f77bcf86cd799439012:allo.you';
const ROOM = '!room:allo.you';

/** Interpolates rather than translating, so the assertion is about the sentence. */
const t: Translate = (key, options) =>
  key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''));

function person(userId: string, displayName: string): ChatPerson {
  return {
    userId,
    origin: { kind: 'oxy', oxyUserId: userId.slice(1).split(':')[0] },
    state: displayName === '' ? 'pending' : 'resolved',
    displayName,
    handle: undefined,
    avatarUrl: undefined,
    verified: false,
  };
}

function lookup(...people: readonly ChatPerson[]): ChatPeopleLookup {
  const byUserId = new Map(people.map((entry) => [entry.userId, entry]));
  return (userId) => byUserId.get(userId);
}

function untrusted(...userIds: readonly string[]): MatrixEphemeralUntrustedError {
  return new MatrixEphemeralUntrustedError(ROOM, {
    kind: 'members-untrusted',
    userIds: [...userIds],
  });
}

describe('ephemeralRefusalMessage', () => {
  it('names the people it does not recognise', () => {
    const message = ephemeralRefusalMessage(
      untrusted(ALBA, BRUNO),
      lookup(person(ALBA, 'Alba Ruiz'), person(BRUNO, 'Bruno Vidal')),
      t,
    );

    expect(message).toContain('Alba Ruiz, Bruno Vidal');
  });

  it('never puts a Matrix user id in the sentence', () => {
    // The regression, stated as the property rather than as one wording. Every
    // combination of resolved, pending and never-asked-about, and none of them
    // may produce an id.
    const cases: readonly ChatPeopleLookup[] = [
      NO_CHAT_PEOPLE,
      lookup(person(ALBA, 'Alba Ruiz')),
      lookup(person(ALBA, ''), person(BRUNO, 'Bruno Vidal')),
      lookup(person(ALBA, 'Alba Ruiz'), person(BRUNO, 'Bruno Vidal')),
    ];

    for (const people of cases) {
      const message = ephemeralRefusalMessage(untrusted(ALBA, BRUNO), people, t) ?? '';
      expect(message).not.toContain(ALBA);
      expect(message).not.toContain(BRUNO);
      expect(message).not.toContain('allo.you');
    }
  });

  it('drops the list whole when one of the people cannot be named', () => {
    // Rather than padding it: "the identity of Bruno, Unknown person" reads as a
    // bug, and the sentence below says the same thing without pretending to
    // enumerate.
    const message = ephemeralRefusalMessage(
      untrusted(ALBA, BRUNO),
      lookup(person(BRUNO, 'Bruno Vidal')),
      t,
    );

    expect(message).toBe(REFUSAL_NAMING_NOBODY_KEY);
    expect(message).not.toContain('Bruno');
  });

  it('does not use the unknown-person label as one of the names', () => {
    const message = ephemeralRefusalMessage(untrusted(ALBA), NO_CHAT_PEOPLE, t) ?? '';
    expect(message).not.toContain(UNKNOWN_PERSON_KEY);
  });

  it('says the other refusal without naming anybody', () => {
    const message = ephemeralRefusalMessage(
      new MatrixEphemeralUntrustedError(ROOM, { kind: 'own-device-unverified' }),
      NO_CHAT_PEOPLE,
      t,
    );

    expect(message).toBe(REFUSAL_OWN_DEVICE_KEY);
  });

  it('leaves every other failure to the caller', () => {
    // Anything that is really an error keeps its own handling, which is what the
    // `?? errorMessage` at the call site is for.
    expect(ephemeralRefusalMessage(new Error('offline'), NO_CHAT_PEOPLE, t)).toBeUndefined();
    expect(ephemeralRefusalMessage(undefined, NO_CHAT_PEOPLE, t)).toBeUndefined();
  });

  it('uses the two keys the bundles carry', () => {
    // The English sentence is the i18next key here, as everywhere else in the
    // app, so a reworded sentence that is not also reworded in `locales/` shows
    // up as the sentence in English for everybody. `personTranslations.test.ts`
    // is what checks the bundles have them.
    expect(REFUSAL_NAMING_PEOPLE_KEY).toContain('{{people}}');
    expect(REFUSAL_NAMING_NOBODY_KEY).not.toContain('{{');
  });
});
