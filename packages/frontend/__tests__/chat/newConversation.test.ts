import { NoParticipantsError, planConversation } from '@/lib/chat/newConversation';

/**
 * The rules both backends start from.
 *
 * They are shared rather than decided twice because the difference is
 * permanent: whether a conversation is direct is what makes every client draw
 * it with the other person's name and avatar instead of a generated title, and
 * one created as a group is a two-person group forever.
 */

describe('planConversation', () => {
  it('makes a conversation with one person a direct message', () => {
    expect(planConversation({ participantIds: ['alice'], name: undefined })).toEqual({
      participantIds: ['alice'],
      isDirect: true,
      name: undefined,
    });
  });

  it('makes a conversation with two people a group', () => {
    expect(planConversation({ participantIds: ['alice', 'bob'], name: 'Familia' })).toEqual({
      participantIds: ['alice', 'bob'],
      isDirect: false,
      name: 'Familia',
    });
  });

  it('drops the name of a direct message', () => {
    // A one-to-one conversation is named after the other person by every client
    // that draws it.
    expect(planConversation({ participantIds: ['alice'], name: 'Familia' }).name).toBe(undefined);
  });

  it('trims a group’s name and treats spaces as no name', () => {
    expect(planConversation({ participantIds: ['a', 'b'], name: '  Familia ' }).name).toBe(
      'Familia',
    );
    expect(planConversation({ participantIds: ['a', 'b'], name: '   ' }).name).toBe(undefined);
  });

  it('counts one person named twice as one person', () => {
    // Not defensive for its own sake: a duplicate would invite the same person
    // to a room twice, and — worse — would turn a conversation with one person
    // into a "group" whose two entries name one.
    expect(planConversation({ participantIds: ['alice', 'alice'], name: undefined })).toEqual({
      participantIds: ['alice'],
      isDirect: true,
      name: undefined,
    });
  });

  it('keeps the order people were chosen in', () => {
    expect(
      planConversation({ participantIds: ['c', 'a', 'b'], name: undefined }).participantIds,
    ).toEqual(['c', 'a', 'b']);
  });

  it('refuses a conversation with nobody in it', () => {
    // A backend might accept one — a conversation with no invitees is one the
    // user is alone in — and that is not what the button means.
    expect(() => planConversation({ participantIds: [], name: 'Familia' })).toThrow(
      NoParticipantsError,
    );
  });
});
