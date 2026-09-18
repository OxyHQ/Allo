/**
 * The durable outbound queue. An item is persisted before anything is
 * sent and deleted only once the server answered; its id is the
 * idempotency key, so a retry after a 5xx or a lost answer yields one server
 * event. Sending is strictly in order per instance: MLS sender ratchets and
 * epoch handling depend on it.
 *
 * Commits: the pre-commit state stays live; the state AFTER the commit is
 * persisted as a `pendingCommit` together with the exact request, and is
 * swapped in only when the server accepts (invariant 2). On
 * `epoch_conflict` the pending state is discarded, a sync processes the
 * winning commit, and the intent is rebuilt on the new state, dropping
 * whatever the winner already did.
 *
 * Hold: an application message for a conversation in which no other member
 * has a device (`ConversationsService.hasNoReachableMember`) is skipped —
 * not encrypted, not sent, no attempt counted — and picked up by the next
 * pass once a leaf for another account exists. Encrypting it earlier would
 * bind it to an epoch that account can never read. Commits are never held.
 */
import { encodeAppMessage, submitEventResponseSchema, type AppMessage, type EventRef, type SubmitEventRequest } from "@allo/shared-types";
import type { Context } from "../context";
import { EpochConflictError, InstanceNotActiveError, InvalidStateError, TransportError } from "../errors";
import { Model } from "../storage/model";
import { pendingCommitRecordSchema, type EventRecord, type OutboxCommitIntent, type OutboxItemRecord } from "../storage/records";
import { base64Decode, base64Encode } from "../util/bytes";
import { uuidV7 } from "../util/ids";
import { backoffMs, sleep } from "../util/async";
import { describeError } from "../util/logger";

const MAX_ATTEMPTS = 50;

export class OutboxEngine {
  private running: Promise<void> | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(private readonly ctx: Context) {}

  /** Queues an application message; returns the item (its id is the local key). */
  async enqueueMessage(conversationId: string, message: AppMessage, blobIds: string[] = []): Promise<OutboxItemRecord> {
    const { ctx } = this;
    ctx.instance.assertActive();
    const conv = ctx.model.conversations.get(conversationId);
    if (!conv) throw new InvalidStateError(`unknown conversation ${conversationId}`);
    const item: OutboxItemRecord = {
      id: uuidV7(ctx.now()),
      conversationId,
      kind: "app_message",
      createdAt: ctx.nowIso(),
      attempts: 0,
      state: "pending",
      failure: null,
      message,
      commit: null,
      blobIds,
    };
    await ctx.store.putJson("outbox", item.id, item);
    ctx.model.outbox.set(item.id, item);
    ctx.messages.invalidate(conversationId);
    ctx.conversations.invalidate(conversationId);
    this.kick();
    return item;
  }

  /** Queues a commit intent unless an equivalent one is already pending. */
  async enqueueCommit(conversationId: string, intent: OutboxCommitIntent): Promise<void> {
    const { ctx } = this;
    if (!ctx.instance.isActive) return;
    const pending = ctx.model.outboxItems(conversationId).filter((i) => i.kind === "commit" && i.state === "pending");
    const covered = (id: string) => pending.some((p) => p.commit?.adds.some((a) => a.instanceId === id) || p.commit?.removes.includes(id));
    const adds = intent.adds.filter((a) => !covered(a.instanceId));
    const removes = intent.removes.filter((r) => !covered(r));
    if (adds.length === 0 && removes.length === 0) return;
    const item: OutboxItemRecord = {
      id: uuidV7(ctx.now()),
      conversationId,
      kind: "commit",
      createdAt: ctx.nowIso(),
      attempts: 0,
      state: "pending",
      failure: null,
      message: null,
      commit: { adds, removes, reason: intent.reason },
      blobIds: [],
    };
    await ctx.store.putJson("outbox", item.id, item);
    ctx.model.outbox.set(item.id, item);
    this.kick();
  }

  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.wake?.();
      return;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
  }

  /** Resolves when the queue has drained (or the loop stopped). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  start(): void {
    this.stopped = false;
  }

  private async loop(): Promise<void> {
    const { ctx } = this;
    while (!this.stopped) {
      const item = ctx.model.outboxItems().find((i) => i.state === "pending" && !this.isHeld(i));
      if (!item) return;
      if (!ctx.instance.isActive) return;
      try {
        const done = item.kind === "commit" ? await this.sendCommit(item) : await this.sendMessage(item);
        if (!done) return;
      } catch (error) {
        if (error instanceof InstanceNotActiveError) return;
        ctx.log.warn?.("outbox item failed unexpectedly", { itemId: item.id, error: describeError(error) });
        await this.markFailed(item, describeError(error));
      }
    }
  }

  /** Held items stay `pending` untouched; `TimelineItemView.holdReason` tells the UI why. */
  private isHeld(item: OutboxItemRecord): boolean {
    return item.kind === "app_message" && this.ctx.conversations.hasNoReachableMember(item.conversationId);
  }

  private async bump(item: OutboxItemRecord): Promise<OutboxItemRecord> {
    const next = { ...item, attempts: item.attempts + 1 };
    await this.ctx.store.putJson("outbox", next.id, next);
    this.ctx.model.outbox.set(next.id, next);
    return next;
  }

  private async markFailed(item: OutboxItemRecord, failure: string): Promise<void> {
    const next: OutboxItemRecord = { ...item, state: "failed", failure };
    await this.ctx.store.putJson("outbox", next.id, next);
    this.ctx.model.outbox.set(next.id, next);
    this.ctx.messages.invalidate(item.conversationId);
  }

  private async delay(item: OutboxItemRecord): Promise<void> {
    const ms = backoffMs(item.attempts);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    this.wake = null;
  }

  /** Returns false when the loop should stop (offline backoff exhausted for now). */
  private async handleTransportError(item: OutboxItemRecord, error: unknown): Promise<"retry" | "stop" | "failed"> {
    const { ctx } = this;
    if (error instanceof EpochConflictError) {
      try {
        await ctx.sync.now();
      } catch (e) {
        ctx.log.debug?.("sync after epoch conflict failed", { error: describeError(e) });
        await this.delay(item);
      }
      return "retry";
    }
    if (error instanceof TransportError && error.isRetryable) {
      if (item.attempts >= MAX_ATTEMPTS) {
        await this.markFailed(item, "gave up after repeated transport failures");
        return "failed";
      }
      ctx.sync.setState("offline");
      await this.delay(item);
      return this.stopped ? "stop" : "retry";
    }
    await this.markFailed(item, error instanceof TransportError ? `${error.serverCode}: ${error.message}` : describeError(error));
    return "failed";
  }

  // ---- application messages ----------------------------------------------

  private async sendMessage(item0: OutboxItemRecord): Promise<boolean> {
    const { ctx } = this;
    const item = await this.bump(item0);
    if (!item.message) {
      await this.markFailed(item, "empty item");
      return true;
    }
    const state = ctx.groups.get(item.conversationId);
    if (!state || !ctx.engine.isActive(state) || ctx.model.conversations.get(item.conversationId)?.removed) {
      await this.markFailed(item, "not a member of this conversation");
      return true;
    }
    // Encrypt under the mutex and persist the advanced ratchet BEFORE the send.
    const encrypted = await ctx.mutex.run(async () => {
      const live = ctx.groups.get(item.conversationId)!;
      const message = this.resolveLocalRefs(item.conversationId, item.message!);
      const { ciphertext, next } = await ctx.engine.encryptApplication(live, encodeAppMessage(message));
      const batch = ctx.store.batch();
      ctx.groups.stage(batch, item.conversationId, next);
      await ctx.store.commit(batch);
      ctx.groups.commitInMemory(item.conversationId, next);
      return { ciphertext, epoch: ctx.engine.epochOf(live), message };
    });
    const request: SubmitEventRequest = {
      idempotencyKey: item.id,
      kind: "app_message",
      epoch: encrypted.epoch,
      payload: base64Encode(encrypted.ciphertext),
      ...(item.blobIds.length ? { blobIds: item.blobIds } : {}),
    };
    try {
      const res = await ctx.http.request({
        method: "POST",
        path: `/v1/conversations/${item.conversationId}/events`,
        body: request,
        schema: submitEventResponseSchema,
        signer: ctx.signer,
      });
      await this.recordAccepted(item, res.event, encrypted.epoch, encrypted.message);
      return true;
    } catch (error) {
      const verdict = await this.handleTransportError(item, error);
      return verdict !== "stop";
    }
  }

  /** A `local` ref to one of our own messages becomes an `event` ref once that message has an id. */
  private resolveLocalRefs(conversationId: string, message: AppMessage): AppMessage {
    const fix = (ref: EventRef): EventRef => {
      if (ref.kind !== "local") return ref;
      const e = this.ctx.model.findEventByLocalKey(conversationId, ref.idempotencyKey);
      return e ? { kind: "event", conversationId, eventId: e.id } : ref;
    };
    switch (message.t) {
      case "text":
        return message.replyTo ? { ...message, replyTo: fix(message.replyTo) } : message;
      case "edit":
      case "delete":
      case "reaction":
        return { ...message, target: fix(message.target) };
      case "read":
      case "delivered":
        return { ...message, upTo: fix(message.upTo) };
      default:
        return message;
    }
  }

  private async recordAccepted(item: OutboxItemRecord, accepted: { id: string; seq: number; createdAt: string }, epoch: number, message: AppMessage | null): Promise<void> {
    const { ctx } = this;
    await ctx.mutex.run(async () => {
      const batch = ctx.store.batch();
      const record: EventRecord = {
        id: accepted.id,
        conversationId: item.conversationId,
        seq: accepted.seq,
        kind: item.kind === "commit" ? "mls_commit" : "app_message",
        epoch,
        senderAccountId: ctx.accountId,
        senderInstanceId: ctx.instanceId,
        createdAt: accepted.createdAt,
        localKey: item.id,
        message,
        failure: null,
        system: null,
      };
      batch.putJson("event", Model.eventId(record), record);
      batch.delete("outbox", item.id);
      const conv = ctx.model.conversations.get(item.conversationId);
      let nextConv = conv;
      if (conv) {
        nextConv = { ...conv, lastSeq: Math.max(conv.lastSeq, accepted.seq) };
        if (message?.t === "text" || message?.t === "media") nextConv = { ...nextConv, lastActivityAt: accepted.createdAt };
        if (message?.t === "conversation" && message.name !== undefined) nextConv = { ...nextConv, name: message.name };
        batch.putJson("conversation", nextConv.id, nextConv);
      }
      if (message?.t === "media") {
        const key = { blobId: message.blobId, conversationId: item.conversationId, key: message.key, nonce: message.nonce, sha256: message.sha256, mime: message.mime, size: message.size };
        batch.putJson("mediaKey", key.blobId, key);
        ctx.model.mediaKeys.set(key.blobId, key);
        if (message.thumbnail) {
          const t = message.thumbnail;
          const known = ctx.model.mediaKeys.get(t.blobId);
          const tk = { blobId: t.blobId, conversationId: item.conversationId, key: t.key, nonce: t.nonce, sha256: t.sha256, mime: known?.mime ?? "image/*", size: known?.size ?? 0 };
          batch.putJson("mediaKey", tk.blobId, tk);
          ctx.model.mediaKeys.set(tk.blobId, tk);
        }
      }
      await ctx.store.commit(batch);
      ctx.model.putEvent(record);
      ctx.model.outbox.delete(item.id);
      if (nextConv) ctx.model.conversations.set(nextConv.id, nextConv);
      ctx.messages.invalidate(item.conversationId);
      ctx.conversations.invalidate(item.conversationId);
    });
  }

  // ---- commits -------------------------------------------------------------

  private async sendCommit(item0: OutboxItemRecord): Promise<boolean> {
    const { ctx } = this;
    const item = await this.bump(item0);
    const intent = item.commit;
    if (!intent) {
      await this.markFailed(item, "empty commit");
      return true;
    }
    // A pending state from an earlier attempt (crash or lost answer): resend the identical request.
    const pending = await ctx.store.getJson("pendingCommit", item.conversationId, pendingCommitRecordSchema);
    let request: SubmitEventRequest;
    let nextBytes: Uint8Array;
    let added: Array<{ instanceId: string; accountId: string }> = [];
    let removed: string[] = [];
    if (pending && pending.outboxItemId === item.id && pending.request) {
      request = pending.request;
      nextBytes = base64Decode(pending.nextState);
      added = request.commit?.addedLeaves ?? [];
      removed = request.commit?.removedLeaves ?? [];
    } else {
      const built = await ctx.mutex.run(() => this.buildCommit(item, intent));
      if (!built) {
        await this.drop(item);
        return true;
      }
      request = built.request;
      nextBytes = built.nextBytes;
      added = built.added;
      removed = built.removed;
    }
    try {
      const res = await ctx.http.request({
        method: "POST",
        path: `/v1/conversations/${item.conversationId}/events`,
        body: request,
        schema: submitEventResponseSchema,
        signer: ctx.signer,
      });
      await this.applyCommit(item, request.epoch, nextBytes, added, removed, res.event);
      await ctx.sync.replayQueued(item.conversationId);
      return true;
    } catch (error) {
      if (error instanceof EpochConflictError) await this.discardPending(item.conversationId);
      const verdict = await this.handleTransportError(item, error);
      return verdict !== "stop";
    }
  }

  private async buildCommit(item: OutboxItemRecord, intent: OutboxCommitIntent): Promise<{ request: SubmitEventRequest; nextBytes: Uint8Array; added: Array<{ instanceId: string; accountId: string }>; removed: string[] } | null> {
    const { ctx } = this;
    const state = ctx.groups.get(item.conversationId);
    const conv = ctx.model.conversations.get(item.conversationId);
    if (!state || !ctx.engine.isActive(state) || conv?.removed) return null;
    const members = ctx.engine.membersOf(state);
    const present = new Set(members.map((m) => m.instanceId));
    const adds = intent.adds.filter((a) => !present.has(a.instanceId));
    const removes = intent.removes.filter((r) => present.has(r));
    if (adds.length === 0 && removes.length === 0) return null;
    const leafIndexes = removes.map((r) => members.find((m) => m.instanceId === r)!.leafIndex);
    const result = await ctx.engine.commit(state, { addKeyPackages: adds.map((a) => base64Decode(a.keyPackage)), removeLeafIndexes: leafIndexes });
    const epoch = ctx.engine.epochOf(state);
    const request: SubmitEventRequest = {
      idempotencyKey: item.id,
      kind: "mls_commit",
      epoch,
      payload: base64Encode(result.commit),
      commit: {
        newEpoch: epoch + 1,
        addedLeaves: result.added,
        removedLeaves: removes,
        ...(result.welcome && adds.length ? { welcome: { payload: base64Encode(result.welcome), recipients: adds.map((a) => a.instanceId) } } : {}),
      },
    };
    const nextBytes = ctx.engine.serializeGroup(result.next);
    await ctx.store.putJson("pendingCommit", item.conversationId, { outboxItemId: item.id, conversationId: item.conversationId, epoch, nextState: base64Encode(nextBytes), request });
    return { request, nextBytes, added: result.added, removed: removes };
  }

  private async applyCommit(item: OutboxItemRecord, epoch: number, nextBytes: Uint8Array, added: Array<{ instanceId: string; accountId: string }>, removed: string[], accepted: { id: string; seq: number; createdAt: string }): Promise<void> {
    const { ctx } = this;
    await ctx.mutex.run(async () => {
      const live = ctx.groups.get(item.conversationId);
      if (live && ctx.engine.epochOf(live) !== epoch) {
        // The server accepted our commit at `epoch`, so nothing else can have advanced the state; this is a bug guard.
        ctx.log.error?.("state advanced while a commit was pending", { conversationId: item.conversationId });
      }
      const next = ctx.engine.deserializeGroup(nextBytes);
      const batch = ctx.store.batch();
      ctx.groups.stage(batch, item.conversationId, next);
      batch.delete("pendingCommit", item.conversationId);
      batch.delete("outbox", item.id);
      const record: EventRecord = {
        id: accepted.id,
        conversationId: item.conversationId,
        seq: accepted.seq,
        kind: "mls_commit",
        epoch,
        senderAccountId: ctx.accountId,
        senderInstanceId: ctx.instanceId,
        createdAt: accepted.createdAt,
        localKey: item.id,
        message: null,
        failure: null,
        system: null,
      };
      batch.putJson("event", Model.eventId(record), record);
      const conv = ctx.model.conversations.get(item.conversationId);
      let nextConv = conv;
      if (conv) {
        const accounts = new Set(ctx.engine.membersOf(next).map((m) => m.accountId));
        const members = conv.members.map((m) => (accounts.has(m.accountId) ? { ...m, state: "joined" as const } : m));
        for (const a of accounts) if (!members.some((m) => m.accountId === a)) members.push({ accountId: a, role: "member", state: "joined" });
        nextConv = { ...conv, members, lastSeq: Math.max(conv.lastSeq, accepted.seq) };
        batch.putJson("conversation", nextConv.id, nextConv);
      }
      await ctx.store.commit(batch);
      ctx.groups.commitInMemory(item.conversationId, next);
      ctx.model.putEvent(record);
      ctx.model.outbox.delete(item.id);
      if (nextConv) ctx.model.conversations.set(nextConv.id, nextConv);
      ctx.messages.invalidate(item.conversationId); // leaves changed: pending echoes may have lost their hold reason
      ctx.conversations.invalidate(item.conversationId);
      ctx.log.info?.("commit applied", { conversationId: item.conversationId, epoch: epoch + 1, added: added.length, removed: removed.length });
    });
  }

  private async discardPending(conversationId: string): Promise<void> {
    await this.ctx.store.delete("pendingCommit", conversationId);
  }

  private async drop(item: OutboxItemRecord): Promise<void> {
    const batch = this.ctx.store.batch().delete("outbox", item.id).delete("pendingCommit", item.conversationId);
    await this.ctx.store.commit(batch);
    this.ctx.model.outbox.delete(item.id);
  }
}
