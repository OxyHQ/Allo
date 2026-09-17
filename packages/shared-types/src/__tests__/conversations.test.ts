import { describe, expect, it } from "vitest";
import {
  conversationSummarySchema,
  createConversationRequestSchema,
  createConversationResponseSchema,
  dmKeyFor,
  listConversationsResponseSchema,
  MAX_GROUP_MEMBERS,
  type ConversationSummary,
} from "../conversations";
import { B64, ISO, OBJECT_ID, OBJECT_ID_2, UUID_V7 } from "./fixtures";

const summary: ConversationSummary = {
  id: UUID_V7,
  kind: "dm",
  appId: "allo",
  mlsGroupId: B64,
  epoch: 3,
  lastSeq: 42,
  members: [
    { accountId: OBJECT_ID, role: "owner", state: "joined", joinedAt: ISO },
    { accountId: OBJECT_ID_2, role: "member", state: "joined", joinedAt: ISO },
  ],
  leaves: [{ instanceId: UUID_V7, accountId: OBJECT_ID, state: "active", addedEpoch: 0 }],
  myLeafState: "active",
  createdByAccountId: OBJECT_ID,
  createdAt: ISO,
};

describe("conversationSummarySchema", () => {
  it("accepts a summary, with a null myLeafState too", () => {
    expect(conversationSummarySchema.safeParse(summary).success).toBe(true);
    expect(conversationSummarySchema.safeParse({ ...summary, myLeafState: null }).success).toBe(true);
  });
  it("rejects a bad role, a bad leaf state, a missing myLeafState and a negative epoch", () => {
    expect(conversationSummarySchema.safeParse({ ...summary, members: [{ ...summary.members[0], role: "god" }] }).success).toBe(false);
    expect(conversationSummarySchema.safeParse({ ...summary, leaves: [{ ...summary.leaves[0], state: "gone" }] }).success).toBe(false);
    const { myLeafState: _omit, ...missing } = summary;
    expect(conversationSummarySchema.safeParse(missing).success).toBe(false);
    expect(conversationSummarySchema.safeParse({ ...summary, epoch: -1 }).success).toBe(false);
  });
  it("list and create responses wrap it", () => {
    expect(listConversationsResponseSchema.safeParse({ conversations: [summary] }).success).toBe(true);
    expect(createConversationResponseSchema.safeParse({ conversation: summary, created: false }).success).toBe(true);
    expect(createConversationResponseSchema.safeParse({ conversation: summary }).success).toBe(false);
  });
});

describe("createConversationRequestSchema", () => {
  const base = { mlsGroupId: B64, idempotencyKey: "k1" };
  const commit = {
    idempotencyKey: "c1",
    kind: "mls_commit",
    epoch: 0,
    payload: B64,
    commit: { newEpoch: 1, addedLeaves: [{ instanceId: UUID_V7, accountId: OBJECT_ID_2 }], removedLeaves: [] },
  };
  it("a dm names exactly one other account; a group 0..255", () => {
    expect(createConversationRequestSchema.safeParse({ ...base, kind: "dm", memberAccountIds: [OBJECT_ID_2] }).success).toBe(true);
    expect(createConversationRequestSchema.safeParse({ ...base, kind: "group", memberAccountIds: [] }).success).toBe(true);
    const many = Array.from({ length: MAX_GROUP_MEMBERS }, (_, i) => `member-${String(i).padStart(4, "0")}`);
    expect(createConversationRequestSchema.safeParse({ ...base, kind: "group", memberAccountIds: many }).success).toBe(true);
  });
  it("rejects a dm with zero or two others, a 256-member group and a duplicate", () => {
    expect(createConversationRequestSchema.safeParse({ ...base, kind: "dm", memberAccountIds: [] }).success).toBe(false);
    expect(createConversationRequestSchema.safeParse({ ...base, kind: "dm", memberAccountIds: [OBJECT_ID, OBJECT_ID_2] }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_GROUP_MEMBERS + 1 }, (_, i) => `member-${String(i).padStart(4, "0")}`);
    expect(createConversationRequestSchema.safeParse({ ...base, kind: "group", memberAccountIds: tooMany }).success).toBe(false);
    expect(createConversationRequestSchema.safeParse({ ...base, kind: "group", memberAccountIds: [OBJECT_ID, OBJECT_ID] }).success).toBe(false);
  });
  it("accepts an initial commit at epoch 0 and rejects one at epoch 1 or of another kind", () => {
    const dm = { ...base, kind: "dm", memberAccountIds: [OBJECT_ID_2] };
    expect(createConversationRequestSchema.safeParse({ ...dm, initialCommit: commit }).success).toBe(true);
    expect(
      createConversationRequestSchema.safeParse({ ...dm, initialCommit: { ...commit, epoch: 1, commit: { ...commit.commit, newEpoch: 2 } } })
        .success,
    ).toBe(false);
    expect(
      createConversationRequestSchema.safeParse({ ...dm, initialCommit: { idempotencyKey: "c1", kind: "app_message", epoch: 0, payload: B64 } })
        .success,
    ).toBe(false);
  });
  it("rejects a missing idempotency key", () => {
    expect(createConversationRequestSchema.safeParse({ kind: "dm", mlsGroupId: B64, memberAccountIds: [OBJECT_ID_2] }).success).toBe(false);
  });
});

describe("dmKeyFor", () => {
  it("is order-independent and prefixed by the app", () => {
    expect(dmKeyFor("allo", "bbb", "aaa")).toBe("allo:aaa:bbb");
    expect(dmKeyFor("allo", "aaa", "bbb")).toBe(dmKeyFor("allo", "bbb", "aaa"));
    expect(dmKeyFor("mention", "aaa", "bbb")).not.toBe(dmKeyFor("allo", "aaa", "bbb"));
  });
  it("refuses a self-dm", () => {
    expect(() => dmKeyFor("allo", "aaa", "aaa")).toThrow(RangeError);
  });
});
