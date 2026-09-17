/**
 * The delivery worker: nudge when a socket is live, push only for
 * `app_message` and only with a token, backoff on a transient failure, token
 * cleared on rejection, lease reclaim after a dead worker.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { PushDevice, PushNotification } from "../../services/push/delivery";
import { claimDueDeliveries } from "../../db/platform/deliveryRepository";
import { backoffMs, DELIVERY_LEASE_MS, pushNotificationFor, runDeliveryTick } from "../../workers/deliveryWorker";
import { base64, createPlatformHarness, dmBetween, type PlatformHarness } from "./harness";

let h: PlatformHarness;

beforeAll(async () => {
  h = await createPlatformHarness();
}, 180_000);

afterAll(async () => {
  await h?.drop();
});

beforeEach(() => {
  h.realtime.reset();
});

let keyCounter = 0;
const key = () => `d-${process.pid}-${++keyCounter}`;

interface FakePush {
  calls: { devices: PushDevice[]; notification: PushNotification }[];
  send: (devices: readonly PushDevice[], notification: PushNotification) => Promise<{ rejected: string[]; hasTransientFailure: boolean }>;
}

function fakePush(outcome: { rejected?: string[]; hasTransientFailure?: boolean } = {}): FakePush {
  const calls: FakePush["calls"] = [];
  return {
    calls,
    send: async (devices, notification) => {
      calls.push({ devices: [...devices], notification });
      return { rejected: outcome.rejected ?? [], hasTransientFailure: outcome.hasTransientFailure ?? false };
    },
  };
}

async function deliveriesFor(instanceId: string) {
  return h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.instanceId, instanceId));
}

/** A DM where b holds a push token; a sends one app_message; returns b's pending delivery for it. */
async function messageToB(provider: "fcm" | "apns" = "fcm") {
  const dm = await dmBetween(h.app);
  await dm.b.signed("put", "/v1/instances/me/push", { provider, token: `tok-${dm.b.id}` }).expect(204);
  // Drain b's welcome delivery so only the message is due.
  await runDeliveryTick({ db: h.db, realtime: h.realtime, push: fakePush().send, leaseOwner: "drain" });
  const sent = await dm.a.signed("post", `/v1/conversations/${dm.conversationId}/events`, {
    idempotencyKey: key(),
    kind: "app_message",
    epoch: 1,
    payload: base64("hello"),
  });
  expect(sent.status).toBe(200);
  const [delivery] = await h.db
    .select()
    .from(schema.instanceDeliveries)
    .where(and(eq(schema.instanceDeliveries.instanceId, dm.b.id), eq(schema.instanceDeliveries.eventId, sent.body.event.id)));
  return { ...dm, eventId: sent.body.event.id as string, delivery };
}

describe("runDeliveryTick", () => {
  it("nudges a connected instance over the socket and sends no push", async () => {
    const { b, conversationId, delivery } = await messageToB();
    h.realtime.reset();
    h.realtime.connected.add(b.id);
    const push = fakePush();
    const result = await runDeliveryTick({ db: h.db, realtime: h.realtime, push: push.send, leaseOwner: "w1" });
    expect(result.nudged).toBeGreaterThanOrEqual(1);
    expect(h.realtime.nudges).toContainEqual({ instanceIds: [b.id], event: { conversationId } });
    expect(push.calls).toEqual([]);
    const [row] = await h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.id, delivery.id));
    expect(row.status).toBe("notified");
    expect(row.notifiedAt).not.toBeNull();
    expect(row.leaseOwner).toBeNull();
  });

  it("pushes 'New message' with only the coordinates to an offline instance's token, routed by provider", async () => {
    const { b, conversationId, eventId, delivery } = await messageToB("apns");
    const push = fakePush();
    await runDeliveryTick({ db: h.db, realtime: h.realtime, push: push.send, leaseOwner: "w2" });
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0].devices).toEqual([{ platform: "ios", token: `tok-${b.id}` }]);
    expect(push.calls[0].notification).toEqual({ title: "Allo", body: "New message", data: { conversationId, eventId } });
    // The notification never carries anything derived from the payload.
    expect(JSON.stringify(push.calls[0].notification)).not.toContain(base64("hello"));
    const [row] = await h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.id, delivery.id));
    expect(row.status).toBe("notified");
  });

  it("never pushes for a non-app_message kind, and marks it notified without a socket", async () => {
    const dm = await dmBetween(h.app);
    await dm.b.signed("put", "/v1/instances/me/push", { provider: "fcm", token: "t" }).expect(204);
    // b's only pending delivery is the mls_welcome from the create.
    const push = fakePush();
    const result = await runDeliveryTick({ db: h.db, realtime: h.realtime, push: push.send, leaseOwner: "w3" });
    expect(push.calls).toEqual([]);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const rows = await deliveriesFor(dm.b.id);
    expect(rows.map((r) => r.status)).toEqual(["notified"]);
  });

  it("backs off a transient failure and marks the token rejected by clearing it", async () => {
    const transient = await messageToB();
    const before = new Date();
    await runDeliveryTick({ db: h.db, realtime: h.realtime, push: fakePush({ hasTransientFailure: true }).send, leaseOwner: "w4", now: () => before });
    let [row] = await h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.id, transient.delivery.id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.leaseOwner).toBeNull();
    expect(row.availableAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + backoffMs(1) - 5);
    expect(row.lastError).toBe("push transient failure");
    // Not due again yet: a second tick right now claims nothing for it.
    const again = await runDeliveryTick({ db: h.db, realtime: h.realtime, push: fakePush().send, leaseOwner: "w4b", now: () => before });
    expect(again.claimed).toBe(0);

    const rejected = await messageToB();
    await runDeliveryTick({ db: h.db, realtime: h.realtime, push: fakePush({ rejected: [`tok-${rejected.b.id}`] }).send, leaseOwner: "w5" });
    [row] = await h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.id, rejected.delivery.id));
    expect(row.status).toBe("notified");
    const [instance] = await h.db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, rejected.b.id));
    expect(instance.pushToken).toBeNull();
    expect(instance.pushProvider).toBeNull();
  });

  it("reclaims a delivery whose lease expired, and not one still leased", async () => {
    const { delivery } = await messageToB();
    const t0 = new Date();
    const first = await claimDueDeliveries({ leaseOwner: "dead-worker", leaseMs: DELIVERY_LEASE_MS, limit: 100, now: t0 }, h.db);
    expect(first.map((d) => d.id)).toContain(delivery.id);

    const tooSoon = await claimDueDeliveries({ leaseOwner: "w6", leaseMs: DELIVERY_LEASE_MS, limit: 100, now: t0 }, h.db);
    expect(tooSoon.map((d) => d.id)).not.toContain(delivery.id);

    const later = new Date(t0.getTime() + DELIVERY_LEASE_MS + 1);
    const push = fakePush();
    const result = await runDeliveryTick({ db: h.db, realtime: h.realtime, push: push.send, leaseOwner: "w6", now: () => later });
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    const [row] = await h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.id, delivery.id));
    expect(row.status).toBe("notified");
    expect(row.attempts).toBe(2);
  });

  it("kills the deliveries of a revoked instance", async () => {
    const { b, delivery } = await messageToB();
    await b.signed("post", `/v1/instances/${b.id}/revoke`).expect(200);
    await runDeliveryTick({ db: h.db, realtime: h.realtime, push: fakePush().send, leaseOwner: "w7" });
    const [row] = await h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.id, delivery.id));
    expect(row.status).toBe("dead");
  });

  it("the notification is content-free by construction", () => {
    expect(pushNotificationFor("c", "e")).toEqual({ title: "Allo", body: "New message", data: { conversationId: "c", eventId: "e" } });
    expect(backoffMs(0)).toBe(1_000);
    expect(backoffMs(3)).toBe(8_000);
    expect(backoffMs(40)).toBe(60 * 60 * 1_000);
  });
});
