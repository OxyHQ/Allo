/**
 * One delivery in, one atomic batch out. `Dispatcher.dispatch` turns a
 * conversation event into: a group-state change, an event record, a
 * conversation record change and the cursor, staged in one `StoreBatch`
 * and committed together; the in-memory model is updated only after the
 * batch landed. A message from an epoch the state has not reached (or for a
 * conversation with no state yet) is queued, persisted, and replayed by the
 * sync engine after the next commit or join.
 *
 * Every handler works on ONE working copy of the conversation record
 * (`Work.conv`), staged once at the end, so two changes in one delivery
 * cannot overwrite each other.
 */
import {
  AppMessageDecodeError,
  controlEventSchema,
  conversationResponseSchema,
  decodeAppMessageOrIgnore,
  type AppMessage,
  type ConversationEvent,
  type ConversationSummary,
} from "@allo/shared-types";
import type { Context } from "../context";
import { DecryptError, FutureEpochError } from "../errors";
import { Model } from "../storage/model";
import { pendingCommitRecordSchema, type ConversationRecord, type EventRecord } from "../storage/records";
import type { StoreBatch } from "../storage/store";
import { base64Decode, utf8Decode } from "../util/bytes";
import { describeError } from "../util/logger";
import type { GroupState } from "../crypto/engine";

export interface DispatchOutcome {
  /** A commit or a join changed the epoch: replay what was queued for the conversation. */
  epochAdvanced: boolean;
  queued: boolean;
}

/** The per-delivery working set. */
class Work {
  readonly batch: StoreBatch;
  readonly after: Array<() => void> = [];
  conv: ConversationRecord | undefined;
  convChanged = false;
  state: GroupState | undefined;
  stateChanged = false;
  timelineTouched = false;
  queued = false;

  constructor(
    readonly ctx: Context,
    readonly event: ConversationEvent,
  ) {
    this.batch = ctx.store.batch();
    this.conv = ctx.model.conversations.get(event.conversationId);
    this.state = ctx.groups.get(event.conversationId);
  }

  setConv(next: ConversationRecord): void {
    this.conv = next;
    this.convChanged = true;
  }

  setState(next: GroupState): void {
    this.state = next;
    this.stateChanged = true;
  }

  record(fields: { message: AppMessage | null; failure: string | null; system: string | null; localKey: string | null }): EventRecord {
    const e = this.event;
    const record: EventRecord = {
      id: e.id,
      conversationId: e.conversationId,
      seq: e.seq,
      kind: e.kind,
      epoch: e.epoch,
      senderAccountId: e.senderAccountId,
      senderInstanceId: e.senderInstanceId,
      createdAt: e.createdAt,
      ...fields,
    };
    this.batch.putJson("event", Model.eventId(record), record);
    this.after.push(() => this.ctx.model.putEvent(record));
    this.timelineTouched = true;
    return record;
  }
}

export class Dispatcher {
  constructor(private readonly ctx: Context) {}

  /**
   * `cursor` is staged into the batch so the delivery and its consequences
   * land together. `replaying` marks a queued event being retried.
   */
  async dispatch(event: ConversationEvent, cursor: string | null, replaying = false): Promise<DispatchOutcome> {
    const { ctx } = this;
    return ctx.mutex.run(async () => {
      const w = new Work(ctx, event);
      if (cursor !== null) w.batch.putJson("cursor", "sync", { cursor });
      let epochAdvanced = false;
      if (!ctx.model.hasEvent(event.conversationId, event.id)) {
        try {
          switch (event.kind) {
            case "control":
              await this.onControl(w);
              break;
            case "mls_welcome":
              epochAdvanced = await this.onWelcome(w);
              break;
            case "mls_commit":
            case "mls_proposal":
              epochAdvanced = await this.onHandshake(w);
              break;
            case "app_message":
              await this.onAppMessage(w);
              break;
          }
        } catch (error) {
          if (error instanceof FutureEpochError || error instanceof NoStateYet) this.queue(w);
          else throw error;
        }
      }
      await this.finish(w, cursor, replaying);
      return { epochAdvanced, queued: w.queued };
    });
  }

  private async finish(w: Work, cursor: string | null, replaying: boolean): Promise<void> {
    const { ctx } = this;
    const id = w.event.conversationId;
    if (replaying && !w.queued) w.batch.delete("queued", Model.queuedId({ event: w.event }));
    if (w.conv && w.event.seq > w.conv.lastSeq && !w.queued) w.setConv({ ...w.conv, lastSeq: w.event.seq });
    if (w.convChanged && w.conv) {
      const next = w.conv;
      w.batch.putJson("conversation", next.id, next);
      w.after.push(() => ctx.model.conversations.set(next.id, next));
    }
    if (w.stateChanged && w.state) {
      const next = w.state;
      ctx.groups.stage(w.batch, id, next);
      w.after.push(() => ctx.groups.commitInMemory(id, next));
    }
    await ctx.store.commit(w.batch);
    if (cursor !== null) ctx.model.cursor = cursor;
    for (const fn of w.after) fn();
    if (w.timelineTouched) ctx.messages.invalidate(id);
    if (w.timelineTouched || w.convChanged || w.stateChanged) ctx.conversations.invalidate(id);
  }

  private queue(w: Work): void {
    const record = { event: w.event };
    w.batch.putJson("queued", Model.queuedId(record), record);
    w.after.push(() => this.ctx.model.pushQueued(record));
    w.queued = true;
    // Nothing else from this delivery may land: the batch keeps only the cursor and the queue entry.
    w.convChanged = false;
    w.stateChanged = false;
    w.timelineTouched = false;
  }

  // ---- control -------------------------------------------------------------

  private async onControl(w: Work): Promise<void> {
    const { ctx } = this;
    const parsed = controlEventSchema.safeParse(JSON.parse(utf8Decode(base64Decode(w.event.payload))));
    if (!parsed.success) {
      ctx.log.warn?.("control event did not parse", { conversationId: w.event.conversationId });
      return;
    }
    const control = parsed.data;
    const state = w.state;
    let system: string | null = null;
    if (control.t === "instance_revoked") {
      system = "device_removed";
      if (state && ctx.engine.isActive(state) && !w.conv?.removed) {
        const members = ctx.engine.membersOf(state);
        if (members.some((m) => m.instanceId === control.instanceId)) {
          const remaining = members.filter((m) => m.instanceId !== control.instanceId);
          const sameAccount = remaining.filter((m) => m.accountId === control.accountId);
          if (this.isElector(sameAccount.length ? sameAccount : remaining)) {
            const conversationId = w.event.conversationId;
            w.after.push(() => void ctx.outbox.enqueueCommit(conversationId, { adds: [], removes: [control.instanceId], reason: "revoked" }));
          }
        }
      }
    } else if (control.t === "member_left") {
      system = "member_left";
      if (w.conv) w.setConv({ ...w.conv, members: w.conv.members.map((m) => (m.accountId === control.accountId ? { ...m, state: "left" as const } : m)) });
      if (state && ctx.engine.isActive(state) && !w.conv?.removed && control.accountId !== ctx.accountId) {
        const members = ctx.engine.membersOf(state);
        const leaving = members.filter((m) => m.accountId === control.accountId);
        const remaining = members.filter((m) => m.accountId !== control.accountId);
        if (leaving.length && this.isElector(remaining)) {
          const conversationId = w.event.conversationId;
          w.after.push(() => void ctx.outbox.enqueueCommit(conversationId, { adds: [], removes: leaving.map((m) => m.instanceId), reason: "member_left" }));
        }
      }
    }
    w.record({ message: null, failure: null, system, localKey: null });
  }

  private isElector(candidates: Array<{ instanceId: string }>): boolean {
    if (candidates.length === 0) return false;
    return candidates.map((c) => c.instanceId).sort()[0] === this.ctx.instanceId;
  }

  // ---- welcome -------------------------------------------------------------

  private async onWelcome(w: Work): Promise<boolean> {
    const { ctx } = this;
    const id = w.event.conversationId;
    if (w.state && ctx.engine.isActive(w.state) && !w.conv?.removed) {
      ctx.log.debug?.("welcome for a conversation already joined; ignored", { conversationId: id });
      return false;
    }
    const welcome = base64Decode(w.event.payload);
    const ref = ctx.engine.welcomeRefs(welcome).find((r) => ctx.instance.hasKeyPackage(r));
    // The summary first: if the server is unreachable the delivery is retried, nothing consumed.
    const summary = await this.fetchSummary(id);
    if (!ref) {
      ctx.log.warn?.("welcome names no key package this instance holds", { conversationId: id });
      w.setConv(this.recordFromSummary(summary, w.conv, null));
      w.record({ message: null, failure: "welcome_without_key_package", system: null, localKey: null });
      return false;
    }
    const bundle = await ctx.instance.takeKeyPackage(ref);
    if (!bundle) return false;
    let state: GroupState;
    try {
      state = await ctx.engine.joinFromWelcome(welcome, bundle);
    } catch (error) {
      ctx.log.warn?.("welcome could not be joined", { conversationId: id, error: describeError(error) });
      w.setConv(this.recordFromSummary(summary, w.conv, null));
      w.record({ message: null, failure: "welcome_rejected", system: null, localKey: null });
      return false;
    }
    w.setState(state);
    w.setConv(this.recordFromSummary(summary, w.conv, ctx.engine.epochOf(state), w.event.seq));
    w.record({ message: null, failure: null, system: null, localKey: null });
    return true;
  }

  private async fetchSummary(conversationId: string): Promise<ConversationSummary> {
    const res = await this.ctx.http.request({ method: "GET", path: `/v1/conversations/${conversationId}`, schema: conversationResponseSchema, signer: this.ctx.signer });
    return res.conversation;
  }

  private recordFromSummary(summary: ConversationSummary, existing: ConversationRecord | undefined, joinedEpoch: number | null, joinSeq?: number): ConversationRecord {
    return {
      id: summary.id,
      kind: summary.kind,
      appId: summary.appId,
      mlsGroupId: summary.mlsGroupId,
      createdByAccountId: summary.createdByAccountId,
      createdAt: summary.createdAt,
      name: existing?.name ?? null,
      members: summary.members.map((m) => ({ accountId: m.accountId, role: m.role, state: m.state })),
      lastSeq: joinSeq ?? existing?.lastSeq ?? 0,
      joinedEpoch: joinedEpoch ?? existing?.joinedEpoch ?? null,
      lastReadSeq: existing?.lastReadSeq ?? 0,
      removed: joinedEpoch !== null ? false : (existing?.removed ?? false),
      lastActivityAt: existing?.lastActivityAt ?? summary.createdAt,
    };
  }

  // ---- handshake -----------------------------------------------------------

  private async onHandshake(w: Work): Promise<boolean> {
    const { ctx } = this;
    const { event, conv, state } = w;
    if (!state) throw new NoStateYet();
    if (conv?.joinedEpoch !== null && conv !== undefined && event.epoch < conv.joinedEpoch) return false; // before this leaf existed
    if (event.senderInstanceId === ctx.instanceId) {
      // Our own commit, seen through a gap fill before the outbox recorded it: apply the pending state if it is the one.
      const pending = await ctx.store.getJson("pendingCommit", event.conversationId, pendingCommitRecordSchema);
      if (pending && pending.epoch === event.epoch && event.kind === "mls_commit") {
        w.setState(ctx.engine.deserializeGroup(base64Decode(pending.nextState)));
        w.record({ message: null, failure: null, system: null, localKey: pending.outboxItemId });
        return true;
      }
      ctx.log.warn?.("own handshake message with no pending state; skipped", { conversationId: event.conversationId });
      return false;
    }
    let result;
    try {
      result = await ctx.engine.processIncoming(state, base64Decode(event.payload));
    } catch (error) {
      if (error instanceof FutureEpochError) throw error;
      if (error instanceof DecryptError) {
        ctx.log.warn?.("handshake message rejected", { conversationId: event.conversationId, error: describeError(error) });
        w.record({ message: null, failure: null, system: null, localKey: null });
        return false;
      }
      throw error;
    }
    w.setState(result.next);
    if (conv && result.kind === "commit") {
      // Membership follows the tree: every account with a leaf is joined.
      const accounts = new Set(ctx.engine.membersOf(result.next).map((m) => m.accountId));
      const members = conv.members.map((m) => (accounts.has(m.accountId) ? { ...m, state: "joined" as const } : m));
      for (const a of accounts) if (!members.some((m) => m.accountId === a)) members.push({ accountId: a, role: "member", state: "joined" });
      w.setConv({ ...conv, members, removed: result.removedSelf ? true : conv.removed });
    } else if (conv && result.removedSelf) {
      w.setConv({ ...conv, removed: true });
    }
    w.record({ message: null, failure: null, system: null, localKey: null });
    return result.kind === "commit";
  }

  // ---- application ---------------------------------------------------------

  private async onAppMessage(w: Work): Promise<void> {
    const { ctx } = this;
    const { event, conv, state } = w;
    if (!state) throw new NoStateYet();
    if (conv?.joinedEpoch !== null && conv !== undefined && event.epoch < conv.joinedEpoch) return; // sent before this leaf existed
    if (event.senderInstanceId === ctx.instanceId) return; // ours; the outbox recorded it
    let message: AppMessage | null = null;
    let failure: string | null = null;
    let ignorable = false;
    try {
      const result = await ctx.engine.processIncoming(state, base64Decode(event.payload));
      w.setState(result.next);
      if (result.kind !== "application" || !result.plaintext) failure = "not_an_application_message";
      else {
        try {
          // A control kind from a newer client decodes to `null`: nothing to
          // act on, and nothing to draw. Only a message this build genuinely
          // cannot read becomes a failure the timeline reports.
          message = decodeAppMessageOrIgnore(result.plaintext);
          if (message === null) ignorable = true;
        } catch (error) {
          failure = error instanceof AppMessageDecodeError ? "unsupported_message" : "undecodable";
        }
      }
    } catch (error) {
      if (error instanceof FutureEpochError) throw error;
      if (error instanceof DecryptError) failure = "undecryptable";
      else throw error;
    }
    if (ignorable) return; // a control kind this build does not know: recorded as nothing
    if (message?.t === "typing") return; // never stored
    w.record({ message, failure, system: null, localKey: null });
    if (!conv || !message) return;
    let next = conv;
    if (message.t === "conversation" && message.name !== undefined) next = { ...next, name: message.name };
    if (message.t === "text" || message.t === "media") next = { ...next, lastActivityAt: event.createdAt };
    if (next !== conv) w.setConv(next);
    // A message from ANOTHER account was imported: tell its sender, throttled. Own instances' messages get no receipt.
    if ((message.t === "text" || message.t === "media") && event.senderAccountId !== ctx.accountId) {
      const conversationId = event.conversationId;
      w.after.push(() => ctx.messages.noteDelivered(conversationId));
    }
    if (message.t === "media") {
      const key = { blobId: message.blobId, conversationId: event.conversationId, key: message.key, nonce: message.nonce, sha256: message.sha256, mime: message.mime, size: message.size };
      w.batch.putJson("mediaKey", key.blobId, key);
      w.after.push(() => ctx.model.mediaKeys.set(key.blobId, key));
      if (message.thumbnail) {
        const t = message.thumbnail;
        const tk = { blobId: t.blobId, conversationId: event.conversationId, key: t.key, nonce: t.nonce, sha256: t.sha256, mime: "image/*", size: 0 };
        w.batch.putJson("mediaKey", tk.blobId, tk);
        w.after.push(() => ctx.model.mediaKeys.set(tk.blobId, tk));
      }
    }
  }
}

/** Internal: no group state for the conversation yet (welcome still to come). Queued like a future epoch. */
class NoStateYet extends Error {
  override readonly name = "NoStateYet";
  constructor() {
    super("no group state for this conversation yet");
  }
}
