import type { ShareAttachmentRequest, ShareAttachmentOutcome } from './shareAttachment.types';

/**
 * Saving a decrypted attachment, in a browser.
 *
 * A download and not `navigator.share`. On the web what "save or share" means
 * in practice is a file in the downloads folder: the Web Share API can carry
 * files only on Safari for iOS and Chrome for Android, needs the bytes read back
 * out of the blob into a `File` first, and offers nothing at all on the desktop
 * browsers most of Allo's web users are on. A download works everywhere and is
 * what the button promises.
 *
 * **Nothing is copied and nothing outlives the tab.** The URI is the `blob:`
 * URL the media cache already created, which it revokes when it evicts the
 * entry, when the account changes and when the session ends. The anchor is
 * removed immediately; the bytes the browser then writes are the ones the user
 * asked for.
 */
export async function shareAttachment(
  request: ShareAttachmentRequest,
): Promise<ShareAttachmentOutcome> {
  if (typeof document === 'undefined') {
    // A React Native Web bundle running somewhere without a DOM — a server
    // render, a test environment. Nowhere to put a file.
    return 'unavailable';
  }

  const anchor = document.createElement('a');
  anchor.href = request.uri;
  anchor.download = request.filename;
  anchor.rel = 'noopener';
  // Off-screen rather than hidden: `display: none` stops the synthetic click
  // from reaching the anchor in some browsers.
  anchor.style.position = 'fixed';
  anchor.style.left = '-10000px';

  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
  return 'shared';
}
