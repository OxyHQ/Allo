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

/** What the server must know about a commit it cannot read. */
export const commitInfoSchema = z.object({
  newEpoch: nonNegativeIntSchema,
  addedLeaves: z.array(addedLeafSchema),
  /** Instance ids. */
  removedLeaves: z.array(instanceIdSchema),
  welcome: welcomeSchema.optional(),
});
export type CommitInfo = z.infer<typeof commitInfoSchema>;

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
      } else if (v.commit.newEpoch !== v.epoch + 1) {
        ctx.addIssue({ code: "custom", path: ["commit", "newEpoch"], message: "a commit advances the epoch by exactly one" });
      }
    } else if (v.commit !== undefined) {
      ctx.addIssue({ code: "custom", path: ["commit"], message: `a ${v.kind} carries no commit info` });
    }
  });
export type SubmitEventRequest = z.infer<typeof submitEventRequestSchema>;

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
