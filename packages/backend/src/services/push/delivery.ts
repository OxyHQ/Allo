import type { PushPlatform } from "../../config/push";
import type { PushNotificationDevice, PushNotificationRequest } from "./notification";

/**
 * What happened to one device, and the distinction the whole gateway turns on.
 *
 * `rejected` and `failed` look the same from here — nothing arrived — and mean
 * opposite things to the homeserver:
 *
 * - **`rejected`** goes into the response's `rejected` list, and Synapse deletes
 *   the pusher. Correct only when the provider said the token is permanently
 *   gone: the app was uninstalled, the token was reissued, it was never ours.
 *   Saying it about a live device silently ends that person's notifications, and
 *   nothing about the app looks broken afterwards.
 * - **`failed`** is left out of the list and reported as a 5xx, so Synapse keeps
 *   the pusher and tries again. Correct for everything else, including every
 *   error whose cause might be us rather than the token — a bad payload, an
 *   expired signing key, a provider outage. Getting this wrong in the other
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
 * One provider's half of the gateway.
 *
 * Takes a batch because FCM's API is a batch API, and answers **in the same
 * order** as the devices it was given. Order is how the caller maps an outcome
 * back to a pushkey, so an implementation that filters or reorders would credit
 * one device's rejection to another.
 */
export interface PushSender {
  readonly platform: PushPlatform;
  send(
    devices: readonly PushNotificationDevice[],
    notification: PushNotificationRequest,
  ): Promise<readonly PushDeliveryOutcome[]>;
}

/**
 * The text a notification is shown with when the gateway has nothing better.
 *
 * The gateway genuinely has nothing better: `event_id_only` means it has never
 * seen the message, which is the point. A client that registered a
 * `default_payload` gets its own words — in its own language — and this is what
 * is left for one that did not.
 */
export const BUILT_IN_FALLBACK_TITLE = "Allo";
export const BUILT_IN_FALLBACK_BODY = "New message";

/** The words this notification should carry for this device. */
export function notificationText(device: PushNotificationDevice): {
  readonly title: string;
  readonly body: string;
} {
  return {
    title: device.fallback?.title ?? BUILT_IN_FALLBACK_TITLE,
    body: device.fallback?.body ?? BUILT_IN_FALLBACK_BODY,
  };
}

/**
 * Whether this notification is an alert or only a change of counts.
 *
 * A notification with no event is the one Synapse sends after the user has read
 * something on another device: there is nothing new to announce, only a badge to
 * bring down. Showing an alert for it is how an app ends up announcing messages
 * the user has already read.
 */
export function isAlert(notification: PushNotificationRequest): boolean {
  return notification.eventId !== undefined;
}
