import { describe, expect, it } from "vitest";
import {
  commitInfoSchema,
  controlEventSchema,
  conversationEventSchema,
  listEventsQuerySchema,
  listEventsResponseSchema,
  MAX_EVENT_PAYLOAD_BASE64_LENGTH,
  SERVER_SENDER_ID,
  submitEventRequestSchema,
  submitEventResponseSchema,
  type ConversationEvent,
  type SubmitEventRequest,
} from "../events";
import { B64, ISO, OBJECT_ID, OBJECT_ID_2, UUID_V7 } from "./fixtures";

const event: ConversationEvent = {
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
};

describe("conversationEventSchema", () => {
  it("accepts a client event and a server control event", () => {
    expect(conversationEventSchema.safeParse(event).success).toBe(true);
    expect(
      conversationEventSchema.safeParse({ ...event, kind: "control", senderAccountId: SERVER_SENDER_ID, senderInstanceId: null }).success,
    ).toBe(true);
  });
  it("rejects an unknown kind, a colon-bearing account id that is not the server, and 17 blob ids", () => {
    expect(conversationEventSchema.safeParse({ ...event, kind: "sticker" }).success).toBe(false);
    expect(conversationEventSchema.safeParse({ ...event, senderAccountId: "allo:other" }).success).toBe(false);
    expect(conversationEventSchema.safeParse({ ...event, blobIds: Array(17).fill(UUID_V7) }).success).toBe(false);
    const { blobIds: _omit, ...missing } = event;
    expect(conversationEventSchema.safeParse(missing).success).toBe(false);
  });
});

describe("controlEventSchema", () => {
  it("accepts the three control shapes", () => {
    expect(controlEventSchema.safeParse({ t: "instance_revoked", instanceId: UUID_V7, accountId: OBJECT_ID }).success).toBe(true);
    expect(controlEventSchema.safeParse({ t: "member_left", accountId: OBJECT_ID }).success).toBe(true);
    expect(controlEventSchema.safeParse({ t: "conversation_created" }).success).toBe(true);
  });
  it("rejects an unknown t and a revoked without an instance", () => {
    expect(controlEventSchema.safeParse({ t: "renamed" }).success).toBe(false);
    expect(controlEventSchema.safeParse({ t: "instance_revoked", accountId: OBJECT_ID }).success).toBe(false);
  });
});

describe("submitEventRequestSchema", () => {
  const message: SubmitEventRequest = { idempotencyKey: "m1", kind: "app_message", epoch: 4, payload: B64 };
  const commit: SubmitEventRequest = {
    idempotencyKey: "c1",
    kind: "mls_commit",
    epoch: 4,
    payload: B64,
    commit: {
      newEpoch: 5,
      addedLeaves: [{ instanceId: UUID_V7, accountId: OBJECT_ID_2 }],
      removedLeaves: [],
      welcome: { payload: B64, recipients: [UUID_V7] },
    },
  };
  it("accepts an app_message, a proposal and a commit with info", () => {
    expect(submitEventRequestSchema.safeParse(message).success).toBe(true);
    expect(submitEventRequestSchema.safeParse({ ...message, kind: "mls_proposal" }).success).toBe(true);
    expect(submitEventRequestSchema.safeParse(commit).success).toBe(true);
    expect(submitEventRequestSchema.safeParse({ ...message, blobIds: [UUID_V7] }).success).toBe(true);
  });
  it("rejects a commit without commit info", () => {
    const { commit: _omit, ...bare } = commit;
    const result = submitEventRequestSchema.safeParse(bare);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.path.join("."))).toContain("commit");
  });
  it("rejects commit info on an app_message and on a proposal", () => {
    expect(submitEventRequestSchema.safeParse({ ...message, commit: commit.commit }).success).toBe(false);
    expect(submitEventRequestSchema.safeParse({ ...message, kind: "mls_proposal", commit: commit.commit }).success).toBe(false);
  });
  it("rejects a commit that does not advance the epoch by exactly one", () => {
    expect(submitEventRequestSchema.safeParse({ ...commit, commit: { ...commit.commit!, newEpoch: 4 } }).success).toBe(false);
    expect(submitEventRequestSchema.safeParse({ ...commit, commit: { ...commit.commit!, newEpoch: 6 } }).success).toBe(false);
  });
  it("rejects kinds a client may not submit, an over-long payload and 17 blob ids", () => {
    expect(submitEventRequestSchema.safeParse({ ...message, kind: "control" }).success).toBe(false);
    expect(submitEventRequestSchema.safeParse({ ...message, kind: "mls_welcome" }).success).toBe(false);
    expect(submitEventRequestSchema.safeParse({ ...message, payload: "A".repeat(MAX_EVENT_PAYLOAD_BASE64_LENGTH + 4) }).success).toBe(false);
    expect(submitEventRequestSchema.safeParse({ ...message, blobIds: Array(17).fill(UUID_V7) }).success).toBe(false);
  });
  it("a welcome needs at least one recipient", () => {
    expect(commitInfoSchema.safeParse({ ...commit.commit, welcome: { payload: B64, recipients: [] } }).success).toBe(false);
  });
});

describe("responses and query", () => {
  it("submit response carries id, seq, createdAt", () => {
    expect(submitEventResponseSchema.safeParse({ event: { id: UUID_V7, seq: 9, createdAt: ISO } }).success).toBe(true);
    expect(submitEventResponseSchema.safeParse({ event: { id: UUID_V7, seq: "9", createdAt: ISO } }).success).toBe(false);
  });
  it("list response", () => {
    expect(listEventsResponseSchema.safeParse({ events: [event], hasMore: false }).success).toBe(true);
    expect(listEventsResponseSchema.safeParse({ events: [event] }).success).toBe(false);
  });
  it("query coerces strings and defaults", () => {
    expect(listEventsQuerySchema.parse({})).toEqual({ after: 0, limit: 100 });
    expect(listEventsQuerySchema.parse({ after: "12", limit: "5" })).toEqual({ after: 12, limit: 5 });
    expect(listEventsQuerySchema.safeParse({ after: "-1" }).success).toBe(false);
    expect(listEventsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listEventsQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
  });
});
