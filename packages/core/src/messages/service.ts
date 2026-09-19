/**
 * Messages: the per-conversation timeline (projection over stored events
 * plus local echoes), sending text, edits, deletes, reactions, read and
 * delivery receipts (each at most one every 5 s per conversation), typing
 * over the socket (encrypted, never stored), and unread counts.
 */
import { decodeAppMessage, encodeAppMessage, type AppMessage, type EventRef } from "@allo/shared-types";
import { Model } from "../storage/model";
import type { Context } from "../context";
import { InvalidStateError, NotFoundError } from "../errors";
import type { ContactDraft, LoadOlderResult, PlaceDraft, PollDraft, SendOptions, TimelineItemView } from "../types";
import { base64Decode, base64Encode } from "../util/bytes";
import { describeError } from "../util/logger";
import { project } from "./projection";

const READ_THROTTLE_MS = 5000;
const DELIVERED_THROTTLE_MS = 5000;
const TYPING_TTL_MS = 6000;

export class MessagesService {
  private timelines = new Map<string, TimelineItemView[]>();
  private readSentAt = new Map<string, number>();
  private readTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private deliveredSentAt = new Map<string, number>();
  private deliveredTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private typing = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

  constructor(private readonly ctx: Context) {}

  invalidate(conversationId: string): void {
    this.timelines.delete(conversationId);
    this.ctx.emitter.emit(`timeline:${conversationId}`);
  }

  stop(): void {
    for (const t of this.readTimers.values()) clearTimeout(t);
    this.readTimers.clear();
    for (const t of this.deliveredTimers.values()) clearTimeout(t);
    this.deliveredTimers.clear();
    for (const m of this.typing.values()) for (const t of m.values()) clearTimeout(t);
    this.typing.clear();
  }

  timeline(conversationId: string): TimelineItemView[] {
    const cached = this.timelines.get(conversationId);
    if (cached) return cached;
    const { ctx } = this;
    const items = project({
      conversationId,
      events: ctx.model.eventsOf(conversationId),
      outbox: ctx.model.outboxItems(conversationId),
      accountId: ctx.accountId,
      instanceId: ctx.instanceId,
      ...(ctx.conversations.hasNoReachableMember(conversationId) ? { holdReason: "no_reachable_member" as const } : {}),
      stalledItemIds: ctx.outbox.stalledItemIds(conversationId),
    });
    this.timelines.set(conversationId, items);
    return items;
  }

  unreadCount(conversationId: string): number {
    const record = this.ctx.model.conversations.get(conversationId);
    if (!record) return 0;
    return this.timeline(conversationId).filter(
      (i) => !i.isOwn && i.seq !== null && i.seq > record.lastReadSeq && (i.content.kind === "text" || i.content.kind === "media"),
    ).length;
  }

  async send(conversationId: string, text: string, options: SendOptions = {}): Promise<string> {
    const message: AppMessage = { v: 1, t: "text", body: text, ...(options.replyTo ? { replyTo: this.refFor(conversationId, options.replyTo) } : {}) };
    const item = await this.ctx.outbox.enqueueMessage(conversationId, message);
    return item.id;
  }

  async edit(conversationId: string, targetId: string, body: string): Promise<void> {
    const target = this.find(conversationId, targetId);
    if (!target.isOwn) throw new InvalidStateError("only own messages can be edited");
    await this.ctx.outbox.enqueueMessage(conversationId, { v: 1, t: "edit", target: this.refFor(conversationId, targetId), body });
  }

  async remove(conversationId: string, targetId: string): Promise<void> {
    const target = this.find(conversationId, targetId);
    if (!target.isOwn) throw new InvalidStateError("only own messages can be deleted");
    await this.ctx.outbox.enqueueMessage(conversationId, { v: 1, t: "delete", target: this.refFor(conversationId, targetId) });
  }

  /**
   * A poll. The option ids are the sender's to choose and travel with the
   * question, so a vote names an id rather than a position: an option list a
   * later version reorders still counts the votes already cast.
   */
  async sendPoll(conversationId: string, poll: PollDraft): Promise<string> {
    const options = poll.options.map((label, index) => ({ id: `o${index + 1}`, label }));
    const message: AppMessage = {
      v: 1,
      t: "poll",
      question: poll.question,
      options,
      multiple: poll.multiple ?? false,
      anonymous: poll.anonymous ?? false,
    };
    const item = await this.ctx.outbox.enqueueMessage(conversationId, message);
    return item.id;
  }

  /**
   * This account's answer to a poll, which REPLACES the one before it; an
   * empty list retracts. Anything that is not an option of that poll is
   * refused here rather than dropped silently by every receiver.
   */
  async vote(conversationId: string, targetId: string, optionIds: readonly string[]): Promise<void> {
    const target = this.find(conversationId, targetId);
    if (target.content.kind !== "poll") throw new InvalidStateError("not a poll");
    const chosen = [...new Set(optionIds)];
    const known = new Set(target.content.poll.options.map((o) => o.id));
    if (chosen.some((id) => !known.has(id))) throw new InvalidStateError("unknown poll option");
    if (chosen.length > 1 && !target.content.poll.multiple) throw new InvalidStateError("this poll takes one answer");
    await this.ctx.outbox.enqueueMessage(conversationId, {
      v: 1,
      t: "poll_vote",
      target: this.refFor(conversationId, targetId),
      optionIds: chosen,
    });
  }

  /** A place. Nothing is resolved or fetched here: the coordinates are the sender's. */
  async sendLocation(conversationId: string, place: PlaceDraft): Promise<string> {
    const item = await this.ctx.outbox.enqueueMessage(conversationId, {
      v: 1,
      t: "location",
      latitude: place.latitude,
      longitude: place.longitude,
      ...(place.label ? { label: place.label } : {}),
      ...(place.address ? { address: place.address } : {}),
    });
    return item.id;
  }

  /** Somebody's card. */
  async sendContact(conversationId: string, contact: ContactDraft): Promise<string> {
    const item = await this.ctx.outbox.enqueueMessage(conversationId, {
      v: 1,
      t: "contact",
      name: contact.name,
      ...(contact.accountId ? { accountId: contact.accountId } : {}),
      ...(contact.handle ? { handle: contact.handle } : {}),
      ...(contact.phone ? { phone: contact.phone } : {}),
    });
    return item.id;
  }

  /**
   * Pins a message for everybody, or takes the pin off. A control message:
   * the last op per target wins, so two devices doing this at once agree.
   */
  async setPinned(conversationId: string, targetId: string, pinned: boolean): Promise<void> {
    this.find(conversationId, targetId);
    await this.ctx.outbox.enqueueMessage(conversationId, {
      v: 1,
      t: "pin",
      target: this.refFor(conversationId, targetId),
      op: pinned ? "pin" : "unpin",
    });
  }

  /** Toggles this account's reaction `key` on the target. */
  async react(conversationId: string, targetId: string, key: string): Promise<void> {
    const target = this.find(conversationId, targetId);
    const mine = target.reactions.find((r) => r.key === key)?.accountIds.includes(this.ctx.accountId) ?? false;
    await this.ctx.outbox.enqueueMessage(conversationId, { v: 1, t: "reaction", target: this.refFor(conversationId, targetId), key, op: mine ? "remove" : "add" });
  }

  /**
   * DELETE this conversation's history on this device, and optionally ask
   * everybody else in it to do the same.
   *
   * The local half is a real delete: the event rows go, not a filter over
   * them. `clearedUpToSeq` keeps the line so a conversation with nothing newer
   * stays out of the list and comes back the moment somebody speaks.
   *
   * The remote half is a REQUEST and the screen that offers it says so. In an
   * end-to-end encrypted system the other copy sits on the other person's
   * device under keys only they hold; `clear_history` asks their app, and
   * their app obeys. Nothing here can reach in and make it true.
   */
  async clearHistory(conversationId: string, options: { forEveryone?: boolean } = {}): Promise<void> {
    const { ctx } = this;
    const record = ctx.model.conversations.get(conversationId);
    if (!record) throw new NotFoundError(`conversation ${conversationId}`);
    // Sent BEFORE the local wipe: the outbox item is one more event in this
    // conversation, and it must not be caught by the line it is asking for.
    if (options.forEveryone) await ctx.outbox.enqueueMessage(conversationId, { v: 1, t: "clear_history", ctl: true });
    await this.applyClear(conversationId, record.lastSeq);
  }

  /**
   * Drops everything at or below `seq` and remembers the line.
   *
   * Called by {@link clearHistory} for this device and by the sync dispatcher
   * when a `clear_history` arrives — from the other person, or from another of
   * this account's own devices, which is why there is no sender check.
   * Idempotent: a lower line never undoes a higher one.
   */
  async applyClear(conversationId: string, seq: number): Promise<void> {
    const { ctx } = this;
    const record = ctx.model.conversations.get(conversationId);
    if (!record) return;
    if ((record.clearedUpToSeq ?? -1) >= seq) return;
    const dropped = ctx.model.dropEventsUpTo(conversationId, seq);
    const next = { ...record, clearedUpToSeq: seq };
    const batch = ctx.store.batch();
    for (const event of dropped) batch.delete("event", Model.eventId(event));
    batch.putJson("conversation", next.id, next);
    await ctx.store.commit(batch);
    ctx.model.conversations.set(next.id, next);
    this.invalidate(conversationId);
    ctx.conversations.invalidate(conversationId);
    ctx.log.info?.("conversation history deleted on this device", { conversationId, events: dropped.length });
  }

  /** Marks everything read locally now; sends a `read` receipt at most once per 5 s per conversation. */
  async markRead(conversationId: string): Promise<void> {
    const { ctx } = this;
    const record = ctx.model.conversations.get(conversationId);
    if (!record) throw new NotFoundError(`conversation ${conversationId}`);
    const last = [...this.timeline(conversationId)].reverse().find((i) => !i.isOwn && i.seq !== null && (i.content.kind === "text" || i.content.kind === "media"));
    if (!last || last.seq === null || last.seq <= record.lastReadSeq) return;
    const next = { ...record, lastReadSeq: last.seq };
    await ctx.store.putJson("conversation", next.id, next);
    ctx.model.conversations.set(next.id, next);
    ctx.conversations.invalidate(conversationId);
    const sendReceipt = async () => {
      this.readSentAt.set(conversationId, ctx.now());
      const latest = ctx.model.conversations.get(conversationId);
      const target = [...this.timeline(conversationId)].reverse().find((i) => !i.isOwn && i.seq !== null && i.seq <= (latest?.lastReadSeq ?? 0));
      if (!target) return;
      try {
        await ctx.outbox.enqueueMessage(conversationId, { v: 1, t: "read", upTo: { kind: "event", conversationId, eventId: target.id } });
      } catch (error) {
        ctx.log.debug?.("read receipt not sent", { error: describeError(error) });
      }
    };
    const since = ctx.now() - (this.readSentAt.get(conversationId) ?? -Infinity);
    if (since >= READ_THROTTLE_MS) {
      if (this.readTimers.has(conversationId)) return; // a trailing send is already scheduled
      await sendReceipt();
    } else if (!this.readTimers.has(conversationId)) {
      this.readTimers.set(
        conversationId,
        setTimeout(() => {
          this.readTimers.delete(conversationId);
          void sendReceipt();
        }, READ_THROTTLE_MS - since),
      );
    }
  }

  /**
   * Another account's message landed: queue a `delivered` receipt naming the
   * newest other-account item, at most one per 5 s per conversation (a burst
   * of deliveries becomes one trailing receipt). Never throws.
   */
  noteDelivered(conversationId: string): void {
    const { ctx } = this;
    if (!ctx.instance.isActive) return;
    const send = async () => {
      this.deliveredSentAt.set(conversationId, ctx.now());
      // Read the model, not the projection: this runs from the dispatcher's after-hooks, before the timeline cache is invalidated.
      const target = [...ctx.model.eventsOf(conversationId)]
        .reverse()
        .find((e) => e.senderAccountId !== ctx.accountId && e.message !== null && (e.message.t === "text" || e.message.t === "media"));
      if (!target) return;
      try {
        await ctx.outbox.enqueueMessage(conversationId, { v: 1, t: "delivered", upTo: { kind: "event", conversationId, eventId: target.id } });
      } catch (error) {
        ctx.log.debug?.("delivery receipt not sent", { error: describeError(error) });
      }
    };
    const since = ctx.now() - (this.deliveredSentAt.get(conversationId) ?? -Infinity);
    if (since >= DELIVERED_THROTTLE_MS) {
      if (this.deliveredTimers.has(conversationId)) return;
      void send();
    } else if (!this.deliveredTimers.has(conversationId)) {
      this.deliveredTimers.set(
        conversationId,
        setTimeout(() => {
          this.deliveredTimers.delete(conversationId);
          void send();
        }, DELIVERED_THROTTLE_MS - since),
      );
    }
  }

  /** Encrypts a `typing` message with the group state and emits it over the socket. Never stored. */
  async setTyping(conversationId: string, on: boolean): Promise<void> {
    const { ctx } = this;
    if (!ctx.realtime.connected) return;
    const record = ctx.model.conversations.get(conversationId);
    const state = ctx.groups.get(conversationId);
    if (!state || !ctx.engine.isActive(state) || record?.removed) return;
    const ciphertext = await ctx.mutex.run(async () => {
      const live = ctx.groups.get(conversationId)!;
      const { ciphertext, next } = await ctx.engine.encryptApplication(live, encodeAppMessage({ v: 1, t: "typing", on }));
      const batch = ctx.store.batch();
      ctx.groups.stage(batch, conversationId, next);
      await ctx.store.commit(batch);
      ctx.groups.commitInMemory(conversationId, next);
      return ciphertext;
    });
    ctx.realtime.emitTyping(conversationId, base64Encode(ciphertext));
  }

  /** A relayed typing message from the socket. */
  async onTyping(conversationId: string, ciphertextB64: string): Promise<void> {
    const { ctx } = this;
    const state = ctx.groups.get(conversationId);
    if (!state || !ctx.engine.isActive(state)) return;
    let message: AppMessage | undefined;
    let sender: string | undefined;
    try {
      await ctx.mutex.run(async () => {
        const live = ctx.groups.get(conversationId)!;
        const result = await ctx.engine.processIncoming(live, base64Decode(ciphertextB64));
        const batch = ctx.store.batch();
        ctx.groups.stage(batch, conversationId, result.next);
        await ctx.store.commit(batch);
        ctx.groups.commitInMemory(conversationId, result.next);
        if (result.kind === "application" && result.plaintext) message = decodeAppMessage(result.plaintext);
      });
    } catch (error) {
      ctx.log.debug?.("typing message rejected", { error: describeError(error) });
      return;
    }
    if (!message || message.t !== "typing") return;
    // The sender is not in the plaintext; the socket relay does not name it either. The leaf that signed it is
    // known to MLS but not surfaced by the port, so typing is attributed to "someone" per conversation.
    sender = "*";
    let m = this.typing.get(conversationId);
    if (!m) {
      m = new Map();
      this.typing.set(conversationId, m);
    }
    const existing = m.get(sender);
    if (existing) clearTimeout(existing);
    if (message.on) {
      m.set(
        sender,
        setTimeout(() => {
          m?.delete(sender!);
          ctx.emitter.emit(`typing:${conversationId}`);
        }, TYPING_TTL_MS),
      );
    } else m.delete(sender);
    ctx.emitter.emit(`typing:${conversationId}`);
  }

  /** True when another member is typing. (Per-account attribution needs the sender leaf; see `onTyping`.) */
  isTyping(conversationId: string): boolean {
    return (this.typing.get(conversationId)?.size ?? 0) > 0;
  }

  /** Older items come from the local store only: ciphertext before this leaf's join epoch is not decryptable. */
  async loadOlder(conversationId: string, before?: string, limit = 50): Promise<LoadOlderResult> {
    const all = this.timeline(conversationId);
    const idx = before ? all.findIndex((i) => i.id === before || i.localKey === before) : all.length;
    const end = idx < 0 ? all.length : idx;
    const start = Math.max(0, end - limit);
    return { items: all.slice(start, end), reachedStart: start === 0 };
  }

  private find(conversationId: string, id: string): TimelineItemView {
    const item = this.timeline(conversationId).find((i) => i.id === id || i.localKey === id);
    if (!item) throw new NotFoundError(`message ${id}`);
    return item;
  }

  private refFor(conversationId: string, id: string): EventRef {
    const item = this.find(conversationId, id);
    if (item.seq !== null) return { kind: "event", conversationId, eventId: item.id };
    return { kind: "local", conversationId, idempotencyKey: item.localKey ?? item.id };
  }
}
