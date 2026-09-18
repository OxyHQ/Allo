/**
 * Conversation events: the append-only, per-conversation log the server
 * keeps. Every `payload` is opaque to the server except `control`, which the
 * server itself writes.
 */
import { z } from "zod";
import {
  accountIdSchema,
  base64Schema,
  blobIdSchema,
  conversationIdSchema,
  eventIdSchema,
  idempotencyKeySchema,
  instanceIdSchema,
  isoDateSchema,
  nonNegativeIntSchema,
} from "./common";

export const EVENT_KINDS = ["mls_commit", "mls_proposal", "mls_welcome", "app_message", "control"] as const;
export const eventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof eventKindSchema>;

/** The kinds a client may submit. `mls_welcome` rides inside a commit; `control` is the server's. */
export const SUBMITTABLE_EVENT_KINDS = ["mls_commit", "mls_proposal", "app_message"] as const;
export const submittableEventKindSchema = z.enum(SUBMITTABLE_EVENT_KINDS);
export type SubmittableEventKind = z.infer<typeof submittableEventKindSchema>;

/** `senderAccountId` of a `control` event. Not a real account id, on purpose. */
export const SERVER_SENDER_ID = "allo:server";
export const senderAccountIdSchema = z.union([accountIdSchema, z.literal(SERVER_SENDER_ID)]);

/** Bound on the base64-ENCODED payload: 1 MiB of text. */
export const MAX_EVENT_PAYLOAD_BASE64_LENGTH = 1024 * 1024;
export const eventPayloadSchema = base64Schema(MAX_EVENT_PAYLOAD_BASE64_LENGTH);

export const MAX_BLOB_REFS_PER_EVENT = 16;

/** The JSON inside a `control` event's payload (base64 of the UTF-8 JSON). */
export const controlEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("instance_revoked"), instanceId: instanceIdSchema, accountId: accountIdSchema }),
  z.object({ t: z.literal("member_left"), accountId: accountIdSchema }),
  z.object({ t: z.literal("conversation_created") }),
]);
export type ControlEvent = z.infer<typeof controlEventSchema>;

export const conversationEventSchema = z.object({
  id: eventIdSchema,
  conversationId: conversationIdSchema,
  /** Dense per-conversation sequence, from 1. A gap means something to fetch. */
  seq: nonNegativeIntSchema,
  kind: eventKindSchema,
  /** The MLS epoch the payload belongs to (a commit's is the epoch it LEAVES). */
  epoch: nonNegativeIntSchema,
  senderAccountId: senderAccountIdSchema,
  /** `null` for `control` events. */
  senderInstanceId: instanceIdSchema.nullable(),
  /** base64: MLS ciphertext, or the UTF-8 JSON of a {@link ControlEvent}. */
  payload: eventPayloadSchema,
  /** Blobs the sender declared, so the collector keeps them. Never interpreted. */
  blobIds: z.array(blobIdSchema).max(MAX_BLOB_REFS_PER_EVENT),
  createdAt: isoDateSchema,
});
export type ConversationEvent = z.infer<typeof conversationEventSchema>;

export const addedLeafSchema = z.object({
  instanceId: instanceIdSchema,
  accountId: accountIdSchema,
});
export type AddedLeaf = z.infer<typeof addedLeafSchema>;

export const welcomeSchema = z.object({
  payload: eventPayloadSchema,
  /** The instances the welcome is for — the added leaves. Delivered to nobody else. */
  recipients: z.array(instanceIdSchema).min(1),
});
export type Welcome = z.infer<typeof welcomeSchema>;

/**
 * How a commit was authored, which decides which server rules apply.
 *
 * - `member`: a member with an active leaf committed (adds, removes, updates).
 *   The default, and everything before this field existed.
 * - `external`: an MLS external commit — a device that is a member with no
 *   active leaf joined itself from the stored {@link CommitInfo.groupInfo}.
 *   `addedLeaves` is exactly the sender, `removedLeaves` is empty and there is
 *   no `welcome` (the sender already holds the new state).
 * - `resync`: an external commit by a device that already holds a leaf and lost
 *   its group state. `addedLeaves` is exactly the sender and `removedLeaves` is
 *   exactly the sender's former leaf: the server REPLACES the leaf row instead
 *   of refusing "already holds an active leaf".
 *
 * The schema enforces the shapes; that the leaves ARE the sender is checked
 * by the server, which alone knows who signed the request.
 */
export const COMMIT_KINDS = ["member", "external", "resync"] as const;
export const commitKindSchema = z.enum(COMMIT_KINDS);
export type CommitKind = z.infer<typeof commitKindSchema>;

/**
 * Bound on a serialized `GroupInfo` (with `external_pub` and `ratchet_tree`):
 * 256 KiB of bytes, which is ~342 KB encoded. Measured 0.7–11 KB in the spike.
 */
export const GROUP_INFO_MAX_BYTES = 256 * 1024;
/** The base64-ENCODED bound of {@link GROUP_INFO_MAX_BYTES}. */
export const GROUP_INFO_MAX_BASE64 = Math.ceil(GROUP_INFO_MAX_BYTES / 3) * 4;
export const groupInfoDataSchema = base64Schema(GROUP_INFO_MAX_BASE64);

/** What the server must know about a commit it cannot read. */
export const commitInfoSchema = z.object({
  newEpoch: nonNegativeIntSchema,
  kind: commitKindSchema.default("member"),
  addedLeaves: z.array(addedLeafSchema),
  /** Instance ids. */
  removedLeaves: z.array(instanceIdSchema),
  welcome: welcomeSchema.optional(),
  /**
   * The `GroupInfo` of `newEpoch` (with `external_pub` and `ratchet_tree`),
   * base64. REQUIRED: the server stores it so a device that is a member with
   * no active leaf can join by external commit without anybody else online.
   */
  groupInfo: groupInfoDataSchema,
});
export type CommitInfo = z.infer<typeof commitInfoSchema>;
/** The wire shape of {@link commitInfoSchema} before defaults are applied (`kind` may be omitted). */
export type CommitInfoInput = z.input<typeof commitInfoSchema>;

/**
 * The shape rules each {@link CommitKind} imposes, shared by the event route
 * and the initial commit of a new conversation. `member` imposes none.
 */
function checkCommitKindShape(commit: CommitInfo, ctx: z.RefinementCtx): void {
  if (commit.kind === "member") return;
  if (commit.addedLeaves.length !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["commit", "addedLeaves"],
      message: `a ${commit.kind} commit adds exactly one leaf: the sender's`,
    });
  }
  if (commit.welcome !== undefined) {
    ctx.addIssue({ code: "custom", path: ["commit", "welcome"], message: `a ${commit.kind} commit carries no welcome` });
  }
  if (commit.kind === "external" && commit.removedLeaves.length !== 0) {
    ctx.addIssue({ code: "custom", path: ["commit", "removedLeaves"], message: "an external commit removes no leaf" });
  }
  if (commit.kind === "resync" && commit.removedLeaves.length !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["commit", "removedLeaves"],
      message: "a resync commit removes exactly one leaf: the sender's former one",
    });
  }
}

/** `POST /v1/conversations/:id/events` */
export const submitEventRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    kind: submittableEventKindSchema,
    /** Must equal the conversation's current epoch, or the answer is `epoch_conflict`. */
    epoch: nonNegativeIntSchema,
    payload: eventPayloadSchema,
    /** Required for `mls_commit`, forbidden otherwise. */
    commit: commitInfoSchema.optional(),
    blobIds: z.array(blobIdSchema).max(MAX_BLOB_REFS_PER_EVENT).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "mls_commit") {
      if (v.commit === undefined) {
        ctx.addIssue({ code: "custom", path: ["commit"], message: "an mls_commit carries commit info" });
      } else {
        if (v.commit.newEpoch !== v.epoch + 1) {
          ctx.addIssue({ code: "custom", path: ["commit", "newEpoch"], message: "a commit advances the epoch by exactly one" });
        }
        checkCommitKindShape(v.commit, ctx);
      }
    } else if (v.commit !== undefined) {
      ctx.addIssue({ code: "custom", path: ["commit"], message: `a ${v.kind} carries no commit info` });
    }
  });
export type SubmitEventRequest = z.infer<typeof submitEventRequestSchema>;
/** What a client builds and sends: {@link SubmitEventRequest} before defaults (`commit.kind` may be omitted). */
export type SubmitEventRequestInput = z.input<typeof submitEventRequestSchema>;

export const submitEventResponseSchema = z.object({
  event: z.object({
    id: eventIdSchema,
    seq: nonNegativeIntSchema,
    createdAt: isoDateSchema,
  }),
});
export type SubmitEventResponse = z.infer<typeof submitEventResponseSchema>;

export const MAX_EVENTS_PAGE = 200;

/** `GET /v1/conversations/:id/events?after=&limit=` — query, coerced from strings. */
export const listEventsQuerySchema = z.object({
  /** Return events with `seq > after`. Default 0: from the beginning. */
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_EVENTS_PAGE).default(100),
});
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;

export const listEventsResponseSchema = z.object({
  events: z.array(conversationEventSchema),
  hasMore: z.boolean(),
});
export type ListEventsResponse = z.infer<typeof listEventsResponseSchema>;
