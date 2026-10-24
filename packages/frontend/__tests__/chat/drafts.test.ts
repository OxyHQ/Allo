/**
 * A typed, unsent message survives leaving the conversation and coming back.
 * It used to live only in the composer's state, so Back threw it away.
 */
import { draftKey, readDraft, useDraftStore } from '@/stores/draftStore';

jest.mock('@/lib/allo/nativeCallBridge', () => ({ nativeCallBridge: null }));
jest.mock('@/lib/allo/push', () => ({ clearPushToken: async () => undefined }));

const { signOutOfAllo } = require('@/lib/allo/signOut') as typeof import('@/lib/allo/signOut');

const set = (account: string, conversation: string, text: string) =>
  useDraftStore.getState().setDraft(account, conversation, text);

beforeEach(() => useDraftStore.getState().clearAll());

describe('the draft store', () => {
  it('gives a conversation back what was typed in it, and nothing to another', () => {
    set('acc-me', 'conv-1', 'see you at');
    expect(readDraft('acc-me', 'conv-1')).toBe('see you at');
    expect(readDraft('acc-me', 'conv-2')).toBe('');
  });

  it('is cleared by sending — the composer reports the emptied field — and by a field of spaces', () => {
    set('acc-me', 'conv-1', 'hello');
    set('acc-me', 'conv-1', '');
    expect(readDraft('acc-me', 'conv-1')).toBe('');
    expect(useDraftStore.getState().drafts).toEqual({});
    set('acc-me', 'conv-1', '   ');
    expect(useDraftStore.getState().drafts).toEqual({});
  });

  it('keeps the text exactly, spaces and line breaks included', () => {
    set('acc-me', 'conv-1', 'line one\n  line two ');
    expect(readDraft('acc-me', 'conv-1')).toBe('line one\n  line two ');
  });

  it('keeps two accounts on one device apart, and has nothing for no account', () => {
    set('acc-me', 'conv-1', 'mine');
    set('acc-other', 'conv-1', 'theirs');
    expect(readDraft('acc-me', 'conv-1')).toBe('mine');
    expect(readDraft('acc-other', 'conv-1')).toBe('theirs');
    expect(readDraft(undefined, 'conv-1')).toBe('');
    expect(draftKey('acc-me', 'conv-1')).not.toBe(draftKey('acc-me-conv', '1'));
  });

  it('does not notify anybody for a write that changes nothing', () => {
    set('acc-me', 'conv-1', 'same');
    const before = useDraftStore.getState().drafts;
    set('acc-me', 'conv-1', 'same');
    set('acc-me', 'conv-2', '');
    expect(useDraftStore.getState().drafts).toBe(before);
  });
});

describe('signing out', () => {
  it('forgets every draft: unsent text is the plaintext of somebody who just left', async () => {
    set('acc-me', 'conv-1', 'private');
    const client = {
      instance: { clearCallPushToken: async () => undefined },
      reset: async () => ({ revoked: 'not-needed' as const }),
    } as unknown as Parameters<typeof signOutOfAllo>[0];
    await signOutOfAllo(client, async () => undefined);
    expect(useDraftStore.getState().drafts).toEqual({});
  });
});
