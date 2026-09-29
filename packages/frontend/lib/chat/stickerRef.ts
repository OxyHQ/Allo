/**
 * Whether a sticker Oxy's catalogue resolved is the one a message named.
 *
 * A sticker message carries the id, the pack and the SHA-256 of the animation
 * as the SENDER saw it, and travels end-to-end encrypted: the server relaying it
 * never sees which sticker it is. The receiver resolves the id through Oxy and
 * must not draw anything but those exact bytes. Two checks, both needed:
 *
 * - The catalogue still answers with the sender's hash. A published sticker
 *   never changes, so a different hash means this is not the sticker that was
 *   sent.
 * - The file URL is the content-addressed one for that hash. Oxy's CDN stores
 *   every file under a key built from its own SHA-256
 *   (`content/{y}/{m}/{xx}/{sha256}.json`), so a URL that carries the hash can
 *   only ever serve those bytes. That is what lets the check stand without
 *   downloading and hashing the animation before drawing it.
 */
import type { Sticker } from '@oxy.so/stickers';
import type { StickerView } from '@allo/core';

export function isSentSticker(sticker: Sticker | null | undefined, ref: StickerView): sticker is Sticker {
  if (!sticker) return false;
  return (
    sticker.id === ref.stickerId &&
    sticker.animation.sha256 === ref.sha256 &&
    new URL(sticker.animation.url).pathname.includes(`/${ref.sha256}.`)
  );
}

/** What a message sends for a sticker picked from the catalogue. */
export function stickerDraftOf(sticker: Sticker): StickerView {
  return {
    stickerId: sticker.id,
    packId: sticker.packId,
    sha256: sticker.animation.sha256,
    ...(sticker.emoji[0] ? { emoji: sticker.emoji[0] } : {}),
  };
}
