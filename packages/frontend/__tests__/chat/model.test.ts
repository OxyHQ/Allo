import type { ConversationView, TimelineItemView } from '@allo/core';

import type { Person } from '@/lib/allo/people';
import {
  chatSummary,
  pinnedMessages,
  conversationTitle,
  deliveryStatus,
  firstUnreadId,
  previewText,
  transcriptItems,
  unreachableCopy,
  type ChatContext,
} from '@/lib/chat/model';

/**
 * The projection from what the SDK reports to what Bloom draws. Pure, and the
 * place a wrong mapping would be invisible on screen: a `read` message drawn as
 * `sent` is one tick instead of two, and nobody files a bug about a tick.
 */

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key;

const PEOPLE: Record<string, Person> = {
  'acc-alice': { id: 'acc-alice', displayName: 'Alice', handle: 'alice', avatar: 'file-alice' },
  'acc-bob': { id: 'acc-bob', displayName: 'Bob', handle: 'bob' },
  'acc-carol': { id: 'acc-carol', displayName: 'Carol' },
};

const ctx: ChatContext = {
  me: 'acc-me',
  person: (id) => PEOPLE[id],
  t,
  locale: 'en-US',
  now: new Date('2026-09-17T12:00:00'),
};

function item(overrides: Partial<TimelineItemView> = {}): TimelineItemView {
  return {
    id: 'evt-1',
    conversationId: 'conv-1',
    seq: 3,
    senderAccountId: 'acc-alice',
    senderInstanceId: 'inst-1',
    sentAt: '2026-09-17T10:00:00',
    isOwn: false,
    sendState: 'accepted',
    content: { kind: 'text', body: 'hello', isEdited: false },
    reactions: [],
    ...overrides,
  };
}

function view(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: 'conv-1',
    kind: 'dm',
    appId: 'allo',
    title: null,
    memberAccountIds: ['acc-me', 'acc-alice'],
    myRole: 'member',
    epoch: 1,
    joined: true,
    unreachableMemberAccountIds: [],
    unreadCount: 0,
    lastActivityAt: '2026-09-17T10:00:00',
    createdAt: '2026-09-01T10:00:00',
    ...overrides,
  };
}

describe('deliveryStatus', () => {
  it('maps every send state, and a failure is never drawn as still sending', () => {
    expect(deliveryStatus('pending')).toBe('sending');
    expect(deliveryStatus('accepted')).toBe('sent');
    expect(deliveryStatus('delivered')).toBe('delivered');
    expect(deliveryStatus('read')).toBe('read');
    expect(deliveryStatus('failed')).toBe('failed');
  });
});

describe('conversationTitle', () => {
  it('names a DM after the other person', () => {
    expect(conversationTitle(view(), ctx)).toBe('Alice');
  });

  it('prefers a group title, and otherwise names the first members', () => {
    const group = view({ kind: 'group', memberAccountIds: ['acc-me', 'acc-alice', 'acc-bob'] });
    expect(conversationTitle({ ...group, title: 'Trip' }, ctx)).toBe('Trip');
    expect(conversationTitle(group, ctx)).toBe('Alice, Bob');
  });

  it('never draws an account id for somebody still being looked up', () => {
    expect(conversationTitle(view({ memberAccountIds: ['acc-me', 'acc-unknown'] }), ctx)).toBe('');
  });
});

describe('chatSummary', () => {
  it('draws a DM row with the other person, the preview and the unread count', () => {
    const summary = chatSummary(view({ unreadCount: 2, lastMessage: item() }), ctx);
    expect(summary).toMatchObject({
      id: 'conv-1',
      kind: 'direct',
      name: 'Alice',
      avatar: 'file-alice',
      unreadCount: 2,
      preview: { text: 'hello' },
      outgoingStatus: undefined,
    });
  });

  it('shows my own last message with its delivery status and a "you" sender', () => {
    const summary = chatSummary(view({ lastMessage: item({ isOwn: true, senderAccountId: 'acc-me', sendState: 'read' }) }), ctx);
    expect(summary.outgoingStatus).toBe('read');
    expect(summary.preview?.sender).toBe('chat.you');
  });

  it('shows an attachment without a caption as its kind', () => {
    const photo = item({
      content: {
        kind: 'media',
        media: { kind: 'image', filename: 'a.jpg', mime: 'image/jpeg', size: 1, ref: { conversationId: 'c', blobId: 'b' } },
      },
    });
    expect(chatSummary(view({ lastMessage: photo }), ctx).preview?.attachment).toEqual({
      kind: 'photo',
      label: 'chat.attachment.photo',
    });
  });

  it('draws group faces and the sender of the last message', () => {
    const group = view({ kind: 'group', memberAccountIds: ['acc-me', 'acc-alice', 'acc-bob'], lastMessage: item() });
    const summary = chatSummary(group, ctx);
    expect(summary.kind).toBe('group');
    expect(summary.faces?.map((face) => face.name)).toEqual(['Alice', 'Bob']);
    expect(summary.preview?.sender).toBe('Alice');
  });

  it('says who a held last message is waiting for, instead of the preview', () => {
    const held = view({
      unreachableMemberAccountIds: ['acc-alice'],
      lastMessage: item({ isOwn: true, senderAccountId: 'acc-me', sendState: 'pending', holdReason: 'no_reachable_member' }),
    });
    expect(chatSummary(held, ctx).preview).toEqual({ text: 'chat.waiting.dm {"name":"Alice"}' });
  });
});

describe('unreachableCopy', () => {
  it('says nothing when everybody can be reached', () => {
    expect(unreachableCopy(view(), ctx)).toEqual({ banner: null, hold: null, waiting: null });
  });

  it('names the person in a DM, and says "this person" while they are being looked up', () => {
    expect(unreachableCopy(view({ unreachableMemberAccountIds: ['acc-alice'] }), ctx).banner).toBe(
      'chat.unreachable.dm {"name":"Alice"}',
    );
    const unknown = view({ memberAccountIds: ['acc-me', 'acc-x'], unreachableMemberAccountIds: ['acc-x'] });
    expect(unreachableCopy(unknown, ctx)).toEqual({
      banner: 'chat.unreachable.dmUnnamed',
      hold: 'chat.hold.dmUnnamed',
      waiting: 'chat.waiting.dmUnnamed',
    });
  });

  it('counts them in a group', () => {
    const group = view({ kind: 'group', unreachableMemberAccountIds: ['acc-bob', 'acc-carol'] });
    expect(unreachableCopy(group, ctx).waiting).toBe('chat.waiting.group {"count":2}');
  });
});

describe('transcriptItems', () => {
  it('maps a text message with its time, day and direction', () => {
    const [row] = transcriptItems([item()], ctx, { isGroup: false });
    expect(row).toMatchObject({
      id: 'evt-1',
      direction: 'incoming',
      text: 'hello',
      dateKey: '2026-09-17',
      dateLabel: 'chat.day.today',
      status: undefined,
      senderName: undefined,
    });
  });

  it('draws my own messages with their status, pending and failed flags', () => {
    const [sending, failed] = transcriptItems(
      [item({ id: 'a', isOwn: true, sendState: 'pending' }), item({ id: 'b', isOwn: true, sendState: 'failed' })],
      ctx,
      { isGroup: false },
    );
    expect(sending).toMatchObject({ direction: 'outgoing', status: 'sending', pending: true, failed: false });
    expect(failed).toMatchObject({ status: 'failed', failed: true });
  });

  it('names senders only in a group', () => {
    expect(transcriptItems([item()], ctx, { isGroup: true })[0].senderName).toBe('Alice');
  });

  it('counts reactions and marks mine', () => {
    const [row] = transcriptItems(
      [item({ reactions: [{ key: '👍', accountIds: ['acc-me', 'acc-bob'] }] })],
      ctx,
      { isGroup: false },
    );
    expect(row.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
  });

  it('quotes a reply, and says so when the quoted message is not loaded', () => {
    const rows = transcriptItems(
      [item({ id: 'q' }), item({ id: 'r', replyTo: 'q' }), item({ id: 's', replyTo: 'gone' })],
      ctx,
      { isGroup: false },
    );
    expect(rows[1].replyTo).toEqual({ senderName: 'Alice', preview: 'hello' });
    expect(rows[2].replyTo).toEqual({ senderName: '', preview: 'message.replyUnavailable' });
  });

  it('marks edits, deletions, undecryptable and system lines', () => {
    const rows = transcriptItems(
      [
        item({ id: 'e', content: { kind: 'text', body: 'fixed', isEdited: true } }),
        item({ id: 'd', content: { kind: 'deleted' } }),
        item({ id: 'u', content: { kind: 'undecryptable', reason: 'no key' } }),
        item({ id: 's', content: { kind: 'system', text: 'Alice joined' } }),
      ],
      ctx,
      { isGroup: false },
    );
    expect(rows[0].editedLabel).toBe('message.edited');
    expect(rows[1]).toMatchObject({ deleted: true });
    expect(rows[2].text).toBe('message.undecryptable');
    expect(rows[3].system).toBe('Alice joined');
  });

  it('names the clock of a held message after who it waits for, and nothing else', () => {
    const rows = transcriptItems(
      [
        item({ id: 'held', isOwn: true, sendState: 'pending', holdReason: 'no_reachable_member' }),
        item({ id: 'plain', isOwn: true, sendState: 'pending' }),
      ],
      ctx,
      { isGroup: false, holdLabel: 'Waiting for Alice to join' },
    );
    expect(rows[0].labels).toEqual({ pending: 'Waiting for Alice to join' });
    expect(rows[1].labels).toBeUndefined();
  });

  it('puts the unread separator before the first unread message', () => {
    const rows = transcriptItems([item({ id: 'a' }), item({ id: 'b' })], ctx, { isGroup: false, firstUnreadId: 'b' });
    expect(rows.map((row) => row.unreadBefore)).toEqual([false, true]);
  });
});

describe('firstUnreadId', () => {
  it('counts back over incoming messages only', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'mine', isOwn: true }), item({ id: 'c' })];
    expect(firstUnreadId(items, 2)).toBe('b');
    expect(firstUnreadId(items, 0)).toBeUndefined();
    expect(firstUnreadId(items, 9)).toBeUndefined();
  });
});

describe('previewText', () => {
  it('falls back to the attachment kind when there is no caption', () => {
    const voice = item({
      content: {
        kind: 'media',
        media: { kind: 'voice', filename: 'v.m4a', mime: 'audio/m4a', size: 1, ref: { conversationId: 'c', blobId: 'b' } },
      },
    });
    expect(previewText(voice, t)).toBe('chat.attachment.voice');
  });
});

/**
 * POLLS, PLACES AND CARDS in the two places a message is reduced to one line.
 *
 * A row has room for a glyph and a line, and "Poll" says less than the question
 * does — so these three keep Bloom's glyph and spend the line on their own
 * words. A wrong mapping here is a conversation list that reads "Photo" next to
 * a poll, which nobody files a bug about either.
 */
describe('previewText and the list row, for a poll, a place and a card', () => {
  const poll = item({
    content: {
      kind: 'poll',
      poll: {
        question: 'When should we do the handover?',
        options: [{ id: 'a', label: 'Thursday', votes: 2, mine: true, accountIds: ['acc-me', 'acc-alice'] }],
        totalVotes: 2,
        multiple: false,
        anonymous: false,
        voted: true,
      },
    },
  });
  const place = item({
    content: { kind: 'location', place: { latitude: 41.38879, longitude: 2.18994, label: 'Casa del Puerto' } },
  });
  const nowhere = item({ content: { kind: 'location', place: { latitude: 0, longitude: 0 } } });
  const card = item({ content: { kind: 'contact', contact: { name: 'Marta Ferreira', phone: '+34600112233' } } });

  it('says what the message is: the question, the place, the name', () => {
    expect(previewText(poll, t)).toBe('When should we do the handover?');
    expect(previewText(place, t)).toBe('Casa del Puerto');
    expect(previewText(card, t)).toBe('Marta Ferreira');
  });

  it('names an unnamed place rather than showing an empty line', () => {
    expect(previewText(nowhere, t)).toBe('chat.attachment.location');
  });

  it("draws Bloom's own glyph for each, with the message's words beside it", () => {
    expect(chatSummary(view({ lastMessage: poll }), ctx).preview).toEqual({
      sender: undefined,
      attachment: { kind: 'poll', label: 'When should we do the handover?' },
    });
    expect(chatSummary(view({ lastMessage: place }), ctx).preview).toEqual({
      sender: undefined,
      attachment: { kind: 'location', label: 'Casa del Puerto' },
    });
    expect(chatSummary(view({ lastMessage: card }), ctx).preview).toEqual({
      sender: undefined,
      attachment: { kind: 'contact', label: 'Marta Ferreira' },
    });
  });

  it('still names the sender in a group, the way an attachment row does', () => {
    const summary = chatSummary(
      view({ kind: 'group', memberAccountIds: ['acc-me', 'acc-alice', 'acc-bob'], lastMessage: poll }),
      ctx,
    );
    expect(summary.preview).toEqual({
      sender: 'Alice',
      attachment: { kind: 'poll', label: 'When should we do the handover?' },
    });
  });

  it('leaves the bubble itself textless: the media slot draws the whole thing', () => {
    const [drawnPoll, drawnPlace, drawnCard] = transcriptItems([poll, place, card], ctx, { isGroup: false });
    expect(drawnPoll.text).toBeUndefined();
    expect(drawnPlace.text).toBeUndefined();
    expect(drawnCard.text).toBeUndefined();
  });
});

describe('pinnedMessages', () => {
  it('draws the pinned ones oldest first, with who wrote each and what it says', () => {
    const items = [
      item({ id: 'a', content: { kind: 'text', body: 'first', isEdited: false } }),
      item({ id: 'b', pinned: true, content: { kind: 'text', body: 'bring the tape', isEdited: false } }),
      item({ id: 'c', isOwn: true, senderAccountId: 'acc-me', pinned: true, content: { kind: 'text', body: 'eight o clock', isEdited: false } }),
    ];
    expect(pinnedMessages(items, ctx)).toEqual([
      { id: 'b', preview: 'bring the tape', author: 'Alice' },
      { id: 'c', preview: 'eight o clock', author: 'chat.you' },
    ]);
  });

  it('is empty when nothing is pinned, so the bar never draws', () => {
    expect(pinnedMessages([item(), item({ id: 'b' })], ctx)).toEqual([]);
  });
});
