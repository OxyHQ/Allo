import type { UploadMediaMeta } from '@allo/core';

import { readAttachmentBytes } from '@/lib/allo/attachmentBytes';
import type { AlloOutgoingAttachment } from '@/lib/chat/attachments';
import { logger } from '@/utils/logger';

/**
 * An attachment as `sendMedia` takes it: the file's bytes, and the picker's
 * description plus the rendered thumbnail's bytes.
 *
 * The thumbnail is the sender's to make — nobody else can read the original —
 * and it is what a receiver's bubble draws. The SDK encrypts it as a second
 * blob named by the same message. One that cannot be read is dropped rather
 * than fatal: the attachment still goes, and receivers fall back to the original.
 */
export async function toUpload(attachment: AlloOutgoingAttachment): Promise<{ bytes: Uint8Array; meta: UploadMediaMeta }> {
  const meta: UploadMediaMeta = {
    kind: attachment.kind,
    filename: attachment.filename,
    mime: attachment.mimetype,
    width: attachment.width,
    height: attachment.height,
    durationMs: attachment.durationMs,
    caption: attachment.caption,
  };
  const thumbnail = attachment.thumbnail;
  if (thumbnail) {
    try {
      meta.thumbnail = {
        bytes: await readAttachmentBytes(thumbnail.uri),
        mime: thumbnail.mimetype,
        width: thumbnail.width,
        height: thumbnail.height,
      };
    } catch (error) {
      logger.warn('[upload] the thumbnail could not be read; sending without one', error);
    }
  }
  return { bytes: await readAttachmentBytes(attachment.uri), meta };
}
