import type { PushPlatform } from "../../config/push";
import { logger } from "../../utils/logger";
import type { PushDeliveryOutcome, PushDevice, PushNotification, PushSender } from "./delivery";
import { pushSenders } from "./senders";

/**
 * Sending one notification to every device it names, and summarising what the
 * caller should do about it afterwards.
 *
 * The routing rule is the whole of it: a device's `platform` says which
 * provider owns its token, and nothing else does. A token is meaningless to the
 * wrong provider — an FCM registration token offered to Apple is not a slow
 * failure, it is a rejection — so the platform is carried on the device rather
 * than guessed from the token's shape.
 */

export interface PushDispatchResult {
  /** Tokens the caller should stop delivering to. Each appears at most once. */
  readonly rejected: readonly string[];
  /**
   * Whether anything failed in a way that is worth retrying. Separate from
   * {@link rejected} because the two are opposite instructions — see
   * `delivery.ts`.
   */
  readonly hasTransientFailure: boolean;
}

/**
 * Deliver `notification` to `devices`, through the configured senders.
 *
 * `senders` is injectable so a test can route without a provider; production
 * takes the memoised map built from `config/push.ts`.
 */
export async function sendPush(
  devices: readonly PushDevice[],
  notification: PushNotification,
  senders: ReadonlyMap<PushPlatform, PushSender> = pushSenders(),
): Promise<PushDispatchResult> {
  const rejected: string[] = [];
  let hasTransientFailure = false;

  const byPlatform = new Map<PushPlatform, PushDevice[]>();
  for (const device of devices) {
    const existing = byPlatform.get(device.platform);
    if (existing === undefined) {
      byPlatform.set(device.platform, [device]);
    } else {
      existing.push(device);
    }
  }

  /**
   * Each batch carries its own devices back, rather than the caller pairing two
   * lists by index afterwards. Pairing them later would depend on two iterations
   * of the same Map staying in step, and the cost of that going wrong is one
   * device's rejection recorded against another device's token — a live phone
   * dropped because a dead one failed.
   */
  const settled = await Promise.all(
    [...byPlatform.entries()].map(async ([platform, batch]) => {
      const sender = senders.get(platform);
      if (sender === undefined) {
        /**
         * A platform this deployment has no credentials for. The tokens are
         * fine; this process cannot reach them. Transient, so a deployment that
         * gains the credentials later delivers to the same devices.
         */
        logger.warn("[Push] no sender is configured for a platform a device named", {
          platform,
        });
        const failure: PushDeliveryOutcome = { kind: "failed", reason: "no sender for platform" };
        return { devices: batch, outcomes: batch.map(() => failure) };
      }
      return { devices: batch, outcomes: await sender.send(batch, notification) };
    }),
  );

  for (const batch of settled) {
    batch.devices.forEach((device, index) => {
      const outcome: PushDeliveryOutcome = batch.outcomes[index] ?? {
        kind: "failed",
        reason: "the sender returned no outcome for this device",
      };
      if (outcome.kind === "rejected") {
        rejected.push(device.token);
      } else if (outcome.kind === "failed") {
        hasTransientFailure = true;
      }
    });
  }

  return { rejected: [...new Set(rejected)], hasTransientFailure };
}
