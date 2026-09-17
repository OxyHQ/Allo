import { connect, constants, type ClientHttp2Session } from "http2";

import type { ApnsCredentials } from "../../config/push";
import { logger } from "../../utils/logger";
import type { PushDeliveryOutcome, PushDevice, PushNotification, PushSender } from "./delivery";
import type { ApnsTokenProvider } from "./apnsAuth";

/**
 * iOS delivery, straight to Apple over HTTP/2.
 *
 * No library: APNs is one POST per device to `/3/device/<token>` with a signed
 * provider token in a header, and Node has an HTTP/2 client and an ECDSA signer
 * in its standard library. A dependency here would be a third party in the path
 * of every notification, holding a private key, for a protocol that fits in this
 * file.
 *
 * ## What is in the payload
 *
 * The same as the Android one and for the same reason: the caller's title and
 * body, and its `data` coordinates. Never the message — see `delivery.ts`.
 *
 * `mutable-content` is set on every alert. It changes nothing today, because
 * Allo ships no notification service extension; it is what *lets* one rewrite
 * the body with the decrypted message later, and setting it now means that work
 * does not also need a server change.
 */

/** The path APNs takes a device token on. */
const DEVICE_PATH_PREFIX = "/3/device/";

/** How long one request may take before it is given up on as a failure. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Apple's priority for an alert the user should see now. */
const PRIORITY_IMMEDIATE = "10";

/**
 * The APNs reasons that mean this token is permanently undeliverable.
 *
 * Short, for the reason set out in `delivery.ts`, and every entry is
 * unambiguously about the token rather than about the request:
 *
 * - `BadDeviceToken` — not a token this topic can address, ever.
 * - `Unregistered` — the app is gone from that device (arrives with 410).
 * - `DeviceTokenNotForTopic` — a token for a different app.
 *
 * Everything else is transient, including the ones that look permanent.
 * `ExpiredProviderToken` and `InvalidProviderToken` are about *our* signing key,
 * `BadTopic` and `TopicDisallowed` about *our* configuration, and `PayloadTooLarge`
 * about *our* payload — treating any of them as a dead token would delete every
 * iOS token in the system over a mistake in one environment variable.
 */
const PERMANENTLY_INVALID_REASONS: ReadonlySet<string> = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
]);

export interface ApnsRequest {
  /** `/3/device/<token>`. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ApnsResponse {
  readonly status: number;
  /** Apple's machine-readable reason, when the status was not 200. */
  readonly reason: string | undefined;
}

/** What the sender needs of the network, so a test can supply it without Apple. */
export type ApnsTransport = (request: ApnsRequest) => Promise<ApnsResponse>;

export function createApnsSender(
  credentials: ApnsCredentials,
  tokens: ApnsTokenProvider,
  transport: ApnsTransport,
): PushSender {
  return {
    platform: "ios",
    async send(devices, notification) {
      return Promise.all(
        devices.map((device) => sendOne(device, notification, credentials, tokens, transport)),
      );
    },
  };
}

async function sendOne(
  device: PushDevice,
  notification: PushNotification,
  credentials: ApnsCredentials,
  tokens: ApnsTokenProvider,
  transport: ApnsTransport,
): Promise<PushDeliveryOutcome> {
  let response: ApnsResponse;
  try {
    response = await transport({
      path: `${DEVICE_PATH_PREFIX}${encodeURIComponent(device.token)}`,
      headers: buildHeaders(credentials, tokens),
      body: JSON.stringify(buildPayload(notification)),
    });
  } catch (error) {
    // A signing error, a connection that could not be opened, a timeout. None of
    // them says anything about the token, so the token survives.
    logger.error("[Push] an APNs request did not complete", error);
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }

  if (response.status === constants.HTTP_STATUS_OK) {
    return { kind: "delivered" };
  }

  const reason = response.reason ?? `status ${response.status}`;
  if (response.reason !== undefined && PERMANENTLY_INVALID_REASONS.has(response.reason)) {
    return { kind: "rejected", reason };
  }

  logger.warn("[Push] APNs did not deliver, and the token is being kept", {
    status: response.status,
    reason,
  });
  return { kind: "failed", reason };
}

function buildHeaders(
  credentials: ApnsCredentials,
  tokens: ApnsTokenProvider,
): Record<string, string> {
  return {
    authorization: `bearer ${tokens.token()}`,
    "apns-topic": credentials.topic,
    "apns-push-type": "alert",
    "apns-priority": PRIORITY_IMMEDIATE,
  };
}

/**
 * The APNs payload. `aps` is Apple's; the keys beside it are the caller's
 * `data`, which is why `data` may not use the key `aps` — Apple would read it.
 */
function buildPayload(notification: PushNotification): Record<string, unknown> {
  const { aps: _reserved, ...coordinates } = notification.data;
  return {
    aps: {
      alert: { title: notification.title, body: notification.body },
      "mutable-content": 1,
    },
    ...coordinates,
  };
}

/**
 * The real transport: one HTTP/2 session to Apple, reused.
 *
 * Reused because APNs expects it. Apple's guidance is explicit that a provider
 * should keep its connections open and multiplex over them; opening one per
 * notification costs a TLS handshake per message and, at any volume, gets the
 * provider throttled.
 *
 * The session is `unref`'d while idle so that holding one open cannot keep a
 * process alive that has finished — and `ref`'d again for as long as a request
 * is in flight, so that a process is never allowed to exit *during* one.
 */
export interface ApnsHttp2Transport {
  readonly send: ApnsTransport;
  /** Closes the connection. For a graceful shutdown, and for tests. */
  close(): void;
}

export function createHttp2ApnsTransport(host: string): ApnsHttp2Transport {
  let session: ClientHttp2Session | undefined;
  let inFlight = 0;

  const openSession = (): ClientHttp2Session => {
    const existing = session;
    if (existing !== undefined && !existing.closed && !existing.destroyed) {
      return existing;
    }
    const opened = connect(host);
    opened.unref();
    opened.on("error", (error) => {
      // Reported here rather than left to the individual streams: a session-level
      // error kills every stream on it, and each of those reports its own
      // failure. This is the one line that names the connection.
      logger.warn("[Push] the APNs connection failed and will be reopened", error);
    });
    const forget = (): void => {
      if (session === opened) session = undefined;
    };
    opened.on("close", forget);
    opened.on("goaway", forget);
    session = opened;
    return opened;
  };

  const send: ApnsTransport = (request) =>
    new Promise<ApnsResponse>((resolve, reject) => {
      let active: ClientHttp2Session;
      try {
        active = openSession();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      inFlight += 1;
      active.ref();
      const release = (): void => {
        inFlight -= 1;
        if (inFlight === 0) active.unref();
      };

      const stream = active.request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: request.path,
        ...request.headers,
      });
      stream.setEncoding("utf8");
      stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
        stream.destroy(new Error(`APNs did not answer within ${REQUEST_TIMEOUT_MS}ms`));
      });

      let status = 0;
      let body = "";
      let settled = false;
      const settle = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        release();
        outcome();
      };

      stream.on("response", (headers) => {
        const received = headers[constants.HTTP2_HEADER_STATUS];
        status = typeof received === "number" ? received : Number(received ?? 0);
      });
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("end", () => {
        settle(() => resolve({ status, reason: readReason(body) }));
      });
      stream.on("error", (error) => {
        settle(() => reject(error));
      });

      stream.end(request.body);
    });

  return {
    send,
    close(): void {
      session?.close();
      session = undefined;
    },
  };
}

/**
 * Apple's reason string, if the body carried one.
 *
 * A body that is not the JSON Apple documents is not an error worth raising: the
 * status alone already says the request did not succeed, and an unreadable body
 * only means the outcome cannot be narrowed to a specific reason — which the
 * caller treats as transient, the safe direction.
 */
function readReason(body: string): string | undefined {
  if (body.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const reason = (parsed as { reason?: unknown }).reason;
      if (typeof reason === "string" && reason.length > 0) return reason;
    }
  } catch (error) {
    logger.warn("[Push] an APNs response body was not JSON", error);
  }
  return undefined;
}
