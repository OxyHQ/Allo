import type { PushConfig, PushPlatform } from "../../config/push";
import { pushConfig } from "../../config/push";
import { createApnsSender, createHttp2ApnsTransport } from "./apns";
import { createApnsTokenProvider } from "./apnsAuth";
import type { PushSender } from "./delivery";
import { createFcmSender, createFirebaseTransport } from "./fcm";

/**
 * The senders this process delivers through, built once from the configuration.
 *
 * Built once because both of them hold something worth keeping: `firebase-admin`
 * holds credentials, and the APNs transport holds an HTTP/2 connection to Apple
 * that is expensive to open and is meant to be reused across notifications.
 *
 * A platform with no entry here cannot be delivered to, and `config/push.ts`
 * guarantees that never happens by accident — an app id without credentials
 * fails at boot rather than producing a gateway that accepts notifications for a
 * platform it cannot reach.
 */

/** Builds the map. Pure, so a test can build one without touching the network. */
export function createPushSenders(config: PushConfig): ReadonlyMap<PushPlatform, PushSender> {
  const senders = new Map<PushPlatform, PushSender>();

  if (config.fcm !== undefined) {
    senders.set("android", createFcmSender(createFirebaseTransport(config.fcm)));
  }

  if (config.apns !== undefined) {
    const credentials = config.apns;
    const transport = createHttp2ApnsTransport(credentials.host);
    senders.set(
      "ios",
      createApnsSender(credentials, createApnsTokenProvider(credentials), transport.send),
    );
  }

  return senders;
}

let cached: ReadonlyMap<PushPlatform, PushSender> | undefined;

export function pushSenders(
  config: PushConfig = pushConfig(),
): ReadonlyMap<PushPlatform, PushSender> {
  if (!cached) cached = createPushSenders(config);
  return cached;
}

/** Resets the memoised senders. Tests only. */
export function resetPushSendersForTests(): void {
  cached = undefined;
}
