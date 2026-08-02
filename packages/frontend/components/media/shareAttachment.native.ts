import * as Sharing from 'expo-sharing';

import type { ShareAttachmentRequest, ShareAttachmentOutcome } from './shareAttachment.types';

/**
 * Handing a decrypted attachment to the rest of the phone.
 *
 * The OS share sheet is both halves of "save or share": it is where *Save
 * Image*, *Save to Files*, and every other app the user has live. Reaching for
 * `expo-media-library` instead would buy one of those destinations at the cost
 * of asking for write access to the whole photo library, for a feature that is
 * a single tap on a single picture.
 *
 * **Nothing is copied.** The URI shared is the one the media cache already
 * holds — a file the port decrypted into the app's cache directory, which
 * `MatrixMediaCache` releases when it evicts the entry, when the account
 * changes and when the session ends. Writing a second copy somewhere friendlier
 * would be a plaintext photograph from an encrypted conversation outliving the
 * session that was allowed to read it.
 */
export async function shareAttachment(
  request: ShareAttachmentRequest,
): Promise<ShareAttachmentOutcome> {
  if (!(await Sharing.isAvailableAsync())) {
    return 'unavailable';
  }
  await Sharing.shareAsync(request.uri, {
    // Both are hints the sheet uses to decide what it can offer. A picture with
    // no MIME type on Android is offered to every app that takes a file, which
    // is a list nobody wants to read.
    mimeType: request.mimetype,
    UTI: request.mimetype,
    dialogTitle: request.filename,
  });
  return 'shared';
}
