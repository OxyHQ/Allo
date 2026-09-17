/**
 * The in-memory working set: every record of this instance, loaded once at
 * start and kept in step with the store by the modules that mutate it (they
 * write the batch first, then the map). Reads are synchronous so the view
 * getters React polls can be, too.
 */
import { INITIAL_CURSOR } from "@allo/shared-types";
import type { InstanceStore } from "./store";
import {
  approvalRecordSchema,
  conversationRecordSchema,
  cursorRecordSchema,
  eventRecordSchema,
  mediaKeyRecordSchema,
  outboxItemRecordSchema,
  queuedEventRecordSchema,
  type ApprovalRecord,
  type ConversationRecord,
  type EventRecord,
  type MediaKeyRecord,
  type OutboxItemRecord,
  type QueuedEventRecord,
} from "./records";
import { seqKey } from "./namespace";

export class Model {
  readonly conversations = new Map<string, ConversationRecord>();
  /** conversationId → eventId → record */
  readonly events = new Map<string, Map<string, EventRecord>>();
  readonly outbox = new Map<string, OutboxItemRecord>();
  /** conversationId → queued deliveries in arrival order */
  readonly queued = new Map<string, QueuedEventRecord[]>();
  readonly mediaKeys = new Map<string, MediaKeyRecord>();
  readonly approvals = new Map<string, ApprovalRecord>();
  cursor: string = INITIAL_CURSOR;

  async load(store: InstanceStore): Promise<void> {
    for (const { value } of await store.listJson("conversation", conversationRecordSchema)) this.conversations.set(value.id, value);
    for (const { value } of await store.listJson("event", eventRecordSchema)) this.putEvent(value);
    for (const { value } of await store.listJson("outbox", outboxItemRecordSchema)) this.outbox.set(value.id, value);
    for (const { value } of await store.listJson("queued", queuedEventRecordSchema)) this.pushQueued(value);
    for (const { value } of await store.listJson("mediaKey", mediaKeyRecordSchema)) this.mediaKeys.set(value.blobId, value);
    for (const { value } of await store.listJson("approval", approvalRecordSchema)) this.approvals.set(value.instanceId, value);
    const cursor = await store.getJson("cursor", "sync", cursorRecordSchema);
    if (cursor) this.cursor = cursor.cursor;
  }

  putEvent(record: EventRecord): void {
    let m = this.events.get(record.conversationId);
    if (!m) {
      m = new Map();
      this.events.set(record.conversationId, m);
    }
    m.set(record.id, record);
  }

  /** Events of a conversation in seq order. */
  eventsOf(conversationId: string): EventRecord[] {
    const m = this.events.get(conversationId);
    if (!m) return [];
    return [...m.values()].sort((a, b) => a.seq - b.seq);
  }

  hasEvent(conversationId: string, eventId: string): boolean {
    return this.events.get(conversationId)?.has(eventId) ?? false;
  }

  findEventByLocalKey(conversationId: string, localKey: string): EventRecord | undefined {
    for (const e of this.events.get(conversationId)?.values() ?? []) if (e.localKey === localKey) return e;
    return undefined;
  }

  pushQueued(record: QueuedEventRecord): void {
    const id = record.event.conversationId;
    let list = this.queued.get(id);
    if (!list) {
      list = [];
      this.queued.set(id, list);
    }
    if (!list.some((q) => q.event.id === record.event.id)) list.push(record);
    list.sort((a, b) => a.event.seq - b.event.seq);
  }

  takeQueued(conversationId: string): QueuedEventRecord[] {
    const list = this.queued.get(conversationId) ?? [];
    this.queued.delete(conversationId);
    return list;
  }

  /** Outbox items in creation order (ids are uuid v7). */
  outboxItems(conversationId?: string): OutboxItemRecord[] {
    return [...this.outbox.values()]
      .filter((i) => conversationId === undefined || i.conversationId === conversationId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  static queuedId(record: QueuedEventRecord): string {
    return `${record.event.conversationId}/${seqKey(record.event.seq)}`;
  }

  static eventId(record: EventRecord): string {
    return `${record.conversationId}/${seqKey(record.seq)}-${record.id}`;
  }
}
