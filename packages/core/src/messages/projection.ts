/**
 * The timeline projection: stored events (server order) plus pending outbox
 * items (local echoes), folded so edits, deletes, reactions, read and
 * delivery receipts land on the items they target. Pure: no I/O, no clocks.
 * An own item is `read` when another account's `read` covers it, else
 * `delivered` when another account's `delivered` does; a receipt from an own
 * instance moves nothing, and `read` is never downgraded.
 */
import type { AppMessage, EventRef } from "@allo/shared-types";
import type { EventRecord, OutboxItemRecord } from "../storage/records";
import type { MediaView, TimelineItemView } from "../types";

export interface ProjectionInput {
  conversationId: string;
  events: EventRecord[];
  outbox: OutboxItemRecord[];
  accountId: string;
  instanceId: string;
}

interface Working {
  item: TimelineItemView;
  reactions: Map<string, Set<string>>;
}

export function project(input: ProjectionInput): TimelineItemView[] {
  const { conversationId, accountId } = input;
  const order: Working[] = [];
  const byId = new Map<string, Working>();
  const byLocalKey = new Map<string, Working>();
  const readUpTo = new Map<string, number>(); // other account → max seq read
  const deliveredUpTo = new Map<string, number>(); // other account → max seq delivered

  const resolve = (ref: EventRef): Working | undefined => {
    if (ref.conversationId !== conversationId) return undefined;
    return ref.kind === "event" ? byId.get(ref.eventId) : byLocalKey.get(ref.idempotencyKey);
  };
  const refId = (ref: EventRef): string => (ref.kind === "event" ? ref.eventId : ref.idempotencyKey);

  const add = (w: Working): void => {
    order.push(w);
    byId.set(w.item.id, w);
    if (w.item.localKey) byLocalKey.set(w.item.localKey, w);
  };

  const apply = (message: AppMessage, sender: string, ownItem: boolean, seq: number | null): void => {
    switch (message.t) {
      case "edit": {
        const t = resolve(message.target);
        if (t && t.item.senderAccountId === sender && t.item.content.kind === "text") t.item.content = { kind: "text", body: message.body, isEdited: true };
        break;
      }
      case "delete": {
        const t = resolve(message.target);
        if (t && t.item.senderAccountId === sender) t.item.content = { kind: "deleted" };
        break;
      }
      case "reaction": {
        const t = resolve(message.target);
        if (!t) break;
        let set = t.reactions.get(message.key);
        if (!set) {
          set = new Set();
          t.reactions.set(message.key, set);
        }
        if (message.op === "add") set.add(sender);
        else set.delete(sender);
        break;
      }
      case "read": {
        if (sender === accountId) break;
        const t = resolve(message.upTo);
        const s = t?.item.seq ?? null;
        if (s !== null) readUpTo.set(sender, Math.max(readUpTo.get(sender) ?? 0, s));
        break;
      }
      case "delivered": {
        if (sender === accountId) break;
        const t = resolve(message.upTo);
        const s = t?.item.seq ?? null;
        if (s !== null) deliveredUpTo.set(sender, Math.max(deliveredUpTo.get(sender) ?? 0, s));
        break;
      }
      default:
        break;
    }
    void ownItem;
    void seq;
  };

  for (const e of input.events) {
    const isOwn = e.senderAccountId === accountId;
    const base: Omit<TimelineItemView, "content"> = {
      id: e.id,
      localKey: e.localKey ?? undefined,
      conversationId,
      seq: e.seq,
      senderAccountId: e.senderAccountId,
      senderInstanceId: e.senderInstanceId,
      sentAt: e.createdAt,
      isOwn,
      sendState: "accepted",
      reactions: [],
    };
    if (e.system) {
      add({ item: { ...base, content: { kind: "system", text: e.system } }, reactions: new Map() });
      continue;
    }
    if (e.failure && e.kind === "app_message") {
      add({ item: { ...base, content: { kind: "undecryptable", reason: e.failure } }, reactions: new Map() });
      continue;
    }
    if (!e.message) continue;
    const m = e.message;
    if (m.t === "text") {
      add({ item: { ...base, content: { kind: "text", body: m.body, isEdited: false }, replyTo: m.replyTo ? refId(m.replyTo) : undefined }, reactions: new Map() });
    } else if (m.t === "media") {
      add({ item: { ...base, content: { kind: "media", media: mediaView(conversationId, m) } }, reactions: new Map() });
    } else {
      apply(m, e.senderAccountId, isOwn, e.seq);
    }
  }

  for (const o of input.outbox) {
    if (o.kind !== "app_message" || !o.message) continue;
    const m = o.message;
    const base: Omit<TimelineItemView, "content"> = {
      id: o.id,
      localKey: o.id,
      conversationId,
      seq: null,
      senderAccountId: accountId,
      senderInstanceId: input.instanceId,
      sentAt: o.createdAt,
      isOwn: true,
      sendState: o.state === "failed" ? "failed" : "pending",
      reactions: [],
    };
    if (m.t === "text") {
      add({ item: { ...base, content: { kind: "text", body: m.body, isEdited: false }, replyTo: m.replyTo ? refId(m.replyTo) : undefined }, reactions: new Map() });
    } else if (m.t === "media") {
      add({ item: { ...base, content: { kind: "media", media: mediaView(conversationId, m) } }, reactions: new Map() });
    } else if (o.state !== "failed") {
      apply(m, accountId, true, null);
    }
  }

  const maxRead = Math.max(0, ...readUpTo.values());
  const maxDelivered = Math.max(0, ...deliveredUpTo.values());
  return order.map((w) => {
    const item = w.item;
    if (item.isOwn && item.seq !== null && item.sendState === "accepted") {
      if (item.seq <= maxRead) item.sendState = "read";
      else if (item.seq <= maxDelivered) item.sendState = "delivered";
    }
    item.reactions = [...w.reactions.entries()].filter(([, set]) => set.size > 0).map(([key, set]) => ({ key, accountIds: [...set] }));
    return item;
  });
}

function mediaView(conversationId: string, m: Extract<AppMessage, { t: "media" }>): MediaView {
  return {
    kind: m.kind,
    filename: m.filename,
    mime: m.mime,
    size: m.size,
    width: m.width,
    height: m.height,
    durationMs: m.durationMs,
    caption: m.caption,
    ref: { conversationId, blobId: m.blobId },
    thumbnail: m.thumbnail ? { ref: { conversationId, blobId: m.thumbnail.blobId }, width: m.thumbnail.width, height: m.thumbnail.height } : undefined,
  };
}
