import { SHARE_TEXT_MAX, shareTextFromParam } from '@/lib/chat/shareText';

describe('shareTextFromParam', () => {
  it('reduces an untrusted `text` param to bounded plain text', () => {
    expect(shareTextFromParam(undefined)).toBe('');
    expect(shareTextFromParam(['  look\r\nhttps://e.x/p/1‮\u0007 ', 'ignored'])).toBe(
      'look\nhttps://e.x/p/1',
    );
    const long = shareTextFromParam('😀'.repeat(SHARE_TEXT_MAX + 5));
    expect(Array.from(long)).toHaveLength(SHARE_TEXT_MAX);
    expect(long.endsWith('😀')).toBe(true);
  });
});
