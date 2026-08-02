import type { PushPlatform } from "../../config/push";
import { logger } from "../../utils/logger";
import type { PushDeliveryOutcome, PushSender } from "./delivery";
import type { PushNotificationDevice, PushNotificationRequest } from "./notification";

/**
 * Sending one notification to every device it names, and deciding what the
 * homeserver is told afterwards.
 *
 * The routing rule is the whole of it: a device's `app_id` says which provider
 * owns its `pushkey`, and nothing else does. A token is meaningless to the
 * wrong provider — an FCM registration token offered to Apple is not a slow
 * failure, it is a rejection — so an `app_id` this deployment does not serve
 * cannot be guessed at.
 */

export interface PushDispatchResult {
  /** Pushkeys the homeserver should stop sending to. Each appears at most once. */
  readonly rejected: readonly string[];
  /**
   * Whether anything failed in a way that is worth retrying, which the route
   * turns into a 5xx so Synapse tries again. Separate from {@link rejected}
   * because the two are opposite instructions — see `delivery.ts`.
   */
  readonly hasTransientFailure: boolean;
}

export async function dispatchPushNotification(
  notification: PushNotificationRequest,
  senders: ReadonlyMap<PushPlatform, PushSender>,
  platformByAppId: ReadonlyMap<string, PushPlatform>,
): Promise<PushDispatchResult> {
  const rejected: string[] = [];
  let hasTransientFailure = false;

  const byPlatform = new Map<PushPlatform, PushNotificationDevice[]>();

  for (const device of notification.devices) {
    const platform = platformByAppId.get(device.appId);
    if (platform === undefined) {
      /**
       * An app id this gateway does not serve. There is no provider to try, and
       * there never will be under this configuration, so the pusher is rejected
       * rather than left for Synapse to retry until the end of time. It is also
       * how a pusher registered against an app id that has since been retired
       * gets cleaned up.
       */
      logger.warn("[Push] a notification named an app id this deployment does not serve", {
        appId: device.appId,
      });
      rejected.push(device.pushkey);
      continue;
    }

    const existing = byPlatform.get(platform);
    if (existing === undefined) {
      byPlatform.set(platform, [device]);
    } else {
      existing.push(device);
    }
  }

  /**
   * Each batch carries its own devices back, rather than the caller pairing two
   * lists by index afterwards. Pairing them later would depend on two iterations
   * of the same Map staying in step, and the cost of that going wrong is one
   * device's rejection recorded against another device's pushkey — a live phone
   * deleted because a dead one failed.
   */
  const settled = await Promise.all(
    [...byPlatform.entries()].map(async ([platform, devices]) => {
      const sender = senders.get(platform);
      if (sender === undefined) {
        /**
         * Configuration guarantees a sender for every app id it publishes
         * (`config/push.ts` refuses to boot otherwise), so reaching this is a bug
         * rather than a deployment state. Transient is still the right answer:
         * the pushers are fine, this process is not.
         */
        logger.error("[Push] no sender is configured for a platform that has an app id", {
          platform,
        });
        const failure: PushDeliveryOutcome = { kind: "failed", reason: "no sender for platform" };
        return { devices, outcomes: devices.map(() => failure) };
      }
      return { devices, outcomes: await sender.send(devices, notification) };
    }),
  );

  for (const batch of settled) {
    batch.devices.forEach((device, index) => {
      const outcome: PushDeliveryOutcome = batch.outcomes[index] ?? {
        kind: "failed",
        reason: "the sender returned no outcome for this device",
      };
      if (outcome.kind === "rejected") {
        rejected.push(device.pushkey);
      } else if (outcome.kind === "failed") {
        hasTransientFailure = true;
      }
    });
  }

  return { rejected: [...new Set(rejected)], hasTransientFailure };
}
