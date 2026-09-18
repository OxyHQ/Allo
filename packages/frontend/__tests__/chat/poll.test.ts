import { canSendPoll, POLL_MAX_OPTIONS, pollDraft } from '@/lib/chat/poll';

/**
 * WHAT MAY BE SENT AS A POLL.
 *
 * The SDK refuses a poll outside two-to-twelve options, so the sheet has to
 * refuse it first. These are the cases the sheet cannot show: a form that
 * enables "Send" on one rule and builds the draft on another puts a blank
 * option into a conversation.
 */

const form = (overrides: Partial<Parameters<typeof pollDraft>[0]> = {}) => ({
  question: 'When should we do the handover?',
  options: ['Thursday', 'Friday'],
  multiple: false,
  anonymous: false,
  ...overrides,
});

describe('pollDraft', () => {
  it('trims the question and the options', () => {
    expect(pollDraft(form({ question: '  Which day?  ', options: [' Thursday ', 'Friday  '] }))).toEqual({
      question: 'Which day?',
      options: ['Thursday', 'Friday'],
    });
  });

  it('drops blank options instead of rejecting them — an unused third field is normal', () => {
    expect(pollDraft(form({ options: ['Thursday', 'Friday', '', '   '] }))?.options).toEqual([
      'Thursday',
      'Friday',
    ]);
  });

  it('refuses a poll with no question', () => {
    expect(pollDraft(form({ question: '   ' }))).toBeUndefined();
  });

  it('refuses fewer than two real options, however many fields were shown', () => {
    expect(pollDraft(form({ options: ['Thursday', ''] }))).toBeUndefined();
    expect(pollDraft(form({ options: [] }))).toBeUndefined();
  });

  it("refuses more than the SDK's twelve", () => {
    const thirteen = Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_, index) => `Option ${index}`);
    expect(pollDraft(form({ options: thirteen }))).toBeUndefined();
    expect(pollDraft(form({ options: thirteen.slice(0, POLL_MAX_OPTIONS) }))).toBeDefined();
  });

  it('states multiple and anonymous only when they are on, so the defaults stay the SDK’s', () => {
    expect(pollDraft(form())).not.toHaveProperty('multiple');
    expect(pollDraft(form())).not.toHaveProperty('anonymous');
    expect(pollDraft(form({ multiple: true, anonymous: true }))).toMatchObject({
      multiple: true,
      anonymous: true,
    });
  });
});

describe('canSendPoll', () => {
  it('answers exactly what pollDraft would do, so the button never promises a refused send', () => {
    expect(canSendPoll(form())).toBe(true);
    expect(canSendPoll(form({ question: '' }))).toBe(false);
    expect(canSendPoll(form({ options: ['only one'] }))).toBe(false);
  });
});
