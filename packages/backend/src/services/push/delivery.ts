import type { PushPlatform } from "../../config/push";

/**
 * The shapes every push sender speaks, and the distinction the whole subsystem
 * turns on.
 *
 * ## What a notification may carry
 *
 * A title, a body and string data. The backend never holds message plaintext —
 * it stores and relays ciphertext (`docs/platform/crypto.md`) — so a
 * notification's words are a generic wake-up ("New message") and its `data` is
 * coordinates the app uses to fetch and decrypt locally: a conversation id, an
 * event id. Nothing in this module can put content into a payload that the
 * caller did not have, and the caller does not have any.
 */

/** One device to deliver to: which provider owns its token, and the token. */
export interface PushDevice {
  readonly platform: PushPlatform;
  readonly token: string;
}

/** A notification, in the only shape the senders ever see. */
export interface PushNotification {
  readonly title: string;
  readonly body: string;
  /**
   * Coordinates for the app, never content. Both providers take string-valued
   * data only, which is why this is not `Record<string, unknown>`.
   */
  readonly data: Readonly<Record<string, string>>;
}

/**
 * What happened to one device.
 *
 * `rejected` and `failed` look the same from here — nothing arrived — and mean
 * opposite things to the caller:
 *
 * - **`rejected`** means the provider said the token is permanently gone: the
 *   app was uninstalled, the token was reissued, it was never ours. The caller
 *   should stop delivering to that token. Saying it about a live device silently
 *   ends that person's notifications, and nothing about the app looks broken
 *   afterwards.
 * - **`failed`** means try again later. Correct for everything else, including
 *   every error whose cause might be us rather than the token — a bad payload,
 *   an expired signing key, a provider outage. Getting this wrong in the other
 *   direction only costs a retry.
 *
 * When the two are hard to tell apart, `failed` is the answer. One mistake is
 * recoverable by waiting; the other is not recoverable at all.
 */
export type PushDeliveryOutcome =
  | { readonly kind: "delivered" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * One provider.
 *
 * Takes a batch because FCM's API is a batch API, and answers **in the same
 * order** as the devices it was given. Order is how the caller maps an outcome
 * back to a token, so an implementation that filters or reorders would credit
 * one device's rejection to another.
 */
export interface PushSender {
  readonly platform: PushPlatform;
  send(
    devices: readonly PushDevice[],
    notification: PushNotification,
  ): Promise<readonly PushDeliveryOutcome[]>;
}
