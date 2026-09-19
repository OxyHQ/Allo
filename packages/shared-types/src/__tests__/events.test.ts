import { describe, expect, it } from "vitest";
import {
  COMMIT_KINDS,
  commitInfoSchema,
  commitKindSchema,
  controlEventSchema,
  conversationEventSchema,
  GROUP_INFO_MAX_BASE64,
  GROUP_INFO_MAX_BYTES,
  listEventsQuerySchema,
  listEventsResponseSchema,
  MAX_EVENT_PAYLOAD_BASE64_LENGTH,
  SERVER_SENDER_ID,
  submitEventRequestSchema,
  submitEventResponseSchema,
  type ConversationEvent,
  type SubmitEventRequest,
  type SubmitEventRequestInput,
} from "../events";
import { B64, GROUP_INFO, ISO, OBJECT_ID, OBJECT_ID_2, UUID_V7 } from "./fixtures";

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
  const commit: SubmitEventRequestInput = {
    idempotencyKey: "c1",
    kind: "mls_commit",
    epoch: 4,
    payload: B64,
    commit: {
      newEpoch: 5,
      addedLeaves: [{ instanceId: UUID_V7, accountId: OBJECT_ID_2 }],
      removedLeaves: [],
      welcome: { payload: B64, recipients: [UUID_V7] },
      groupInfo: GROUP_INFO,
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
  it("rejects a commit without groupInfo, or with one that is not base64 or over the bound", () => {
    const { groupInfo: _omit, ...withoutGroupInfo } = commit.commit!;
    const result = submitEventRequestSchema.safeParse({ ...commit, commit: withoutGroupInfo });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.path.join("."))).toContain("commit.groupInfo");
    expect(commitInfoSchema.safeParse(withoutGroupInfo).success).toBe(false);
    expect(commitInfoSchema.safeParse({ ...commit.commit, groupInfo: "" }).success).toBe(false);
    expect(commitInfoSchema.safeParse({ ...commit.commit, groupInfo: "not base64!" }).success).toBe(false);
    expect(commitInfoSchema.safeParse({ ...commit.commit, groupInfo: "A".repeat(GROUP_INFO_MAX_BASE64) }).success).toBe(true);
    expect(commitInfoSchema.safeParse({ ...commit.commit, groupInfo: "A".repeat(GROUP_INFO_MAX_BASE64 + 4) }).success).toBe(false);
  });
  it("the group info bound is 256 KiB of bytes, expressed in encoded characters", () => {
    expect(GROUP_INFO_MAX_BYTES).toBe(256 * 1024);
    expect(GROUP_INFO_MAX_BASE64).toBe(Math.ceil(GROUP_INFO_MAX_BYTES / 3) * 4);
    expect(Buffer.alloc(GROUP_INFO_MAX_BYTES).toString("base64")).toHaveLength(GROUP_INFO_MAX_BASE64);
  });
});

describe("commit kinds", () => {
  const self = { instanceId: UUID_V7, accountId: OBJECT_ID };
  const base = { idempotencyKey: "c1", kind: "mls_commit", epoch: 4, payload: B64 } as const;
  const external = {
    ...base,
    commit: { newEpoch: 5, kind: "external", addedLeaves: [self], removedLeaves: [], groupInfo: GROUP_INFO },
  } as const;
  const resync = {
    ...base,
    commit: { newEpoch: 5, kind: "resync", addedLeaves: [self], removedLeaves: [UUID_V7], groupInfo: GROUP_INFO },
  } as const;
  const paths = (input: unknown) => {
    const r = submitEventRequestSchema.safeParse(input);
    return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
  };

  it("the closed set is member, external, resync; an unknown kind is refused", () => {
    expect(COMMIT_KINDS).toEqual(["member", "external", "resync"]);
    expect(commitKindSchema.safeParse("welcome").success).toBe(false);
    expect(paths({ ...external, commit: { ...external.commit, kind: "rejoin" } })).toContain("commit.kind");
  });
  it("kind defaults to member, and a member commit keeps today's freedom of shape", () => {
    const parsed = commitInfoSchema.parse({ newEpoch: 5, addedLeaves: [], removedLeaves: [], groupInfo: GROUP_INFO });
    expect(parsed.kind).toBe("member");
    const viaRequest = submitEventRequestSchema.parse({
      ...base,
      commit: { newEpoch: 5, addedLeaves: [self, { instanceId: OBJECT_ID_2, accountId: OBJECT_ID_2 }], removedLeaves: [OBJECT_ID_2], groupInfo: GROUP_INFO },
    });
    expect(viaRequest.commit?.kind).toBe("member");
    expect(
      submitEventRequestSchema.safeParse({
        ...base,
        commit: { newEpoch: 5, kind: "member", addedLeaves: [], removedLeaves: [], welcome: { payload: B64, recipients: [UUID_V7] }, groupInfo: GROUP_INFO },
      }).success,
    ).toBe(true);
  });
  it("accepts an external commit: exactly one added leaf, no removed leaf, no welcome", () => {
    expect(submitEventRequestSchema.safeParse(external).success).toBe(true);
    expect(submitEventRequestSchema.parse(external).commit?.kind).toBe("external");
  });
  it("refuses an external commit with two added leaves, or none", () => {
    expect(paths({ ...external, commit: { ...external.commit, addedLeaves: [self, { instanceId: OBJECT_ID_2, accountId: OBJECT_ID }] } })).toContain(
      "commit.addedLeaves",
    );
    expect(paths({ ...external, commit: { ...external.commit, addedLeaves: [] } })).toContain("commit.addedLeaves");
  });
  it("refuses an external commit with a welcome", () => {
    expect(paths({ ...external, commit: { ...external.commit, welcome: { payload: B64, recipients: [UUID_V7] } } })).toContain("commit.welcome");
  });
  it("refuses an external commit that removes a leaf", () => {
    expect(paths({ ...external, commit: { ...external.commit, removedLeaves: [UUID_V7] } })).toContain("commit.removedLeaves");
  });
  it("accepts a resync commit: exactly one added and exactly one removed leaf, no welcome", () => {
    expect(submitEventRequestSchema.safeParse(resync).success).toBe(true);
    expect(submitEventRequestSchema.parse(resync).commit?.kind).toBe("resync");
  });
  it("refuses a resync commit without a removed leaf, with two, with two added leaves, or with a welcome", () => {
    expect(paths({ ...resync, commit: { ...resync.commit, removedLeaves: [] } })).toContain("commit.removedLeaves");
    expect(paths({ ...resync, commit: { ...resync.commit, removedLeaves: [UUID_V7, OBJECT_ID_2] } })).toContain("commit.removedLeaves");
    expect(paths({ ...resync, commit: { ...resync.commit, addedLeaves: [self, self] } })).toContain("commit.addedLeaves");
    expect(paths({ ...resync, commit: { ...resync.commit, welcome: { payload: B64, recipients: [UUID_V7] } } })).toContain("commit.welcome");
  });
  it("an external or resync commit still needs groupInfo and the epoch step", () => {
    const { groupInfo: _omit, ...bare } = external.commit;
    expect(paths({ ...external, commit: bare })).toContain("commit.groupInfo");
    expect(paths({ ...external, commit: { ...external.commit, newEpoch: 6 } })).toContain("commit.newEpoch");
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
