import type { User } from '@oxyhq/core';

import {
  ChatPeopleDirectory,
  chatPersonFrom,
  chatPersonOriginOf,
  conversationTitleFrom,
  isOwnRoomName,
  oxyPersonProfileOf,
  peopleInConversationTitles,
  viewerServerNameOf,
  type ChatPeopleGateway,
  type ChatPeopleLookup,
  type ChatPerson,
  type ChatPersonRequest,
} from '@/lib/chat/people';
import { ghostNamespacesFor } from '@/lib/chat/roomOrigin';

/**
 * WHO SOMEBODY IN A CONVERSATION IS.
 *
 * Two properties are load-bearing and everything below is one of them:
 *
 *  1. **Nobody who is not an Oxy account is ever looked up as one.** A bridge's
 *     puppet and a user on another homeserver are refused, because a coerced
 *     lookup succeeds against a stranger.
 *  2. **A Matrix user id never comes out as a name.** Not while a lookup is in
 *     flight, not when it fails, and not for somebody Oxy has never heard of.
 */

const ALBA = '507f1f77bcf86cd799439011';
const BRUNO = '507f1f77bcf86cd799439012';
const ALBA_MXID = `@${ALBA}:allo.you`;
const BRUNO_MXID = `@${BRUNO}:allo.you`;
const UNKNOWN = 'Unknown person';

function user(overrides: Partial<User> = {}): User {
  return {
    id: ALBA,
    publicKey: 'key',
    username: 'alba',
    name: { displayName: 'Alba Ruiz' },
    ...overrides,
  } as User;
}

function gateway(users: readonly User[] = [], calls: string[][] = []): ChatPeopleGateway {
  return {
    getUsersByIds: async (ids) => {
      calls.push(ids);
      return users.filter((entry) => ids.includes(entry.id));
    },
    getFileDownloadUrl: (fileId, variant) => `https://cloud.oxy.so/${fileId}?variant=${variant}`,
  };
}

/** A lookup over a fixed set, in the shape `useChatPeople` answers. */
function lookup(people: readonly ChatPerson[]): ChatPeopleLookup {
  const byUserId = new Map(people.map((person) => [person.userId, person]));
  return (userId) => byUserId.get(userId);
}

function person(overrides: Partial<ChatPerson> = {}): ChatPerson {
  return {
    userId: ALBA_MXID,
    origin: { kind: 'oxy', oxyUserId: ALBA },
    state: 'resolved',
    displayName: 'Alba Ruiz',
    handle: 'alba',
    avatarUrl: undefined,
    verified: false,
    ...overrides,
  };
}

describe('chatPersonOriginOf', () => {
  it('recognises an Oxy account on the viewer’s own homeserver', () => {
    expect(chatPersonOriginOf(ALBA_MXID, 'allo.you', [])).toEqual({
      kind: 'oxy',
      oxyUserId: ALBA,
    });
  });

  it("recognises a bridge's puppet from the namespaces the server published", () => {
    const namespaces = ghostNamespacesFor(['whatsapp']);
    expect(chatPersonOriginOf(`@whatsapp_${ALBA}:allo.you`, 'allo.you', namespaces)).toEqual({
      kind: 'bridged',
      networkId: 'whatsapp',
    });
  });

  it('asks the bridge rule first, before the localpart is examined at all', () => {
    // The ordering is the safeguard and not an optimisation, and this is the case
    // it exists for: a namespace whose prefix a valid Oxy id happens to start
    // with. `<id>_` is mautrix's DEFAULT `username_template` and `roomOrigin.ts`
    // says so explicitly — the day a deployment publishes its real namespaces,
    // the prefix is whatever the operator configured. Looking at the localpart
    // first would then answer with somebody's Oxy account for a WhatsApp contact:
    // their name, their face, over a stranger's messages.
    const namespaces = [{ networkId: 'legacy', localpartPrefix: ALBA.slice(0, 4) }];
    expect(chatPersonOriginOf(ALBA_MXID, 'allo.you', namespaces)).toEqual({
      kind: 'bridged',
      networkId: 'legacy',
    });
  });

  it('calls somebody on another homeserver foreign', () => {
    expect(chatPersonOriginOf(`@${ALBA}:matrix.org`, 'allo.you', [])).toEqual({
      kind: 'foreign',
    });
  });

  it('calls a localpart that is not an Oxy id foreign rather than guessing', () => {
    expect(chatPersonOriginOf('@alba:allo.you', 'allo.you', [])).toEqual({ kind: 'foreign' });
  });

  it('claims nothing about anybody when nobody is signed in', () => {
    expect(chatPersonOriginOf(ALBA_MXID, undefined, [])).toEqual({ kind: 'foreign' });
  });
});

describe('viewerServerNameOf', () => {
  it('reads the homeserver out of the viewer’s own id', () => {
    expect(viewerServerNameOf(ALBA_MXID)).toBe('allo.you');
  });

  it('answers undefined rather than throwing, so a screen still renders', () => {
    expect(viewerServerNameOf(undefined)).toBeUndefined();
    expect(viewerServerNameOf('not-a-user-id')).toBeUndefined();
  });
});

describe('oxyPersonProfileOf', () => {
  it('prefers the display name the API resolved', () => {
    expect(oxyPersonProfileOf(user(), gateway())).toMatchObject({
      displayName: 'Alba Ruiz',
      handle: 'alba',
      verified: false,
    });
  });

  it('falls back to the handle when there is no display name', () => {
    const profile = oxyPersonProfileOf(user({ name: undefined }), gateway());
    expect(profile.displayName).toBe('alba');
  });

  it('turns an avatar file id into a URL', () => {
    const profile = oxyPersonProfileOf(user({ avatar: 'file-1' }), gateway());
    expect(profile.avatarUrl).toBe('https://cloud.oxy.so/file-1?variant=thumb');
  });

  it('passes an absolute avatar URL through', () => {
    const profile = oxyPersonProfileOf(user({ avatar: 'https://cdn/a.png' }), gateway());
    expect(profile.avatarUrl).toBe('https://cdn/a.png');
  });

  it('drops an avatar with a scheme Oxy Cloud does not serve', () => {
    // `mxc://` is the one that turns up. Handed to the file endpoint it is a 404
    // the view draws as a broken image.
    expect(oxyPersonProfileOf(user({ avatar: 'mxc://allo.you/abc' }), gateway()).avatarUrl)
      .toBeUndefined();
  });
});

describe('chatPersonFrom', () => {
  const oxy = { kind: 'oxy', oxyUserId: ALBA } as const;

  it('draws an Oxy account as their name, handle and face', () => {
    const resolved = chatPersonFrom(
      { userId: ALBA_MXID },
      oxy,
      { displayName: 'Alba Ruiz', handle: 'alba', avatarUrl: 'https://cdn/a', verified: true },
      UNKNOWN,
    );
    expect(resolved).toMatchObject({
      state: 'resolved',
      displayName: 'Alba Ruiz',
      handle: 'alba',
      avatarUrl: 'https://cdn/a',
      verified: true,
    });
  });

  it('has no name at all while the lookup is in flight', () => {
    // Not the honest word either: drawing "Unknown person" and replacing it with
    // a name a moment later says something false in between.
    const pending = chatPersonFrom({ userId: ALBA_MXID }, oxy, undefined, UNKNOWN);
    expect(pending).toMatchObject({ state: 'pending', displayName: '' });
  });

  it('says something human when the lookup finished and found nobody', () => {
    const missing = chatPersonFrom({ userId: ALBA_MXID }, oxy, null, UNKNOWN);
    expect(missing).toMatchObject({ state: 'unresolved', displayName: UNKNOWN });
  });

  it('never draws the Matrix user id, whatever happened', () => {
    for (const profile of [undefined, null] as const) {
      const drawn = chatPersonFrom({ userId: ALBA_MXID }, oxy, profile, UNKNOWN);
      expect(drawn.displayName).not.toContain('@');
      expect(drawn.displayName).not.toContain('allo.you');
    }
  });

  it("draws a bridged contact from what Matrix says, and never looks them up", () => {
    const bridged = chatPersonFrom(
      { userId: '@whatsapp_34600111222:allo.you', matrixDisplayName: 'Alba (WhatsApp)' },
      { kind: 'bridged', networkId: 'whatsapp' },
      // A profile is passed in to prove it is ignored: a WhatsApp contact is not
      // an Oxy account, so even an answer about one must not be drawn as them.
      { displayName: 'Somebody Else', handle: 'else', avatarUrl: undefined, verified: true },
      UNKNOWN,
    );
    expect(bridged).toMatchObject({
      state: 'resolved',
      displayName: 'Alba (WhatsApp)',
      handle: undefined,
      verified: false,
    });
  });

  it('falls back to the honest word for a bridged contact the bridge did not name', () => {
    const bridged = chatPersonFrom(
      { userId: '@whatsapp_34600111222:allo.you' },
      { kind: 'bridged', networkId: 'whatsapp' },
      null,
      UNKNOWN,
    );
    expect(bridged).toMatchObject({ state: 'unresolved', displayName: UNKNOWN });
  });

  it('refuses a Matrix display name that is itself a user id', () => {
    // `matrix-js-sdk` answers `RoomMember.name` with the MXID when somebody has
    // no display name, and appends it to disambiguate a duplicate. A name
    // arriving from Matrix is therefore not automatically a name.
    const foreign = chatPersonFrom(
      { userId: '@alba:matrix.org', matrixDisplayName: '@alba:matrix.org' },
      { kind: 'foreign' },
      null,
      UNKNOWN,
    );
    expect(foreign.displayName).toBe(UNKNOWN);
  });

  it('treats a blank Matrix display name as no name', () => {
    const foreign = chatPersonFrom(
      { userId: '@alba:matrix.org', matrixDisplayName: '   ' },
      { kind: 'foreign' },
      null,
      UNKNOWN,
    );
    expect(foreign.displayName).toBe(UNKNOWN);
  });
});

describe('conversationTitleFrom', () => {
  it('names a direct conversation after the person it is with', () => {
    expect(conversationTitleFrom(ALBA_MXID, 'allo.you', lookup([person()]))).toBe('Alba Ruiz');
  });

  it('names every person in a title an SDK composed from the members', () => {
    const people = lookup([
      person(),
      person({ userId: BRUNO_MXID, displayName: 'Bruno Vidal', handle: 'bruno' }),
    ]);
    expect(
      conversationTitleFrom(`${ALBA_MXID} and ${BRUNO_MXID}`, 'allo.you', people),
    ).toBe('Alba Ruiz and Bruno Vidal');
  });

  it("leaves a name somebody typed exactly as they typed it", () => {
    const people = lookup([person()]);
    expect(conversationTitleFrom('Familia', 'allo.you', people)).toBe('Familia');
    expect(conversationTitleFrom('budget@work: 2026', 'allo.you', people)).toBe(
      'budget@work: 2026',
    );
  });

  it('leaves an id from another homeserver alone', () => {
    // At that point the string is far likelier to be something a person typed
    // into a group's name than a member of it, and a title the user chose has to
    // survive this function byte for byte.
    expect(conversationTitleFrom('@a:matrix.org', 'allo.you', lookup([]))).toBe('@a:matrix.org');
  });

  it('has no title while somebody in it is still being looked up', () => {
    // Half a title is not a title, and the alternative is the id.
    const people = lookup([person({ state: 'pending', displayName: '' })]);
    expect(conversationTitleFrom(ALBA_MXID, 'allo.you', people)).toBe('');
  });

  it('has no title for a room whose name has not arrived', () => {
    expect(conversationTitleFrom(undefined, 'allo.you', lookup([]))).toBe('');
  });

  it('never leaves one of this homeserver’s ids on screen', () => {
    // Nobody resolved at all: the title comes back empty rather than as the id
    // that could not be named.
    expect(conversationTitleFrom(ALBA_MXID, 'allo.you', lookup([]))).toBe('');
  });
});

describe('isOwnRoomName', () => {
  it('recognises a name the room was given', () => {
    expect(isOwnRoomName('Familia', 'allo.you')).toBe(true);
  });

  it('refuses a title computed from the people in the room', () => {
    // Written into `m.room.name` it would be a list of Matrix ids, saved in the
    // clear for everybody in the conversation.
    expect(isOwnRoomName(ALBA_MXID, 'allo.you')).toBe(false);
    expect(isOwnRoomName(`${ALBA_MXID} and ${BRUNO_MXID}`, 'allo.you')).toBe(false);
  });

  it('has no name to offer for a room that has none', () => {
    expect(isOwnRoomName(undefined, 'allo.you')).toBe(false);
    expect(isOwnRoomName('', 'allo.you')).toBe(false);
  });
});

describe('peopleInConversationTitles', () => {
  it('asks about each person once across the whole list', () => {
    const requests = peopleInConversationTitles([
      ALBA_MXID,
      `${ALBA_MXID} and ${BRUNO_MXID}`,
      'Familia',
      undefined,
    ]);
    expect(requests.map((request: ChatPersonRequest) => request.userId)).toEqual([
      ALBA_MXID,
      BRUNO_MXID,
    ]);
  });
});

describe('ChatPeopleDirectory', () => {
  /** Flushes on demand, so the batching is asserted rather than slept through. */
  function manual() {
    const pending: (() => void)[] = [];
    return {
      schedule: (flush: () => void) => pending.push(flush),
      run: () => {
        const scheduled = [...pending];
        pending.length = 0;
        for (const flush of scheduled) flush();
      },
    };
  }

  it('turns thirty people into one request', () => {
    // The whole reason this class exists. React Query caches per person, which
    // means a fetch per person, and thirty of those is the M+1 `getUsersByIds`
    // is there to prevent.
    const calls: string[][] = [];
    const ids = Array.from({ length: 30 }, (_unused, index) =>
      `507f1f77bcf86cd7994390${String(index).padStart(2, '0')}`,
    );
    const clock = manual();
    const directory = new ChatPeopleDirectory(gateway([], calls), clock.schedule);

    const loading = Promise.all(ids.map((id) => directory.load(id)));
    clock.run();

    return loading.then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(30);
    });
  });

  it('answers each waiter with their own person', async () => {
    const clock = manual();
    const directory = new ChatPeopleDirectory(
      gateway([user(), user({ id: BRUNO, username: 'bruno', name: { displayName: 'Bruno' } })]),
      clock.schedule,
    );

    const both = Promise.all([directory.load(ALBA), directory.load(BRUNO)]);
    clock.run();

    expect((await both).map((profile) => profile?.displayName)).toEqual(['Alba Ruiz', 'Bruno']);
  });

  it('answers null for an id that names nobody', async () => {
    // The server returns only what it matched, so an absent id is an answer and
    // not a failure — and `null` is what makes it `unresolved` rather than
    // `pending` for ever.
    const clock = manual();
    const directory = new ChatPeopleDirectory(gateway([]), clock.schedule);
    const loading = directory.load(ALBA);
    clock.run();
    expect(await loading).toBeNull();
  });

  it('asks once for a person asked about twice in the same tick', () => {
    const calls: string[][] = [];
    const clock = manual();
    const directory = new ChatPeopleDirectory(gateway([user()], calls), clock.schedule);

    const both = Promise.all([directory.load(ALBA), directory.load(ALBA)]);
    clock.run();

    return both.then((profiles) => {
      expect(calls).toEqual([[ALBA]]);
      expect(profiles[0]).toEqual(profiles[1]);
    });
  });

  it('rejects the batch rather than caching a blip as thirty missing people', async () => {
    const clock = manual();
    const directory = new ChatPeopleDirectory(
      {
        getUsersByIds: async () => {
          throw new Error('offline');
        },
        getFileDownloadUrl: (fileId) => fileId,
      },
      clock.schedule,
    );

    const loading = directory.load(ALBA);
    clock.run();
    await expect(loading).rejects.toThrow('offline');
  });

  it('does not drop somebody asked about while a request is in flight', async () => {
    const calls: string[][] = [];
    const clock = manual();
    const directory = new ChatPeopleDirectory(gateway([user()], calls), clock.schedule);

    const first = directory.load(ALBA);
    clock.run();
    const second = directory.load(BRUNO);
    clock.run();

    await Promise.all([first, second]);
    expect(calls).toEqual([[ALBA], [BRUNO]]);
  });
});
