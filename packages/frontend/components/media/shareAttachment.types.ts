/**
 * The contract both halves of {@link shareAttachment} answer to.
 *
 * Its own module because `shareAttachment.native.ts` and
 * `shareAttachment.web.ts` are resolved one-or-the-other by the bundler, so
 * neither can be the one that owns the shape — the same arrangement
 * `lib/matrix/types.ts` has for the chat client.
 */

export interface ShareAttachmentRequest {
  /**
   * Where the decrypted bytes already are: a `file://` path on a phone, a
   * `blob:` URL in a browser. Whatever the media cache is holding, never a copy
   * made for this call.
   */
  readonly uri: string;
  /** What to call it in a share sheet or a downloads folder. */
  readonly filename: string;
  /** Absent when the sender's client did not say what the bytes are. */
  readonly mimetype: string | undefined;
}

/**
 * What happened.
 *
 * `unavailable` is not a failure and must not be drawn as one: it is a platform
 * that has nowhere to send a file — a browser with no download and no Web Share,
 * an Android build with no app installed that accepts one. The user is told
 * that sharing is not possible here, not that something went wrong.
 *
 * A share the user cancelled reports `shared`, because neither platform tells
 * us otherwise and a message claiming failure after a deliberate cancellation is
 * worse than silence.
 */
export type ShareAttachmentOutcome = 'shared' | 'unavailable';
