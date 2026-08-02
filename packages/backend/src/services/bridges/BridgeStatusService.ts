import * as z from "zod";
import { bridgesConfig, type EnabledBridgeNetwork } from "../../config/bridges";
import BridgeAccount, {
  type BridgeAccountState,
  type LeanBridgeAccount,
} from "../../models/BridgeAccount";
import { logger } from "../../utils/logger";
import {
  accountStateForBridgeState,
  bridgeStateTtlSeconds,
  shouldNotifyUser,
} from "./bridgeStateMapping";
import { oxyUserIdFromMatrixUserId } from "./matrixIdentity";

/**
 * Taking what the bridges say about their connections (docs/matrix/bridges.md §5.4).
 *
 * Two halves that only make sense together:
 *
 * - the webhook, which hears about every state change; and
 * - the sweep, which hears about SILENCE.
 *
 * The second exists because of a specific property of the first: `BridgeState`
 * carries a `ttl`, and the bridge re-sends an unchanged state once that TTL
 * expires. So a state older than its own TTL means nothing is sending — the
 * process died, the container was evicted, the network partitioned — which is
 * precisely the failure no webhook can ever report, because reporting it
 * requires being alive.
 */

/**
 * What a bridge posts to `status_endpoint`.
 *
 * Foreign data, parsed rather than cast. Only `state_event` is required: a
 * report that does not say what the state IS carries nothing to act on, while
 * every other field is a bridge-version detail that must not break ingestion by
 * being absent.
 */
const bridgeStateSchema = z.object({
  state_event: z.string(),
  error: z.string().optional(),
  message: z.string().optional(),
  reason: z.string().optional(),
  ttl: z.number().optional(),
  timestamp: z.number().optional(),
  remote_id: z.string().optional(),
  remote_name: z.string().optional(),
  remote_profile: z
    .object({
      name: z.string().optional(),
      username: z.string().optional(),
      phone: z.string().optional(),
      avatar_url: z.string().optional(),
    })
    .optional(),
  user_id: z.string().optional(),
  user_action: z.string().optional(),
});

export type BridgeStateReport = z.infer<typeof bridgeStateSchema>;

export function parseBridgeStateReport(payload: unknown): BridgeStateReport | undefined {
  const parsed = bridgeStateSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

/** Sends the "you need to re-link" nudge. Injected so tests do not import the server. */
export type BridgeStateNotifier = (
  oxyUserId: string,
  account: LeanBridgeAccount,
) => Promise<void>;

/**
 * Records that a user needs to re-link, without being able to tell them.
 *
 * This used to call `sendPushToUser`, which looked up the user's device tokens
 * in a collection **nothing ever wrote to** — so it found none, sent nothing, and
 * reported success, every time, since the day it was written. Deleting the
 * collection (see `config/push.ts`) removed the appearance of a nudge; it did not
 * remove a nudge, because there had never been one.
 *
 * There is no push path back here to replace it with, and that is architectural
 * rather than unfinished: on Matrix the homeserver owns the pusher registry and
 * a notification is something an *event in a room* causes. Allo's backend cannot
 * address a user's phone at all any more, by design. The nudge belongs where the
 * user is already looking — a message from the bridge bot into the admin room,
 * which is a Matrix event and would therefore notify through the ordinary path —
 * and that is a bridge-side change, not one this function can make.
 *
 * So it logs, at a level an operator sees, and the account's `action_required`
 * state remains what the app reads to draw the banner. Documented in
 * `docs/matrix/push.md` §7.
 */
const defaultNotifier: BridgeStateNotifier = async (oxyUserId, account) => {
  logger.warn("[Bridges] an account needs re-linking and the user cannot be notified directly", {
    oxyUserId,
    network: account.network,
  });
};

export interface ApplyBridgeStateResult {
  readonly matched: boolean;
  readonly state?: BridgeAccountState;
}

/**
 * Applies one reported state to the account it is about.
 *
 * An unmatched report is not an error: bridges report about their own lifecycle
 * too (`STARTING`, `UNCONFIGURED`), and those carry no `remote_id` because they
 * are not about anybody's account. Answering 2xx for them is correct — a non-2xx
 * would put the bridge on a retry schedule for a message that will never match.
 */
export async function applyBridgeState(
  network: EnabledBridgeNetwork,
  report: BridgeStateReport,
  notify: BridgeStateNotifier = defaultNotifier,
): Promise<ApplyBridgeStateResult> {
  if (!report.remote_id) return { matched: false };

  const account = await findAccount(network, report);
  if (!account) return { matched: false };

  const state = accountStateForBridgeState(report.state_event);
  const at = report.timestamp ? new Date(report.timestamp * 1_000) : new Date();

  await BridgeAccount.updateOne(
    { _id: account._id },
    {
      $set: {
        state,
        lastStateAt: at,
        rawState: {
          stateEvent: report.state_event,
          ...(report.error ? { error: report.error } : {}),
          ...(report.message ? { message: report.message } : {}),
          ...(report.reason ? { reason: report.reason } : {}),
          ...(typeof report.ttl === "number" ? { ttl: report.ttl } : {}),
          at,
        },
        ...(report.remote_name ? { remoteName: report.remote_name } : {}),
        ...(report.remote_profile
          ? {
              remoteProfile: {
                ...(report.remote_profile.name ? { name: report.remote_profile.name } : {}),
                ...(report.remote_profile.username
                  ? { username: report.remote_profile.username }
                  : {}),
                ...(report.remote_profile.phone ? { phone: report.remote_profile.phone } : {}),
                ...(report.remote_profile.avatar_url
                  ? { avatarUrl: report.remote_profile.avatar_url }
                  : {}),
              },
            }
          : {}),
        ...(state === "connected" ? { lastConnectedAt: at } : {}),
      },
      /**
       * Recovery clears the notification marker, so a SECOND genuine failure
       * after a recovery notifies again. Without this, a user who reconnects and
       * later gets logged out again would never be told the second time.
       */
      ...(state === "connected" ? { $unset: { lastNotifiedState: "", lastNotifiedAt: "" } } : {}),
    },
  );

  /**
   * §5.4 step 4's deduplication. `BAD_CREDENTIALS` is re-sent every time its TTL
   * lapses — hourly, by the bridge's own defaults — and a push per repeat is a
   * phone buzzing all night about something the user already knows.
   */
  if (shouldNotifyUser(state) && account.lastNotifiedState !== state) {
    try {
      await notify(account.oxyUserId, account);
      await BridgeAccount.updateOne(
        { _id: account._id },
        { $set: { lastNotifiedState: state, lastNotifiedAt: new Date() } },
      );
    } catch (error) {
      /**
       * A failed push must not fail the webhook. The state change is already
       * recorded, and answering non-2xx would have the bridge redeliver a report
       * that was applied correctly.
       */
      logger.warn("[Bridges] could not notify about an account needing attention", {
        network: network.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  /**
   * Alerted separately from `BAD_CREDENTIALS` even though users see one thing.
   * A rise in `LOGGED_OUT` on one network is the early shape of a ban wave; a
   * rise in `BAD_CREDENTIALS` usually is not.
   */
  if (report.state_event === "LOGGED_OUT") {
    logger.warn("[Bridges] remote network ended a session", { network: network.id });
  }

  return { matched: true, state };
}

async function findAccount(
  network: EnabledBridgeNetwork,
  report: BridgeStateReport,
): Promise<LeanBridgeAccount | null> {
  const remoteLoginId = report.remote_id;

  /**
   * Preferred path: the report names the Matrix user, so the lookup hits the
   * unique index and cannot possibly match somebody else's account.
   *
   * A foreign server name resolves to `undefined` and falls through — a bridge
   * reporting about `@someone:elsewhere.example` is reporting about a user this
   * homeserver does not have.
   */
  if (report.user_id) {
    const oxyUserId = oxyUserIdFromMatrixUserId(report.user_id);
    if (oxyUserId) {
      return await BridgeAccount.findOne({
        oxyUserId,
        network: network.id,
        remoteLoginId,
      }).lean<LeanBridgeAccount | null>();
    }
    return null;
  }

  return await BridgeAccount.findOne({
    network: network.id,
    remoteLoginId,
  }).lean<LeanBridgeAccount | null>();
}

export interface SweepResult {
  readonly markedFailed: number;
}

/**
 * Marks as `failed` every account whose last state outlived its own TTL (§5.4).
 *
 * The comparison is per-account rather than against one global age, because the
 * TTL is per-state: 1 hour when the bridge reported an error and 6 hours when it
 * did not. Sweeping on a single fixed age would either declare healthy accounts
 * dead or let broken ones sit green for hours.
 *
 * `linking` is excluded: an attempt in progress has no reported state yet, and
 * its own expiry is what governs it.
 */
export async function sweepStaleBridgeAccounts(now: Date = new Date()): Promise<SweepResult> {
  const marginMs = bridgesConfig().staleMarginSeconds * 1_000;

  const result = await BridgeAccount.updateMany(
    {
      state: { $nin: ["failed", "linking"] },
      $expr: {
        $lt: [
          {
            $add: [
              "$lastStateAt",
              { $multiply: [{ $ifNull: ["$rawState.ttl", DEFAULT_SWEEP_TTL_SECONDS] }, 1_000] },
              marginMs,
            ],
          },
          now,
        ],
      },
    },
    {
      $set: {
        state: "failed",
        "rawState.reason": "stale",
        lastStateAt: now,
      },
    },
  );

  if (result.modifiedCount > 0) {
    logger.warn("[Bridges] accounts went silent past their TTL and were marked failed", {
      count: result.modifiedCount,
    });
  }
  return { markedFailed: result.modifiedCount };
}

/**
 * The TTL to assume for an account whose last report carried none.
 *
 * The bridge's own healthy default, so an account that never reported a TTL is
 * held to the same silence budget as one that did — rather than to no budget at
 * all, which is how a dead process stays green forever.
 */
const DEFAULT_SWEEP_TTL_SECONDS = 21_600;

let sweepTimer: NodeJS.Timeout | undefined;

/**
 * Runs the sweep on an interval. A no-op unless some network is enabled.
 *
 * `unref` so the timer never holds the process open: a backend that will not
 * shut down because a housekeeping timer is pending is a deployment that hangs
 * on every rollout.
 */
export function startBridgeStatusSweep(intervalMs = 60_000): void {
  if (sweepTimer || !bridgesConfig().enabled) return;
  sweepTimer = setInterval(() => {
    void sweepStaleBridgeAccounts().catch((error: unknown) => {
      logger.error("[Bridges] stale-account sweep failed", error);
    });
  }, intervalMs);
  sweepTimer.unref();
}

export function stopBridgeStatusSweep(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}
