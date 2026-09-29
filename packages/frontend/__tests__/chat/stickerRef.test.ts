/**
 * A sticker in an end-to-end encrypted chat is drawn only when Oxy's catalogue
 * resolves the id to the SAME animation the sender saw, served from the
 * content-addressed URL for that hash. Each refusal below is a way a different
 * sticker could otherwise appear in a conversation nobody else can read.
 */
import type { Sticker } from '@oxy.so/stickers';

import { isSentSticker, stickerDraftOf } from '@/lib/chat/stickerRef';

const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function sticker(overrides: Partial<Sticker> = {}, animationSha = SHA, animationPathSha = SHA): Sticker {
  return {
    id: 'stk-1',
    packId: 'pack-1',
    emoji: ['😢'],
    keywords: ['sad'],
    size: 512,
    durationMs: 3000,
    animation: {
      url: `https://cloud.oxy.so/content/2026/09/aa/${animationPathSha}.json`,
      sha256: animationSha,
      mime: 'application/json',
      bytes: 100,
    },
    fallback: { url: 'https://cloud.oxy.so/content/2026/09/cc/c.webp', sha256: 'c'.repeat(64), mime: 'image/webp', bytes: 10 },
    ...overrides,
  };
}

const ref = { stickerId: 'stk-1', packId: 'pack-1', sha256: SHA, emoji: '😢' };

describe('isSentSticker', () => {
  it('draws the sticker the sender saw', () => {
    expect(isSentSticker(sticker(), ref)).toBe(true);
  });

  it('refuses nothing resolved, another id, another hash, or a URL that is not the hash’s own', () => {
    expect(isSentSticker(null, ref)).toBe(false);
    expect(isSentSticker(undefined, ref)).toBe(false);
    expect(isSentSticker(sticker({ id: 'stk-2' }), ref)).toBe(false);
    expect(isSentSticker(sticker({}, OTHER, OTHER), ref)).toBe(false);
    expect(isSentSticker(sticker({}, SHA, OTHER), ref)).toBe(false);
  });
});

describe('stickerDraftOf', () => {
  it('sends the id, the pack, the animation’s hash and the first emoji', () => {
    expect(stickerDraftOf(sticker())).toEqual(ref);
    expect(stickerDraftOf(sticker({ emoji: [] as unknown as Sticker['emoji'] }))).toEqual({
      stickerId: 'stk-1',
      packId: 'pack-1',
      sha256: SHA,
    });
  });
});
