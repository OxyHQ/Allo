/**
 * Export and import of the E2EE history archive (`@allo/shared-types`
 * `Archive`). Export reads the local store: every conversation, every
 * decrypted timeline event as its `AppMessage`, every media key. Import
 * MERGES: a conversation already here keeps its record (only a missing title
 * is filled in), events are keyed by server event id so duplicates are
 * skipped and local echoes are untouched, media keys are added. A
 * conversation this instance has no record of is fetched from the server
 * when it can be (membership, group id) and built from the archive when it
 * cannot; the welcome, when it comes, fills in the rest.
 *
 * Nothing about MLS travels here. A new leaf is a new leaf; this is how its
 * TIMELINE catches up.
 */
import { conversationResponseSchema, type Archive, type ArchiveEvent, type ArchiveMediaKey, type ConversationSummary } from "@allo/shared-types";
import type { Context } from "../context";
import { InvalidStateError } from "../errors";
import { Model } from "../storage/model";
import type { ConversationRecord, EventRecord, MediaKeyRecord } from "../storage/records";
import { describeError } from "../util/logger";

export function exportArchive(ctx: Context): Archive {
  const { model } = ctx;
  const conversations: Archive["conversations"] = [];
  const events: Archive["events"] = [];
  const mediaKeys = new Map<string, ArchiveMediaKey>();
  for (const conv of [...model.conversations.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    conversations.push({
      id: conv.id,
      kind: conv.kind,
      appId: conv.appId,
      title: conv.name,
      memberAccountIds: conv.members.filter((m) => m.state === "joined").map((m) => m.accountId),
      createdAt: conv.createdAt,
    });
    for (const e of model.eventsOf(conv.id)) {
      if (e.kind !== "app_message" || !e.message || e.message.t === "typing") continue;
      events.push({
        conversationId: conv.id,
        eventId: e.id,
        seq: e.seq,
        senderAccountId: e.senderAccountId,
        senderInstanceId: e.senderInstanceId,
        sentAt: e.createdAt,
        message: e.message,
      });
      if (e.message.t === "media") {
        const m = e.message;
        mediaKeys.set(m.blobId, {
          conversationId: conv.id,
          blobId: m.blobId,
          key: m.key,
          nonce: m.nonce,
          sha256: m.sha256,
          ...(m.thumbnail ? { thumbnail: { blobId: m.thumbnail.blobId, key: m.thumbnail.key, nonce: m.thumbnail.nonce, sha256: m.thumbnail.sha256 } } : {}),
        });
      }
    }
  }
  return {
    v: 1,
    createdAt: ctx.nowIso(),
    accountId: ctx.accountId,
    appId: ctx.options.appId,
    conversations,
    events,
    mediaKeys: [...mediaKeys.values()],
  };
}

export interface ImportResult {
  conversations: number;
  events: number;
}

export async function importArchive(ctx: Context, archive: Archive, onProgress?: (done: number, total: number) => void): Promise<ImportResult> {
  if (archive.accountId !== ctx.accountId) throw new InvalidStateError("the archive belongs to another account");
  if (archive.appId !== ctx.options.appId) throw new InvalidStateError("the archive belongs to another app");
  // Summaries for conversations we have no record of, fetched before the mutex: the server knows membership and the group id.
  const summaries = new Map<string, ConversationSummary>();
  for (const c of archive.conversations) {
    if (ctx.model.conversations.has(c.id)) continue;
    try {
      const res = await ctx.http.request({ method: "GET", path: `/v1/conversations/${c.id}`, schema: conversationResponseSchema, signer: ctx.signer });
      summaries.set(c.id, res.conversation);
    } catch (error) {
      ctx.log.debug?.("archived conversation could not be fetched; built from the archive", { conversationId: c.id, error: describeError(error) });
    }
  }
  const total = archive.events.length;
  let done = 0;
  onProgress?.(0, total);
  return ctx.mutex.run(async () => {
    const { model } = ctx;
    const batch = ctx.store.batch();
    const convs = new Map<string, ConversationRecord>();
    const touched = new Set<string>();
    let newConversations = 0;
    let newEvents = 0;
    const stage = (conv: ConversationRecord) => {
      convs.set(conv.id, conv);
      touched.add(conv.id);
    };
    for (const c of archive.conversations) {
      const existing = model.conversations.get(c.id);
      if (existing) {
        if (existing.name === null && c.title !== null) stage({ ...existing, name: c.title });
        continue;
      }
      const summary = summaries.get(c.id);
      newConversations++;
      stage(
        summary
          ? {
              id: summary.id,
              kind: summary.kind,
              appId: summary.appId,
              mlsGroupId: summary.mlsGroupId,
              createdByAccountId: summary.createdByAccountId,
              createdAt: summary.createdAt,
              name: c.title,
              members: summary.members.map((m) => ({ accountId: m.accountId, role: m.role, state: m.state })),
              lastSeq: summary.lastSeq,
              joinedEpoch: null,
              lastReadSeq: 0,
              removed: false,
              lastActivityAt: c.createdAt,
              refusedCommit: null,
            }
          : {
              id: c.id,
              kind: c.kind,
              appId: c.appId,
              mlsGroupId: "",
              createdByAccountId: c.memberAccountIds[0] ?? ctx.accountId,
              createdAt: c.createdAt,
              name: c.title,
              members: c.memberAccountIds.map((accountId) => ({ accountId, role: "member" as const, state: "joined" as const })),
              lastSeq: 0,
              joinedEpoch: null,
              lastReadSeq: 0,
              removed: false,
              lastActivityAt: c.createdAt,
              refusedCommit: null,
            },
      );
    }
    const current = (id: string): ConversationRecord | undefined => convs.get(id) ?? model.conversations.get(id);
    // Own read receipts in the archive say what this account had read; without them every imported item would count as unread.
    const seqOf = new Map<string, number>();
    for (const e of archive.events) seqOf.set(`${e.conversationId}/${e.eventId}`, e.seq);
    const records: EventRecord[] = [];
    for (const e of archive.events) {
      done++;
      const conv = current(e.conversationId);
      if (!conv) continue;
      if (e.message.t === "typing") continue;
      if (model.hasEvent(e.conversationId, e.eventId)) continue;
      const record: EventRecord = {
        id: e.eventId,
        conversationId: e.conversationId,
        seq: e.seq,
        kind: "app_message",
        epoch: 0,
        senderAccountId: e.senderAccountId,
        senderInstanceId: e.senderInstanceId,
        createdAt: e.sentAt,
        localKey: null,
        message: e.message,
        failure: null,
        system: null,
      };
      batch.putJson("event", Model.eventId(record), record);
      records.push(record);
      newEvents++;
      let next = conv;
      if ((e.message.t === "text" || e.message.t === "media") && e.sentAt > next.lastActivityAt) next = { ...next, lastActivityAt: e.sentAt };
      if (e.message.t === "read" && e.senderAccountId === ctx.accountId && e.message.upTo.kind === "event") {
        const s = seqOf.get(`${e.conversationId}/${e.message.upTo.eventId}`) ?? model.events.get(e.conversationId)?.get(e.message.upTo.eventId)?.seq;
        if (s !== undefined && s > next.lastReadSeq) next = { ...next, lastReadSeq: s };
      }
      if (next !== conv) stage(next);
      touched.add(e.conversationId);
      if (done % 200 === 0) onProgress?.(done, total);
    }
    const mediaRecords: MediaKeyRecord[] = [];
    const mediaMeta = new Map<string, { mime: string; size: number }>();
    for (const e of archive.events) if (e.message.t === "media") mediaMeta.set(e.message.blobId, { mime: e.message.mime, size: e.message.size });
    for (const k of archive.mediaKeys) {
      const add = (fields: { blobId: string; key: string; nonce: string; sha256: string }, meta: { mime: string; size: number }) => {
        if (model.mediaKeys.has(fields.blobId)) return;
        const record: MediaKeyRecord = { blobId: fields.blobId, conversationId: k.conversationId, key: fields.key, nonce: fields.nonce, sha256: fields.sha256, ...meta };
        batch.putJson("mediaKey", record.blobId, record);
        mediaRecords.push(record);
      };
      add(k, mediaMeta.get(k.blobId) ?? { mime: "application/octet-stream", size: 0 });
      if (k.thumbnail) add(k.thumbnail, { mime: "image/*", size: 0 });
    }
    for (const conv of convs.values()) batch.putJson("conversation", conv.id, conv);
    await ctx.store.commit(batch);
    for (const conv of convs.values()) model.conversations.set(conv.id, conv);
    for (const r of records) model.putEvent(r);
    for (const r of mediaRecords) model.mediaKeys.set(r.blobId, r);
    for (const id of touched) ctx.messages.invalidate(id);
    if (touched.size) ctx.conversations.invalidate();
    onProgress?.(total, total);
    return { conversations: newConversations, events: newEvents };
  });
}
