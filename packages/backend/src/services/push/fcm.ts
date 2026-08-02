import { cert, getApp, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getMessaging, type Message } from "firebase-admin/messaging";

import type { FcmCredentials } from "../../config/push";
import { logger } from "../../utils/logger";
import {
  isAlert,
  notificationText,
  type PushDeliveryOutcome,
  type PushSender,
} from "./delivery";
import type { PushNotificationDevice, PushNotificationRequest } from "./notification";

/**
 * Android delivery, through Firebase Cloud Messaging.
 *
 * ## What is in the payload, and what is not
 *
 * The event id and the room id, and text the client chose at registration time.
 * Never the message: this gateway has never seen one (see `notification.ts`), so
 * there is nothing here that could leak even by mistake.
 *
 * A `notification` block is included as well as the `data`, and that is a
 * deliberate concession rather than an oversight. A data-only message is what a
 * client that decrypts the event locally would want, and it is what Allo will
 * want once it can do that — but until something is listening for one, a
 * data-only message shows the user nothing at all. A messenger that does not
 * notify is not used. So the notification is displayed by the system with the
 * text the client supplied, and the coordinates travel beside it in `data` for
 * the day the app can turn them into the real message. See
 * `docs/matrix/push.md` §5.
 */

/**
 * The Firebase app this module talks through.
 *
 * Named, rather than the default one, because `initializeApp` throws when the
 * default app already exists and this module has no way of knowing what else in
 * the process has initialised Firebase. A name of our own means the two cannot
 * collide.
 */
const FIREBASE_APP_NAME = "allo-push";

/**
 * The FCM error codes that mean the token is permanently gone.
 *
 * Deliberately short. Everything not on this list is reported as a transient
 * failure, and two omissions are worth naming because both look like candidates:
 *
 * - **`messaging/invalid-argument`** is returned both for a malformed token and
 *   for a malformed *message*. Our message is built once and is the same shape
 *   for every device, so if it is ever wrong it is wrong for everybody — and
 *   treating that as "the token is invalid" would delete every pusher in the
 *   system in one pass, on a bug we introduced.
 * - **`messaging/sender-id-mismatch`** means the token belongs to a different
 *   Firebase project. That is a credential mistake on this side far more often
 *   than a bad token, and pointing the deployment at the right project makes
 *   every one of those tokens work again — if they have not been deleted in the
 *   meantime.
 *
 * Both are logged loudly instead. A stale pusher costs a wasted request per
 * message; a deleted live one costs a person their notifications with nothing on
 * screen to say so.
 */
const PERMANENTLY_INVALID_CODES: ReadonlySet<string> = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-recipient",
]);

/** What the sender needs of FCM, so a test can supply it without a project. */
export type FcmTransport = (
  messages: readonly Message[],
) => Promise<readonly FcmTransportResult[]>;

/** One message's outcome, in the same order as the messages sent. */
export interface FcmTransportResult {
  readonly success: boolean;
  /** The `messaging/...` code, when there is one. */
  readonly code: string | undefined;
  readonly message: string | undefined;
}

export function createFcmSender(transport: FcmTransport): PushSender {
  return {
    platform: "android",
    async send(devices, notification) {
      const messages = devices.map((device) => buildMessage(device, notification));

      let results: readonly FcmTransportResult[];
      try {
        results = await transport(messages);
      } catch (error) {
        /**
         * The whole call failed — credentials, network, an outage. Nothing here
         * says anything about any individual token, so every device is a
         * transient failure and every pusher survives.
         */
        logger.error("[Push] FCM refused the whole batch", error);
        const reason = error instanceof Error ? error.message : String(error);
        return devices.map(() => ({ kind: "failed", reason }) as const);
      }

      if (results.length !== devices.length) {
        /**
         * A transport that answers with a different number of results has broken
         * the one contract that lets an outcome be matched to a pushkey. Failing
         * all of them is the only safe reading: the alternative is attributing
         * somebody else's rejection to a live device.
         */
        logger.error("[Push] FCM returned a result count that does not match the batch", {
          sent: devices.length,
          received: results.length,
        });
        return devices.map(
          () => ({ kind: "failed", reason: "mismatched FCM result count" }) as const,
        );
      }

      return results.map((result) => outcomeFor(result));
    },
  };
}

function outcomeFor(result: FcmTransportResult): PushDeliveryOutcome {
  if (result.success) {
    return { kind: "delivered" };
  }
  const code = result.code ?? "unknown";
  if (PERMANENTLY_INVALID_CODES.has(code)) {
    return { kind: "rejected", reason: code };
  }
  logger.warn("[Push] FCM did not deliver, and the token is being kept", {
    code,
    message: result.message,
  });
  return { kind: "failed", reason: code };
}

function buildMessage(
  device: PushNotificationDevice,
  notification: PushNotificationRequest,
): Message {
  const data: Record<string, string> = {};
  if (notification.eventId !== undefined) data.event_id = notification.eventId;
  if (notification.roomId !== undefined) data.room_id = notification.roomId;
  if (notification.unreadCount !== undefined) {
    data.unread_count = String(notification.unreadCount);
  }

  const base = {
    token: device.pushkey,
    data,
    android: {
      priority: notification.highPriority ? ("high" as const) : ("normal" as const),
      /**
       * Collapsed on the event, so a retry after a transient failure replaces
       * the earlier attempt instead of ringing the phone twice for one message.
       * Counts-only notifications collapse together for the same reason.
       */
      collapseKey: notification.eventId ?? "allo.counts",
    },
  };

  if (!isAlert(notification)) {
    // Nothing to announce: a data message that a background handler can use to
    // bring a badge down, and that shows the user nothing on its own.
    return base;
  }

  const text = notificationText(device);
  return {
    ...base,
    notification: { title: text.title, body: text.body },
    android: {
      ...base.android,
      notification: {
        channelId: "default",
        ...(device.sound === undefined ? {} : { sound: device.sound }),
      },
    },
  };
}

/**
 * The real transport: `firebase-admin`, initialised once, lazily.
 *
 * Lazily because initialising Firebase reads a service account and opens
 * credentials, and a process that never receives a notification should never do
 * either.
 */
export function createFirebaseTransport(credentials: FcmCredentials): FcmTransport {
  let initialized = false;

  const ensureInitialized = (): void => {
    if (initialized) return;
    try {
      getApp(FIREBASE_APP_NAME);
    } catch {
      // `getApp` throws when the named app does not exist yet, which is the
      // normal path on the first notification. The catch is the existence check
      // the SDK does not otherwise offer.
      const serviceAccount = JSON.parse(credentials.serviceAccountJson) as ServiceAccount;
      initializeApp(
        { credential: cert(serviceAccount), projectId: credentials.projectId },
        FIREBASE_APP_NAME,
      );
      logger.info("[Push] Firebase Admin initialised for FCM");
    }
    initialized = true;
  };

  return async (messages) => {
    ensureInitialized();
    const response = await getMessaging(getApp(FIREBASE_APP_NAME)).sendEach([...messages]);
    return response.responses.map((entry) => ({
      success: entry.success,
      code: entry.error?.code,
      message: entry.error?.message,
    }));
  };
}
