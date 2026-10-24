/**
 * Each page's floating action. It used to be "new chat" on all three, so the
 * button on Status and Calls offered something those pages are not about.
 */
import { pickerModeFromParams } from '@/lib/chat/newConversation';
import { pageActionFor } from '@/lib/navigation/pageAction';

describe('pageActionFor', () => {
  it('matches the page in front', () => {
    expect(pageActionFor('index')).toBe('new-chat');
    expect(pageActionFor('updates')).toBe('add-status');
    expect(pageActionFor('calls')).toBe('new-call');
  });

  it('is a new chat over anything pushed above the pages, and for a page it does not know', () => {
    expect(pageActionFor(null)).toBe('new-chat');
    expect(pageActionFor('elsewhere')).toBe('new-chat');
  });
});

describe('pickerModeFromParams', () => {
  it('reads what /new was opened to do', () => {
    expect(pickerModeFromParams({})).toEqual({ kind: 'new' });
    expect(pickerModeFromParams({ addTo: 'conv-1' })).toEqual({
      kind: 'add',
      conversationId: 'conv-1',
    });
    expect(pickerModeFromParams({ call: 'voice' })).toEqual({ kind: 'call', mode: 'voice' });
    expect(pickerModeFromParams({ call: ['video', 'voice'] })).toEqual({
      kind: 'call',
      mode: 'video',
    });
  });

  it('never turns an unknown call value into a call, and adding wins over calling', () => {
    expect(pickerModeFromParams({ call: 'conference' })).toEqual({ kind: 'new' });
    expect(pickerModeFromParams({ call: '' })).toEqual({ kind: 'new' });
    expect(pickerModeFromParams({ addTo: 'conv-1', call: 'voice' })).toEqual({
      kind: 'add',
      conversationId: 'conv-1',
    });
  });
});
