import { describe, expect, it } from "vitest";
import {
  ackSyncRequestSchema,
  CLIENT_TO_SERVER_EVENTS,
  decodeCursor,
  encodeCursor,
  historyOfferEventSchema,
  INITIAL_CURSOR,
  instanceApprovedEventSchema,
  instanceRevokedEventSchema,
  keyPackagesLowEventSchema,
  presenceEventSchema,
  SERVER_TO_CLIENT_EVENTS,
  SOCKET_NAMESPACE,
  syncNudgeEventSchema,
  syncQuerySchema,
  syncResponseSchema,
  typingEventSchema,
  type ServerToClientEvents,
} from "../sync";
import { B64, ISO, OBJECT_ID, UUID_V7 } from "./fixtures";

describe("cursors", () => {
  it("round-trip numbers and bigints beyond 2^53", () => {
    for (const n of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
      expect(decodeCursor(encodeCursor(n))).toBe(BigInt(n));
    }
    const big = 9_223_372_036_854_775_807n;
    expect(decodeCursor(encodeCursor(big))).toBe(big);
  });
  it("is base64url of the decimal string, and INITIAL_CURSOR is zero", () => {
    expect(encodeCursor(0)).toBe("MA");
    expect(encodeCursor(0)).toBe(INITIAL_CURSOR);
    expect(encodeCursor(12345)).toBe(Buffer.from("12345").toString("base64url"));
    expect(encodeCursor(12345)).not.toContain("=");
  });
  it("orders like the integers only after decoding, never as text", () => {
    expect(decodeCursor(encodeCursor(10)) > decodeCursor(encodeCursor(9))).toBe(true);
  });
  it("rejects garbage, leading zeros, negatives, floats and non-digits", () => {
    expect(() => decodeCursor("not base64url!")).toThrow(RangeError);
    expect(() => decodeCursor(Buffer.from("007").toString("base64url"))).toThrow(RangeError);
    expect(() => decodeCursor(Buffer.from("-1").toString("base64url"))).toThrow(RangeError);
    expect(() => decodeCursor(Buffer.from("1.5").toString("base64url"))).toThrow(RangeError);
    expect(() => decodeCursor(Buffer.from("abc").toString("base64url"))).toThrow(RangeError);
    expect(() => decodeCursor("")).toThrow(RangeError);
    expect(() => encodeCursor(-1)).toThrow(RangeError);
    expect(() => encodeCursor(1.5)).toThrow(RangeError);
    expect(() => encodeCursor(-1n)).toThrow(RangeError);
  });
});

describe("sync response / query / ack", () => {
  const delivery = {
    cursor: encodeCursor(7),
    conversationId: UUID_V7,
    event: {
      id: UUID_V7,
      conversationId: UUID_V7,
      seq: 1,
      kind: "app_message",
      epoch: 0,
      senderAccountId: OBJECT_ID,
      senderInstanceId: UUID_V7,
      payload: B64,
      blobIds: [],
      createdAt: ISO,
    },
  };
  it("accepts a page", () => {
    expect(syncResponseSchema.safeParse({ deliveries: [delivery], nextCursor: encodeCursor(7), hasMore: false }).success).toBe(true);
  });
  it("rejects a numeric cursor and a missing nextCursor", () => {
    expect(syncResponseSchema.safeParse({ deliveries: [{ ...delivery, cursor: 7 }], nextCursor: "MA", hasMore: false }).success).toBe(false);
    expect(syncResponseSchema.safeParse({ deliveries: [], hasMore: false }).success).toBe(false);
  });
  it("query coerces limit, cursor optional", () => {
    expect(syncQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(syncQuerySchema.parse({ cursor: "MA", limit: "20" })).toEqual({ cursor: "MA", limit: 20 });
    expect(syncQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
    expect(syncQuerySchema.safeParse({ cursor: "a+b" }).success).toBe(false);
  });
  it("ack needs a cursor", () => {
    expect(ackSyncRequestSchema.safeParse({ cursor: "MA" }).success).toBe(true);
    expect(ackSyncRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("socket events", () => {
  it("names the namespace and every event in both directions", () => {
    expect(SOCKET_NAMESPACE).toBe("/v1");
    expect(Object.keys(SERVER_TO_CLIENT_EVENTS).sort()).toEqual(
      [
        "call.incoming",
        "call.updated",
        "history.offer",
        "instance.approved",
        "instance.revoked",
        "keypackages.low",
        "presence",
        "status.posted",
        "sync.nudge",
        "typing",
      ].sort(),
    );
    // Named, not counted: the client→server side is the one an app can point
    // at the server, and each addition is a decision worth seeing in a diff.
    expect(Object.keys(CLIENT_TO_SERVER_EVENTS)).toEqual(["typing", "presence.watch", "presence.heartbeat"]);
  });
  it("each payload schema accepts its shape and rejects a wrong one", () => {
    expect(syncNudgeEventSchema.safeParse({}).success).toBe(true);
    expect(syncNudgeEventSchema.safeParse({ conversationId: UUID_V7 }).success).toBe(true);
    expect(syncNudgeEventSchema.safeParse({ conversationId: 5 }).success).toBe(false);
    expect(instanceApprovedEventSchema.safeParse({ instanceId: UUID_V7 }).success).toBe(true);
    expect(instanceApprovedEventSchema.safeParse({}).success).toBe(false);
    expect(instanceRevokedEventSchema.safeParse({ instanceId: UUID_V7 }).success).toBe(true);
    expect(instanceRevokedEventSchema.safeParse({ instanceId: "" }).success).toBe(false);
    expect(keyPackagesLowEventSchema.safeParse({ available: 2 }).success).toBe(true);
    expect(keyPackagesLowEventSchema.safeParse({ available: "2" }).success).toBe(false);
    expect(typingEventSchema.safeParse({ conversationId: UUID_V7, ciphertext: B64 }).success).toBe(true);
    expect(typingEventSchema.safeParse({ conversationId: UUID_V7, on: true }).success).toBe(false);
    expect(presenceEventSchema.safeParse({ accountId: OBJECT_ID, online: true, lastSeenAt: null }).success).toBe(true);
    expect(presenceEventSchema.safeParse({ accountId: OBJECT_ID, online: "yes", lastSeenAt: null }).success).toBe(false);
    // The last seen is required, because absent and "not telling you" must not
    // be the same value on the wire.
    expect(presenceEventSchema.safeParse({ accountId: OBJECT_ID, online: false }).success).toBe(false);
    expect(historyOfferEventSchema.safeParse({ offerId: UUID_V7 }).success).toBe(true);
    expect(historyOfferEventSchema.safeParse({ offerId: 7 }).success).toBe(false);
    expect(historyOfferEventSchema.safeParse({}).success).toBe(false);
  });
  it("the handler map types line up with the schemas", () => {
    const handlers: ServerToClientEvents = {
      "sync.nudge": (p) => void p.conversationId,
      "instance.approved": (p) => void p.instanceId,
      "instance.revoked": (p) => void p.instanceId,
      "keypackages.low": (p) => void p.available.toFixed(),
      typing: (p) => void p.ciphertext,
      presence: (p) => void p.online,
      "history.offer": (p) => void p.offerId,
      "status.posted": (p) => void p.statusId,
      "call.incoming": (p) => void p.callId,
      "call.updated": (p) => void p.state,
    };
    // The map is EXHAUSTIVE by type: leaving one out is a tsc failure, which
    // is the point of the assertion rather than the count beside it.
    expect(Object.keys(handlers)).toHaveLength(Object.keys(SERVER_TO_CLIENT_EVENTS).length);
  });
});
