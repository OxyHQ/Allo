/**
 * What a picked file looks like while it waits in the composer.
 *
 * Picking no longer sends: a file is STAGED, drawn by Bloom's
 * `ComposerAttachmentStrip`, and goes out with the next send carrying the
 * typed text as the first one's caption. So each pending file needs an id of
 * its own — `AlloOutgoingAttachment` has none, and two photos from the same
 * roll can share a filename.
 */
import type { ChatComposerAttachment, ChatComposerIcon } from '@oxy.so/bloom/chat-composer';
import { formatRecordingTime } from '@oxy.so/bloom/chat-composer';
import { RiFileTextLine, RiImageLine, RiMic2Line, RiMusic2Line, RiVideoLine } from '@oxy.so/bloom/icons';

import type { AlloMediaKind, AlloOutgoingAttachment } from '@/lib/chat/attachments';

/** One pending file: the id the strip removes it by, and what will be sent. */
export interface StagedAttachment {
  readonly id: string;
  readonly file: AlloOutgoingAttachment;
}

/** The glyph a tile draws when there is no picture to draw instead. */
const GLYPHS: Record<AlloMediaKind, ChatComposerIcon> = {
  image: RiImageLine,
  video: RiVideoLine,
  audio: RiMusic2Line,
  voice: RiMic2Line,
  file: RiFileTextLine,
};

/**
 * A tile for Bloom's strip.
 *
 * Only a picture has a `source`: a video's own URI is not an image, so it draws
 * the rendered thumbnail when the picker made one and the film glyph when it
 * did not. No `progress` — nothing is uploading yet, and a ring over a file
 * that has not been sent would say it is.
 */
export function stagedTile({ id, file }: StagedAttachment): ChatComposerAttachment {
  const source = file.kind === 'image' ? (file.thumbnail?.uri ?? file.uri) : file.thumbnail?.uri;
  return {
    id,
    name: file.filename,
    source,
    icon: source ? undefined : GLYPHS[file.kind],
    caption: file.durationMs ? formatRecordingTime(Math.round(file.durationMs / 1000)) : undefined,
  };
}

/**
 * What goes out when a draft with staged files is sent.
 *
 * The typed text becomes the FIRST file's caption — one message with a photo
 * and its line of prose, rather than a photo and then a stray sentence — and
 * the rest go as they were picked.
 */
export function withCaption(
  staged: readonly StagedAttachment[],
  text: string,
): readonly AlloOutgoingAttachment[] {
  if (!text) return staged.map((item) => item.file);
  return staged.map((item, index) => (index === 0 ? { ...item.file, caption: text } : item.file));
}
