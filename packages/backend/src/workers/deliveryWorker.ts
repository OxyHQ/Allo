/**
 * The delivery worker: tells an instance something is waiting in its stream.
 *
 * Every second it claims up to 100 due `instance_deliveries` under a lease
 * and, for each: if the instance has a live socket, `sync.nudge` and
 * `notified`; else, if the event is an `app_message` and the instance holds a
 * push token, a push saying nothing but "New message" with the conversation
 * and event ids as data, and `notified`; else `notified` with nothing done —
 * the stream itself is the durable path and the client pulls it on its next
 * open. A transient push failure backs off (`min(2^attempts s, 1h)`); a
 * rejected token is cleared. A revoked instance's deliveries go `dead`.
 *
 * Not leader-gated: the claim is atomic (`FOR UPDATE SKIP LOCKED`), so every
 * task runs one. `start()`/`stop()` are a module singleton.
 */

import { randomUUID } from "node:crypto";
import { getDb, type AlloDatabase } from "../db";
import {
  claimDueDeliveries,
  deferDelivery,
  settleDelivery,
  type DeliveryRow,
} from "../db/platform/deliveryRepository";
import { findEventsByIds } from "../db/platform/eventRepository";
import { clearRejectedPushToken, findPushTargets, type PushTarget } from "../db/platform/instanceRepository";
import type { PushPlatform } from "../config/push";
import { sendPush, type PushDispatchResult } from "../services/push/dispatch";
import type { PushDevice, PushNotification } from "../services/push/delivery";
import { getRealtime, type Realtime } from "../runtime/realtime";
import { logger } from "../utils/logger";

export const DELIVERY_BATCH_SIZE = 100;
export const DELIVERY_INTERVAL_MS = 1_000;
export const DELIVERY_LEASE_MS = 30_000;
export const MAX_DELIVERY_ATTEMPTS = 20;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;

/** `min(2^attempts s, 1h)`. */
export function backoffMs(attempts: number): number {
  return Math.min(1_000 * 2 ** Math.min(attempts, 30), MAX_BACKOFF_MS);
}

/** The only notification this worker ever sends. No content, by construction. */
export function pushNotificationFor(conversationId: string, eventId: string): PushNotification {
  return { title: "Allo", body: "New message", data: { conversationId, eventId } };
}

const PLATFORM_BY_PROVIDER: Record<NonNullable<PushTarget["pushProvider"]>, PushPlatform> = {
  fcm: "android",
  apns: "ios",
};

export interface DeliveryWorkerDeps {
  db?: AlloDatabase;
  realtime?: Realtime;
  push?: (devices: readonly PushDevice[], notification: PushNotification) => Promise<PushDispatchResult>;
  leaseOwner?: string;
  now?: () => Date;
}

export interface DeliveryTickResult {
  claimed: number;
  nudged: number;
  pushed: number;
  skipped: number;
  deferred: number;
  dead: number;
}

/** One pass. Returns counts rather than throwing: a failing row is a normal condition. */
export async function runDeliveryTick(deps: DeliveryWorkerDeps = {}): Promise<DeliveryTickResult> {
  const db = deps.db ?? getDb();
  const realtime = deps.realtime ?? getRealtime();
  const push = deps.push ?? ((devices, notification) => sendPush(devices, notification));
  const leaseOwner = deps.leaseOwner ?? `allo-delivery-${randomUUID()}`;
  const now = deps.now ?? (() => new Date());
  const result: DeliveryTickResult = { claimed: 0, nudged: 0, pushed: 0, skipped: 0, deferred: 0, dead: 0 };

  const claimed = await claimDueDeliveries({ leaseOwner, leaseMs: DELIVERY_LEASE_MS, limit: DELIVERY_BATCH_SIZE, now: now() }, db);
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  const targets = new Map((await findPushTargets([...new Set(claimed.map((d) => d.instanceId))], db)).map((t) => [t.instanceId, t]));
  const events = new Map((await findEventsByIds([...new Set(claimed.map((d) => d.eventId))], db)).map((e) => [e.id, e]));

  for (const delivery of claimed) {
    try {
      const outcome = await handleOne(delivery, targets.get(delivery.instanceId), events.get(delivery.eventId)?.kind, {
        db,
        realtime,
        push,
        leaseOwner,
        now,
      });
      result[outcome] += 1;
    } catch (error: unknown) {
      logger.warn("delivery attempt failed", { deliveryId: delivery.id, attempts: delivery.attempts, error });
      await defer(delivery, leaseOwner, error instanceof Error ? error.message : String(error), now(), db);
      result.deferred += 1;
    }
  }
  return result;
}

async function defer(delivery: DeliveryRow, leaseOwner: string, error: string, now: Date, db: AlloDatabase): Promise<void> {
  if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
    await settleDelivery(delivery.id, leaseOwner, "dead", db);
    return;
  }
  await deferDelivery(delivery.id, leaseOwner, { availableAt: new Date(now.getTime() + backoffMs(delivery.attempts)), error }, db);
}

async function handleOne(
  delivery: DeliveryRow,
  target: PushTarget | undefined,
  kind: string | undefined,
  ctx: Required<Pick<DeliveryWorkerDeps, "db" | "realtime" | "push" | "leaseOwner" | "now">>,
): Promise<keyof DeliveryTickResult> {
  if (!target || target.status === "revoked") {
    await settleDelivery(delivery.id, ctx.leaseOwner, "dead", ctx.db);
    return "dead";
  }
  if (await ctx.realtime.isInstanceConnected(delivery.instanceId)) {
    ctx.realtime.nudge([delivery.instanceId], { conversationId: delivery.conversationId });
    await settleDelivery(delivery.id, ctx.leaseOwner, "notified", ctx.db);
    return "nudged";
  }
  if (kind === "app_message" && target.pushProvider && target.pushToken) {
    const device: PushDevice = { platform: PLATFORM_BY_PROVIDER[target.pushProvider], token: target.pushToken };
    const outcome = await ctx.push([device], pushNotificationFor(delivery.conversationId, delivery.eventId));
    if (outcome.rejected.includes(device.token)) {
      await clearRejectedPushToken(target.instanceId, device.token, ctx.db);
      await settleDelivery(delivery.id, ctx.leaseOwner, "notified", ctx.db);
      return "skipped";
    }
    if (outcome.hasTransientFailure) {
      if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
        await settleDelivery(delivery.id, ctx.leaseOwner, "dead", ctx.db);
        return "dead";
      }
      await deferDelivery(
        delivery.id,
        ctx.leaseOwner,
        { availableAt: new Date(ctx.now().getTime() + backoffMs(delivery.attempts)), error: "push transient failure" },
        ctx.db,
      );
      return "deferred";
    }
    await settleDelivery(delivery.id, ctx.leaseOwner, "notified", ctx.db);
    return "pushed";
  }
  await settleDelivery(delivery.id, ctx.leaseOwner, "notified", ctx.db);
  return "skipped";
}

let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<unknown> | undefined;
let stopped = false;

export function startDeliveryWorker(deps: DeliveryWorkerDeps = {}): void {
  if (timer) return;
  stopped = false;
  const leaseOwner = deps.leaseOwner ?? `allo-delivery-${randomUUID()}`;
  const tick = () => {
    if (inFlight || stopped) return;
    inFlight = runDeliveryTick({ ...deps, leaseOwner })
      .then((result) => {
        if (result.claimed > 0) logger.debug("delivery tick", result);
      })
      .catch((error: unknown) => logger.error("delivery tick failed", error))
      .finally(() => {
        inFlight = undefined;
      });
  };
  tick();
  timer = setInterval(tick, DELIVERY_INTERVAL_MS);
  timer.unref?.();
  logger.info("delivery worker started", { intervalMs: DELIVERY_INTERVAL_MS });
}

export async function stopDeliveryWorker(): Promise<void> {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  await inFlight;
}
