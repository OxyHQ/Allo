import type { Conversation } from '@/app/(chat)/index';
import {
  ConversationNotCreatedError,
  createAlloApiConversation,
  toCreatedConversation,
  type AlloApiConversationDependencies,
} from '@/lib/chat/alloApiConversations';
import { NoParticipantsError, type PlannedConversation } from '@/lib/chat/newConversation';

/**
 * Starting a conversation on Allo's own backend.
 *
 * The path the app has always taken, moved out of the screen so that both
 * backends are reached the same way and so that the mapping from the API's
 * answer can be read. What it must keep doing: POST what the server expects,
 * put the conversation in the store the list draws from, and answer with the id
 * to navigate to.
 */

const VIEWER = 'viewer-id';

interface Recorded {
  readonly endpoint: string;
  readonly body: unknown;
}

function dependencies(
  overrides: Partial<AlloApiConversationDependencies> = {},
): AlloApiConversationDependencies & { readonly sent: Recorded[]; readonly stored: Conversation[] } {
  const sent: Recorded[] = [];
  const stored: Conversation[] = [];
  return {
    sent,
    stored,
    post: async (endpoint, body) => {
      sent.push({ endpoint, body });
      return { data: { _id: 'conversation-1', participants: [] } };
    },
    known: [],
    viewerId: VIEWER,
    remember: (conversation) => {
      stored.push(conversation);
    },
    ...overrides,
  };
}

function plan(overrides: Partial<PlannedConversation> = {}): PlannedConversation {
  return { participantIds: ['alice'], isDirect: true, name: undefined, ...overrides };
}

describe('createAlloApiConversation', () => {
  it('asks the API for a direct conversation with one person', async () => {
    const deps = dependencies();

    await createAlloApiConversation({ participantIds: ['alice'], name: undefined }, deps);

    expect(deps.sent).toEqual([
      {
        endpoint: '/conversations',
        body: { type: 'direct', participantIds: ['alice'], name: undefined },
      },
    ]);
  });

  it('asks the API for a group when there is more than one person', async () => {
    const deps = dependencies();

    await createAlloApiConversation({ participantIds: ['alice', 'bob'], name: 'Familia' }, deps);

    expect(deps.sent[0].body).toEqual({
      type: 'group',
      participantIds: ['alice', 'bob'],
      name: 'Familia',
    });
  });

  it('answers with the id to open, and puts the conversation in the store', async () => {
    const deps = dependencies();

    const id = await createAlloApiConversation(
      { participantIds: ['alice'], name: undefined },
      deps,
    );

    expect(id).toBe('conversation-1');
    expect(deps.stored.map((conversation) => conversation.id)).toEqual(['conversation-1']);
  });

  it('reuses the direct conversation this device already has', async () => {
    // The backend deduplicates these as well, so this changes nothing about the
    // outcome — only whether a round trip happens at all.
    const existing: Conversation = {
      id: 'existing-1',
      type: 'direct',
      name: 'Alice',
      lastMessage: '',
      timestamp: '',
      unreadCount: 0,
      participants: [{ id: 'alice' }, { id: VIEWER }],
    };
    const deps = dependencies({ known: [existing] });

    const id = await createAlloApiConversation(
      { participantIds: ['alice'], name: undefined },
      deps,
    );

    expect(id).toBe('existing-1');
    expect(deps.sent).toEqual([]);
  });

  it('does not reuse a group that happens to hold the same person', async () => {
    const group: Conversation = {
      id: 'group-1',
      type: 'group',
      name: 'Familia',
      lastMessage: '',
      timestamp: '',
      unreadCount: 0,
      participants: [{ id: 'alice' }, { id: VIEWER }],
    };
    const deps = dependencies({ known: [group] });

    const id = await createAlloApiConversation(
      { participantIds: ['alice'], name: undefined },
      deps,
    );

    expect(id).toBe('conversation-1');
  });

  it('asks the server when it does not know who the viewer is', async () => {
    // Without a viewer there is no way to tell which participant is the other
    // one, so every direct conversation would look like a match for everybody.
    const existing: Conversation = {
      id: 'existing-1',
      type: 'direct',
      name: 'Alice',
      lastMessage: '',
      timestamp: '',
      unreadCount: 0,
      participants: [{ id: 'alice' }, { id: VIEWER }],
    };
    const deps = dependencies({ known: [existing], viewerId: undefined });

    const id = await createAlloApiConversation(
      { participantIds: ['alice'], name: undefined },
      deps,
    );

    expect(id).toBe('conversation-1');
  });

  it('never looks for an existing room to reuse when asked for a group', async () => {
    const deps = dependencies();

    await createAlloApiConversation({ participantIds: ['alice', 'bob'], name: undefined }, deps);

    expect(deps.sent).toHaveLength(1);
  });

  it('refuses a conversation with nobody in it, without calling the API', async () => {
    const deps = dependencies();

    await expect(
      createAlloApiConversation({ participantIds: [], name: undefined }, deps),
    ).rejects.toBeInstanceOf(NoParticipantsError);
    expect(deps.sent).toEqual([]);
  });
});

describe('toCreatedConversation', () => {
  it('reads a conversation out of the data envelope', async () => {
    expect(
      toCreatedConversation({ data: { _id: 'conversation-1', participants: [] } }, plan()).id,
    ).toBe('conversation-1');
  });

  it('reads a conversation the server sent bare', () => {
    expect(toCreatedConversation({ id: 'conversation-1' }, plan()).id).toBe('conversation-1');
  });

  it('refuses an answer with no conversation in it', () => {
    // An empty id is a row nothing can open and a route that leads nowhere.
    expect(() => toCreatedConversation({ participants: [] }, plan())).toThrow(
      ConversationNotCreatedError,
    );
    expect(() => toCreatedConversation(undefined, plan())).toThrow(ConversationNotCreatedError);
    expect(() => toCreatedConversation({ _id: '' }, plan())).toThrow(ConversationNotCreatedError);
  });

  it('maps the participants the server enriched', () => {
    const conversation = toCreatedConversation(
      {
        _id: 'conversation-1',
        type: 'group',
        name: 'Familia',
        participants: [
          {
            userId: 'alice',
            username: 'alice',
            avatar: 'https://example.test/a.png',
            name: { displayName: 'Alice Example', first: 'Alice', last: 'Example' },
          },
          { userId: 'bob' },
        ],
      },
      plan({ isDirect: false, participantIds: ['alice', 'bob'], name: 'Familia' }),
    );

    expect(conversation.participants).toEqual([
      {
        id: 'alice',
        name: { displayName: 'Alice Example', first: 'Alice', last: 'Example' },
        username: 'alice',
        avatar: 'https://example.test/a.png',
      },
      {
        id: 'bob',
        name: { displayName: 'Unknown', first: '', last: '' },
        username: undefined,
        avatar: undefined,
      },
    ]);
    expect(conversation.participantCount).toBe(2);
  });

  it('drops a participant with no id rather than making a row nothing can address', () => {
    const conversation = toCreatedConversation(
      { _id: 'conversation-1', participants: [{ username: 'ghost' }, { userId: 'alice' }] },
      plan(),
    );

    expect(conversation.participants?.map((participant) => participant.id)).toEqual(['alice']);
  });

  it('falls back to the kind that was asked for when the server does not say', () => {
    expect(toCreatedConversation({ _id: 'c' }, plan({ isDirect: false })).type).toBe('group');
    expect(toCreatedConversation({ _id: 'c' }, plan({ isDirect: true })).type).toBe('direct');
  });

  it('believes the server about what kind of conversation it made', () => {
    expect(toCreatedConversation({ _id: 'c', type: 'group' }, plan()).type).toBe('group');
  });

  it('names a conversation the server did not name', () => {
    expect(toCreatedConversation({ _id: 'c' }, plan({ isDirect: false })).name).toBe('Group Chat');
    expect(toCreatedConversation({ _id: 'c' }, plan()).name).toBe('Direct Chat');
  });

  it('dates the conversation when the server did', () => {
    expect(toCreatedConversation({ _id: 'c', createdAt: '2026-08-01T10:00:00.000Z' }, plan())
      .timestamp).toBe('2026-08-01T10:00:00.000Z');
  });

  it('dates a conversation the server dated unreadably as now', () => {
    // `new Date('yesterday').toISOString()` throws, and a conversation that
    // cannot be drawn is worse than one drawn a second out.
    const conversation = toCreatedConversation({ _id: 'c', createdAt: 'yesterday' }, plan());

    expect(Number.isNaN(new Date(conversation.timestamp).getTime())).toBe(false);
  });

  it('starts a new conversation empty and unread by nobody', () => {
    const conversation = toCreatedConversation({ _id: 'c' }, plan());

    expect(conversation.lastMessage).toBe('');
    expect(conversation.unreadCount).toBe(0);
  });
});
