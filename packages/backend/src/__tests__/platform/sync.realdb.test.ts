/**
 * The per-instance delivery stream: opaque cursors, `hasMore`, ack.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { decodeCursor, encodeCursor, INITIAL_CURSOR, syncResponseSchema } from "@allo/shared-types";
import * as schema from "../../db/schema";
import { base64, createPlatformHarness, dmBetween, expectParses, type PlatformHarness } from "./harness";

let h: PlatformHarness;

beforeAll(async () => {
  h = await createPlatformHarness();
}, 180_000);

afterAll(async () => {
  await h?.drop();
});

let keyCounter = 0;
const key = () => `s-${process.pid}-${++keyCounter}`;

describe("GET /v1/sync and POST /v1/sync/ack", () => {
  it("streams this instance's deliveries in order, pages with hasMore, and resumes from the cursor", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    for (let i = 0; i < 3; i += 1) {
      await a
        .signed("post", `/v1/conversations/${conversationId}/events`, { idempotencyKey: key(), kind: "app_message", epoch: 1, payload: base64(`m${i}`) })
        .expect(200);
    }
    // b's stream: the welcome, then three messages. a's: nothing at all.
    const first = await b.signed("get", "/v1/sync?limit=2");
    expect(first.status).toBe(200);
    const page1 = expectParses(syncResponseSchema, first.body);
    expect(page1.deliveries.map((d) => d.event.kind)).toEqual(["mls_welcome", "app_message"]);
    expect(page1.deliveries.every((d) => d.conversationId === conversationId)).toBe(true);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe(page1.deliveries[1].cursor);
    // Cursors are opaque base64url integers, increasing.
    expect(decodeCursor(page1.deliveries[1].cursor)).toBeGreaterThan(decodeCursor(page1.deliveries[0].cursor));

    const second = await b.signed("get", `/v1/sync?cursor=${page1.nextCursor}&limit=10`);
    const page2 = expectParses(syncResponseSchema, second.body);
    expect(page2.deliveries.map((d) => d.event.payload)).toEqual([base64("m1"), base64("m2")]);
    expect(page2.hasMore).toBe(false);

    const empty = await b.signed("get", `/v1/sync?cursor=${page2.nextCursor}`);
    const page3 = expectParses(syncResponseSchema, empty.body);
    expect(page3).toEqual({ deliveries: [], nextCursor: page2.nextCursor, hasMore: false });

    const senderView = await a.signed("get", "/v1/sync");
    expect(expectParses(syncResponseSchema, senderView.body)).toEqual({ deliveries: [], nextCursor: INITIAL_CURSOR, hasMore: false });

    // Ack up to page 1's cursor: those two are acked, the rest still pending; a
    // later sync still returns everything after the cursor (ack does not hide).
    await b.signed("post", "/v1/sync/ack", { cursor: page1.nextCursor }).expect(204);
    const rows = await h.db
      .select()
      .from(schema.instanceDeliveries)
      .where(and(eq(schema.instanceDeliveries.instanceId, b.id)));
    expect(rows.map((r) => r.status)).toEqual(["acked", "acked", "pending", "pending"]);
    expect(rows.filter((r) => r.status === "acked").every((r) => r.ackedAt !== null)).toBe(true);
  });

  it("refuses a cursor it did not mint and an out-of-range limit", async () => {
    const { b } = await dmBetween(h.app);
    expect((await b.signed("get", "/v1/sync?cursor=not*base64url")).status).toBe(400);
    expect((await b.signed("get", `/v1/sync?cursor=${encodeCursor(0)}&limit=9999`)).status).toBe(400);
    const notANumber = Buffer.from("abc").toString("base64url");
    expect((await b.signed("get", `/v1/sync?cursor=${notANumber}`)).status).toBe(400);
    const ack = await b.signed("post", "/v1/sync/ack", { cursor: notANumber });
    expect(ack.status).toBe(400);
  });

  it("never shows another instance's deliveries", async () => {
    const dm1 = await dmBetween(h.app);
    const dm2 = await dmBetween(h.app);
    await dm1.a
      .signed("post", `/v1/conversations/${dm1.conversationId}/events`, { idempotencyKey: key(), kind: "app_message", epoch: 1, payload: base64("private") })
      .expect(200);
    const other = await dm2.b.signed("get", "/v1/sync");
    expect(other.body.deliveries.map((d: { conversationId: string }) => d.conversationId)).toEqual([dm2.conversationId]);
  });
});
