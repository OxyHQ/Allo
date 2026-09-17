/**
 * Event submission and reads (`docs/platform/api-v1.md`, Events and Sync).
 *
 * The transaction is `appendClientEvent`'s; this layer opens it, and once it
 * has COMMITTED nudges the recipients over the socket. The nudge is the fast
 * path and may be lost; the delivery rows the transaction wrote are the durable
 * one, and the delivery worker walks them.
 */

import {
  decodeCursor,
  encodeCursor,
  INITIAL_CURSOR,
  type ConversationEvent,
  type SubmitEventRequest,
  type SubmitEventResponse,
  type SyncResponse,
} from "@allo/shared-types";
import { getDb, type AlloDatabase } from "../../db";
import { findMember } from "../../db/platform/conversationRepository";
import { ackDeliveries, readSyncStream } from "../../db/platform/deliveryRepository";
import { appendClientEvent, listEvents } from "../../db/platform/eventRepository";
import { getRealtime } from "../../runtime/realtime";
import { notFound, validationFailed } from "../../utils/httpErrors";
import { toConversationEvent } from "./wire";
import type { Caller } from "./conversationService";

export async function submitEvent(
  caller: Caller,
  conversationId: string,
  request: SubmitEventRequest,
  deps: { db?: AlloDatabase } = {},
): Promise<SubmitEventResponse> {
  const db = deps.db ?? getDb();
  const appended = await db.transaction((tx) =>
    appendClientEvent({ conversationId, sender: { instanceId: caller.instanceId, accountId: caller.accountId }, request }, tx),
  );
  if (appended.recipients.length > 0) getRealtime().nudge(appended.recipients, { conversationId });
  return { event: { id: appended.event.id, seq: appended.event.seq, createdAt: appended.event.createdAt.toISOString() } };
}

export async function listConversationEvents(
  caller: Caller,
  conversationId: string,
  query: { after: number; limit: number },
  deps: { db?: AlloDatabase } = {},
): Promise<{ events: ConversationEvent[]; hasMore: boolean }> {
  const db = deps.db ?? getDb();
  const member = await findMember(conversationId, caller.accountId, db);
  if (!member) throw notFound("Conversation not found");
  const page = await listEvents(conversationId, query.after, query.limit, db);
  return { events: page.events.map(toConversationEvent), hasMore: page.hasMore };
}

/** A cursor is an opaque base64url integer; anything else is a 400, not a 500. */
function positionOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const n = decodeCursor(cursor);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("cursor out of range");
    return Number(n);
  } catch {
    throw validationFailed("malformed cursor", { path: ["cursor"] });
  }
}

export async function readSync(
  caller: Caller,
  query: { cursor?: string; limit: number },
  deps: { db?: AlloDatabase } = {},
): Promise<SyncResponse> {
  const db = deps.db ?? getDb();
  const after = positionOf(query.cursor);
  const page = await readSyncStream(caller.instanceId, after, query.limit, db);
  const deliveries = page.entries.map((entry) => ({
    cursor: encodeCursor(entry.deliveryId),
    conversationId: entry.conversationId,
    event: toConversationEvent(entry.event),
  }));
  const last = deliveries[deliveries.length - 1];
  return {
    deliveries,
    nextCursor: last ? last.cursor : (query.cursor ?? INITIAL_CURSOR),
    hasMore: page.hasMore,
  };
}

export async function ackSync(caller: Caller, cursor: string, deps: { db?: AlloDatabase } = {}): Promise<void> {
  await ackDeliveries(caller.instanceId, positionOf(cursor), deps.db ?? getDb());
}
