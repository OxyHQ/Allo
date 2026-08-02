import * as z from "zod";

import { logger } from "../../utils/logger";

/**
 * What Synapse posts to `POST /_matrix/push/v1/notify`, parsed rather than cast.
 *
 * This is foreign input arriving over the network, so nothing downstream sees a
 * field that has not been through this file.
 *
 * ## The shape is the one `format: "event_id_only"` produces
 *
 * Allo's rooms are encrypted and the gateway must never receive message
 * plaintext, so every pusher Allo registers asks the homeserver for
 * `event_id_only` — under which a notification carries the event id, the room
 * id, the unread counts and the devices, and nothing else. There is no `content`
 * and no `sender`, and consequently nothing here to read one from.
 *
 * Two things keep it that way, and the second is the one that matters. The
 * schema strips what it does not declare, so the parsed value holds no content
 * to be logged by accident. And {@link parsePushNotification} builds its result
 * **field by field** rather than spreading what it parsed — which is why
 * `notification.test.ts` asserts the exact set of keys that come out. A spread
 * would be the natural way to write it and would carry every plaintext field a
 * misconfigured pusher sent, straight into a provider payload, with nothing on
 * screen looking any different.
 *
 * {@link plaintextFieldsPresent} separately reports whether such a field
 * arrived, because the fact is worth knowing: it means a pusher exists somewhere
 * registered with the wrong format, and it will keep sending message text to
 * this gateway until it is replaced.
 */

/**
 * How many devices one request may name.
 *
 * Synapse sends exactly one — a pusher is a device — but the specification
 * allows a list, and a list is work this process does per request. The cap is
 * what stops a single POST from asking for an unbounded number of upstream
 * calls.
 */
export const MAXIMUM_DEVICES_PER_NOTIFICATION = 32;

/**
 * The fields whose presence means a pusher is registered with the wrong format.
 *
 * Every one of them is either message plaintext or metadata about who is talking
 * to whom, which is the thing `event_id_only` exists to keep off this server.
 */
const PLAINTEXT_FIELDS = [
  "content",
  "sender",
  "sender_display_name",
  "room_name",
  "room_alias",
] as const;

/**
 * Text to show when the gateway has nothing else to show.
 *
 * Sent by the client at registration time, inside the pusher's `data`, and
 * echoed back here by Synapse on every notification. It is there because the
 * gateway cannot write this text itself: it does not know the message (by
 * design) and it does not know the reader's language — `lang` is stored on the
 * pusher and is not forwarded. The client knows both, so it says once, at
 * registration, what its user should read.
 *
 * Bounded because it comes back to us from a homeserver and ends up in a
 * provider payload with a size limit of its own.
 */
const MAXIMUM_FALLBACK_LENGTH = 128;

/**
 * Reads a `default_payload` that arrived as a JSON string.
 *
 * Both halves of the client hand the SDK a string, and the two SDKs disagree
 * about what to do with it: the Rust binding parses it into a JSON value before
 * it goes to the homeserver, and `matrix-js-sdk` sends the string as it is. So
 * the same registration produces an object on one platform and a string on the
 * other, and a gateway that accepted only one of them would work on one platform
 * and quietly fall back to English on the other.
 */
function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    // Not an error worth a stack trace: a pusher registered with a malformed
    // payload still deserves its notification, with the built-in words.
    logger.debug("[Push] a pusher's default_payload was not JSON", error);
    return undefined;
  }
}

const fallbackTextSchema = z.preprocess(
  (value) => (typeof value === "string" ? parseJsonObject(value) : value),
  z.object({
    title: z.string().trim().min(1).max(MAXIMUM_FALLBACK_LENGTH),
    body: z.string().trim().min(1).max(MAXIMUM_FALLBACK_LENGTH),
  }),
);

export type PushFallbackText = z.infer<typeof fallbackTextSchema>;

/**
 * A `pushkey`'s length cap.
 *
 * An APNs token is 64 hex characters and an FCM registration token is around
 * 160; a thousand is far past either and still bounds what a forged request can
 * make this process allocate.
 */
const MAXIMUM_PUSHKEY_LENGTH = 1024;

const deviceSchema = z.object({
  app_id: z.string().trim().min(1).max(64),
  pushkey: z.string().trim().min(1).max(MAXIMUM_PUSHKEY_LENGTH),
  /**
   * The pusher's `data`, minus `url`, as the client registered it.
   *
   * Only `default_payload` is read. It is `.catch(undefined)` rather than
   * validated strictly because a malformed one is a client that registered
   * badly, and the notification is still worth delivering with the built-in
   * text — refusing it would turn a cosmetic mistake into a silent phone.
   */
  data: z
    .object({
      default_payload: fallbackTextSchema.optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  tweaks: z
    .object({
      sound: z.string().trim().min(1).max(64).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

const notificationSchema = z.object({
  /**
   * Absent on a counts-only notification — the one Synapse sends when the user
   * has read something elsewhere and the badge has to come down. It is not a
   * malformed request and it must not be treated as one.
   */
  event_id: z.string().trim().min(1).max(256).optional(),
  room_id: z.string().trim().min(1).max(256).optional(),
  counts: z
    .object({
      unread: z.number().int().min(0).optional(),
    })
    .optional()
    .catch(undefined),
  prio: z.enum(["high", "low"]).optional().catch(undefined),
  devices: z.array(deviceSchema).min(1).max(MAXIMUM_DEVICES_PER_NOTIFICATION),
});

const requestSchema = z.object({
  notification: notificationSchema,
});

/** One device a notification is addressed to. */
export interface PushNotificationDevice {
  readonly appId: string;
  readonly pushkey: string;
  readonly fallback: PushFallbackText | undefined;
  /** The `sound` tweak. Absent means the homeserver asked for no sound. */
  readonly sound: string | undefined;
}

/** A notification, in the only shape the senders ever see. */
export interface PushNotificationRequest {
  /** Absent on a counts-only notification. See {@link notificationSchema}. */
  readonly eventId: string | undefined;
  readonly roomId: string | undefined;
  readonly unreadCount: number | undefined;
  /** Whether the homeserver asked for this to be delivered without delay. */
  readonly highPriority: boolean;
  readonly devices: readonly PushNotificationDevice[];
}

/**
 * The notification in `payload`, or `undefined` if there is not one.
 *
 * `undefined` is the only failure this reports, and the caller turns it into a
 * 400. There is deliberately no partial success: a request naming ten devices of
 * which one is malformed is a request from something that is not the Synapse we
 * gave a URL to, and answering it halfway teaches nothing.
 */
export function parsePushNotification(payload: unknown): PushNotificationRequest | undefined {
  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return undefined;
  }
  const notification = parsed.data.notification;
  return {
    eventId: notification.event_id,
    roomId: notification.room_id,
    unreadCount: notification.counts?.unread,
    highPriority: notification.prio !== "low",
    devices: notification.devices.map((device) => ({
      appId: device.app_id,
      pushkey: device.pushkey,
      fallback: device.data?.default_payload,
      sound: device.tweaks?.sound,
    })),
  };
}

/**
 * The names of any plaintext fields that arrived, for the log.
 *
 * Names only, never values: the whole point is that this content should not be
 * on this server, and writing it to a log file would be the same leak with a
 * longer retention period. An empty array is the expected answer, forever.
 */
export function plaintextFieldsPresent(payload: unknown): readonly string[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const notification = (payload as { notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return [];
  }
  const present = notification as Record<string, unknown>;
  return PLAINTEXT_FIELDS.filter((field) => present[field] !== undefined);
}
