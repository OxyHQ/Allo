/**
 * Calls: the state machine, and nothing about the media.
 *
 * The server holds what it cannot do without — a call and a row per rung
 * device — because forking a ring across somebody's phones, deciding which one
 * won, cancelling the others and noticing that nobody answered are all things
 * only it can do. WhatsApp's whitepaper says the same about its own server.
 * Everything else about a call (the offer, the candidates, the keys, the
 * conversation it is about beyond its id) travels encrypted and is not here.
 *
 * What a PERSON sees afterwards is not here either: the call log is an
 * encrypted `call_log` message in the conversation, written when the call
 * ends, so it reaches every device of both accounts the way any other message
 * does. These rows are operational, and the sweep takes them after a day.
 *
 * No foreign key on `conversation_id`: a call is about a conversation, and a
 * conversation being deleted is not a reason to lose the record that somebody
 * rang.
 */

import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { boolean } from "drizzle-orm/pg-core";
import { createdAt, timestamptz } from "@oxy.so/db";
import { CALL_END_REASONS, CALL_MODES, CALL_STATES } from "@allo/shared-types";
import { checkOneOf } from "./columns";

export const CALL_PARTICIPANT_STATES = ["ringing", "joined", "left", "declined", "missed"] as const;
export type CallParticipantState = (typeof CALL_PARTICIPANT_STATES)[number];

export const calls = pgTable(
  "calls",
  {
    id: text().primaryKey(),
    conversationId: text().notNull(),
    initiatorAccountId: text().notNull(),
    initiatorInstanceId: text().notNull(),
    mode: text({ enum: CALL_MODES }).notNull(),
    state: text({ enum: CALL_STATES }).notNull().default("ringing"),
    /**
     * Whether the media must go through the relay. True for a group, and for a
     * 1:1 where EITHER side hides its address — a connection cannot be half
     * relayed. Who asked is deliberately not stored: it would turn a privacy
     * setting into a record of who is cautious.
     */
    relayed: boolean().notNull().default(false),
    group: boolean().notNull().default(false),
    /** The caller's idempotency key, so a retried ring is the same call. */
    idempotencyKey: text().notNull(),
    startedAt: createdAt(),
    answeredAt: timestamptz(),
    endedAt: timestamptz(),
    endReason: text({ enum: CALL_END_REASONS }),
    /** When the ring gives up. Null once it is answered or over; the sweeper reads it. */
    ringExpiresAt: timestamptz(),
    /** A day after it ended. Operational, not a log. */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    uniqueIndex("calls_initiator_instance_idempotency_key").on(t.initiatorInstanceId, t.idempotencyKey),
    // The ring sweeper's query: still ringing, and past its deadline.
    index("calls_state_ring_expires_at_idx").on(t.state, t.ringExpiresAt),
    index("calls_conversation_id_started_at_idx").on(t.conversationId, t.startedAt),
    index("calls_expires_at_idx").on(t.expiresAt),
    checkOneOf("calls_mode_check", t.mode, CALL_MODES),
    checkOneOf("calls_state_check", t.state, CALL_STATES),
    checkOneOf("calls_end_reason_check", t.endReason, CALL_END_REASONS),
  ],
);

/**
 * One rung device.
 *
 * A row per INSTANCE, not per account, because the ring is forked to every
 * device and exactly one of them wins. `state` is what the losers are told
 * about: `answered_elsewhere` on their own row is why their ring stops.
 */
export const callParticipants = pgTable(
  "call_participants",
  {
    id: text().primaryKey(),
    callId: text()
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    accountId: text().notNull(),
    instanceId: text().notNull(),
    state: text({ enum: CALL_PARTICIPANT_STATES }).notNull().default("ringing"),
    joinedAt: timestamptz(),
    leftAt: timestamptz(),
    createdAt: createdAt(),
    /** The call's own deadline, copied so the sweep reaps without a join. */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    uniqueIndex("call_participants_call_id_instance_id_key").on(t.callId, t.instanceId),
    index("call_participants_instance_id_state_idx").on(t.instanceId, t.state),
    index("call_participants_expires_at_idx").on(t.expiresAt),
    checkOneOf("call_participants_state_check", t.state, CALL_PARTICIPANT_STATES),
  ],
);
