/**
 * Conversations: creating a DM or a group (claim key packages for every
 * trusted instance of every member, create the MLS group, add them in the
 * initial commit, post it all in one request), adding and removing
 * members, leaving, naming (an E2EE `conversation` message), and the two
 * elector rules that run after every sync (`reconcile`):
 *
 * - Own devices: in each conversation where this instance is the lowest-id
 *   active leaf of its account, it adds any trusted active instance of the
 *   account that has no leaf — and, once per such instance, offers it this
 *   instance's history (`HistoryService.autoOffer`).
 * - Unreachable members: a member account may have NO leaf at all — it was
 *   invited before it installed Allo, or every device it had is gone. In
 *   each conversation where this instance is the lowest-id active leaf of
 *   the whole group, it looks such accounts up (at most once a minute per
 *   account, at once when the server nudges the conversation), claims key
 *   packages for their trusted active instances and commits the Add. Once
 *   the account holds one leaf, its own elector adds its further devices.
 */
import { createConversationResponseSchema, listConversationsResponseSchema, type ConversationSummary, type SubmitEventRequest } from "@allo/shared-types";
import type { Context } from "../context";
import { InvalidStateError, NotFoundError } from "../errors";
import type { ConversationRecord } from "../storage/records";
import type { ConversationView } from "../types";
import { base64Decode, base64Encode, randomBytes } from "../util/bytes";
import { uuidV7 } from "../util/ids";
import { describeError } from "../util/logger";

/** How long the elector waits before asking the server again about a member account that still has no reachable device. */
export const REACH_THROTTLE_MS = 60_000;
/**
 * A freshly installed device is listed before its key packages are up: an
 * attempt that found instances but claimed nothing retries this soon rather
 * than in a minute.
 */
export const REACH_RETRY_MS = 5_000;

export class ConversationsService {
  private views = new Map<string, ConversationView>();
  private listCache: ConversationView[] | null = null;
  private reconciling = false;
  /** `${conversationId}/${accountId}` → when the elector may look that account up again. */
  private readonly reachNextAt = new Map<string, number>();
  /** Keys whose last attempt was the quick retry: a second miss waits the full throttle, so a device that never uploads key packages is not polled every few seconds. */
  private readonly reachRetried = new Set<string>();
  /** Conversations the server nudged since the last reconcile: their lookups skip the throttle once. */
  private readonly nudged = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly ctx: Context) {}

  /** A `sync.nudge` named this conversation (the sync that follows runs `reconcile`). */
  noteNudge(conversationId: string): void {
    this.nudged.add(conversationId);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  // ---- views ---------------------------------------------------------------

  invalidate(conversationId?: string): void {
    if (conversationId) this.views.delete(conversationId);
    else this.views.clear();
    this.listCache = null;
    this.ctx.emitter.emit("conversations");
  }

  get(conversationId: string): ConversationView | undefined {
    const cached = this.views.get(conversationId);
    if (cached) return cached;
    const record = this.ctx.model.conversations.get(conversationId);
    if (!record) return undefined;
    const view = this.toView(record);
    this.views.set(conversationId, view);
    return view;
  }

  list(): ConversationView[] {
    if (!this.listCache) {
      this.listCache = [...this.ctx.model.conversations.keys()]
        .map((id) => this.get(id)!)
        .sort((a, b) => (a.lastActivityAt > b.lastActivityAt ? -1 : a.lastActivityAt < b.lastActivityAt ? 1 : 0));
    }
    return this.listCache;
  }

  private toView(record: ConversationRecord): ConversationView {
    const { ctx } = this;
    const state = ctx.groups.get(record.id);
    const timeline = ctx.messages.timeline(record.id);
    const lastMessage = [...timeline].reverse().find((i) => i.content.kind === "text" || i.content.kind === "media" || i.content.kind === "deleted");
    const me = record.members.find((m) => m.accountId === ctx.accountId);
    const joined = !!state && ctx.engine.isActive(state) && !record.removed;
    const memberAccountIds = record.members.filter((m) => m.state === "joined").map((m) => m.accountId);
    return {
      id: record.id,
      kind: record.kind,
      appId: record.appId,
      title: record.name,
      memberAccountIds,
      myRole: me?.role ?? "member",
      epoch: state ? ctx.engine.epochOf(state) : 0,
      joined,
      unreachableMemberAccountIds: this.unreachableMembersOf(record.id),
      lastMessage,
      unreadCount: ctx.messages.unreadCount(record.id),
      lastActivityAt: record.lastActivityAt,
      createdAt: record.createdAt,
    };
  }

  // ---- reachability --------------------------------------------------------

  /**
   * Joined member accounts other than mine with no active leaf in the group.
   * Computed from the record and the live MLS state, never from a cached
   * view, because the view itself and the timeline both ask.
   */
  unreachableMembersOf(conversationId: string): string[] {
    const { ctx } = this;
    const record = ctx.model.conversations.get(conversationId);
    const state = ctx.groups.get(conversationId);
    if (!record || !state) return [];
    const withLeaf = new Set(ctx.engine.membersOf(state).map((m) => m.accountId));
    return record.members.filter((m) => m.state === "joined" && m.accountId !== ctx.accountId && !withLeaf.has(m.accountId)).map((m) => m.accountId);
  }

  /**
   * True when the conversation has other joined members and NONE of them
   * can read what is sent now: the outbox holds application messages until
   * a leaf for one of them appears. A conversation everybody else has left
   * is not held; sending there is pointless but allowed, as before.
   */
  hasNoReachableMember(conversationId: string): boolean {
    const { ctx } = this;
    const record = ctx.model.conversations.get(conversationId);
    if (!record) return false;
    const others = record.members.filter((m) => m.state === "joined" && m.accountId !== ctx.accountId).length;
    return others > 0 && this.unreachableMembersOf(conversationId).length === others;
  }

  // ---- creation ------------------------------------------------------------

  createDirect(accountId: string): Promise<ConversationView> {
    if (accountId === this.ctx.accountId) throw new InvalidStateError("a dm needs another account");
    return this.create("dm", [accountId]);
  }

  createGroup(memberAccountIds: string[]): Promise<ConversationView> {
    const others = [...new Set(memberAccountIds)].filter((a) => a !== this.ctx.accountId);
    return this.create("group", others);
  }

  private async create(kind: "dm" | "group", others: string[]): Promise<ConversationView> {
    const { ctx } = this;
    ctx.instance.assertActive();
    // A member with no trusted active instance (never installed Allo, or every device gone) is still a member:
    // the server keeps the row, the group starts with whatever leaves exist (possibly only this one), and the
    // elector rule adds the account's first device when it appears. `initialCommit` only when there is a leaf to add.
    const targets = await this.trustedLeafTargets([ctx.accountId, ...others], new Set([ctx.instanceId]));
    const claimed = await ctx.instance.claimKeyPackages(targets.map((t) => t.instanceId));
    const groupId = randomBytes(16);
    const state = await ctx.engine.createGroup(ctx.identity, groupId);
    let initialCommit: SubmitEventRequest | undefined;
    let next = state;
    if (claimed.keyPackages.length > 0) {
      const result = await ctx.engine.commit(state, { addKeyPackages: claimed.keyPackages.map((k) => base64Decode(k.data)) });
      next = result.next;
      initialCommit = {
        idempotencyKey: uuidV7(ctx.now()),
        kind: "mls_commit",
        epoch: 0,
        payload: base64Encode(result.commit),
        commit: {
          newEpoch: 1,
          addedLeaves: result.added,
          removedLeaves: [],
          ...(result.welcome ? { welcome: { payload: base64Encode(result.welcome), recipients: claimed.keyPackages.map((k) => k.instanceId) } } : {}),
        },
      };
    }
    const res = await ctx.http.request({
      method: "POST",
      path: "/v1/conversations",
      body: { kind, mlsGroupId: base64Encode(groupId), memberAccountIds: others, idempotencyKey: uuidV7(ctx.now()), ...(initialCommit ? { initialCommit } : {}) },
      schema: createConversationResponseSchema,
      signer: ctx.signer,
    });
    const summary = res.conversation;
    if (!res.created) {
      // Another end created it first: our group is discarded; we are (or will be) added as a leaf by the elector of our account.
      ctx.log.info?.("conversation already existed", { conversationId: summary.id });
      await ctx.mutex.run(async () => {
        if (!ctx.model.conversations.get(summary.id)) await this.storeSummary(summary, null);
      });
      ctx.sync.request();
      return this.get(summary.id)!;
    }
    await ctx.mutex.run(async () => {
      const batch = ctx.store.batch();
      ctx.groups.stage(batch, summary.id, next);
      const record = this.recordFromSummary(summary, ctx.engine.epochOf(next));
      batch.putJson("conversation", record.id, record);
      await ctx.store.commit(batch);
      ctx.groups.commitInMemory(summary.id, next);
      ctx.model.conversations.set(record.id, record);
    });
    if (claimed.missing.length) ctx.log.info?.("instances with no key packages were not added", { count: claimed.missing.length });
    // The accounts just looked up and found without a device need not be asked again by the next reconcile.
    const reached = new Set(targets.map((t) => t.accountId));
    for (const accountId of others) if (!reached.has(accountId)) this.reachNextAt.set(`${summary.id}/${accountId}`, ctx.now() + REACH_THROTTLE_MS);
    this.invalidate(summary.id);
    return this.get(summary.id)!;
  }

  private recordFromSummary(summary: ConversationSummary, joinedEpoch: number | null): ConversationRecord {
    const existing = this.ctx.model.conversations.get(summary.id);
    return {
      id: summary.id,
      kind: summary.kind,
      appId: summary.appId,
      mlsGroupId: summary.mlsGroupId,
      createdByAccountId: summary.createdByAccountId,
      createdAt: summary.createdAt,
      name: existing?.name ?? null,
      members: summary.members.map((m) => ({ accountId: m.accountId, role: m.role, state: m.state })),
      lastSeq: existing?.lastSeq ?? summary.lastSeq,
      joinedEpoch: joinedEpoch ?? existing?.joinedEpoch ?? null,
      lastReadSeq: existing?.lastReadSeq ?? 0,
      removed: existing?.removed ?? false,
      lastActivityAt: existing?.lastActivityAt ?? summary.createdAt,
    };
  }

  private async storeSummary(summary: ConversationSummary, joinedEpoch: number | null): Promise<void> {
    const record = this.recordFromSummary(summary, joinedEpoch);
    await this.ctx.store.putJson("conversation", record.id, record);
    this.ctx.model.conversations.set(record.id, record);
    this.invalidate(record.id);
  }

  /** Trusted, active instances of the given accounts, minus `exclude`. Refused ones are logged, never added; an account with none contributes nothing. */
  private async trustedLeafTargets(accountIds: string[], exclude: Set<string>): Promise<Array<{ instanceId: string; accountId: string }>> {
    const out: Array<{ instanceId: string; accountId: string }> = [];
    for (const accountId of accountIds) {
      const { trusted, refused } = await this.ctx.instance.trustedInstancesOf(accountId);
      if (refused.size) this.ctx.log.warn?.("instances refused by the approval chain", { accountId, count: refused.size });
      for (const i of trusted) if (!exclude.has(i.id)) out.push({ instanceId: i.id, accountId: i.accountId });
    }
    return out;
  }

  // ---- membership ----------------------------------------------------------

  async addMember(conversationId: string, accountId: string): Promise<void> {
    const { ctx } = this;
    ctx.instance.assertActive();
    const state = this.requireState(conversationId);
    const present = new Set(ctx.engine.membersOf(state).map((m) => m.instanceId));
    const targets = (await this.trustedLeafTargets([accountId], present)).filter((t) => !present.has(t.instanceId));
    if (targets.length === 0) throw new InvalidStateError("no trusted instance of that account can be added");
    const claimed = await ctx.instance.claimKeyPackages(targets.map((t) => t.instanceId));
    if (claimed.keyPackages.length === 0) throw new InvalidStateError("that account has no key packages available");
    await ctx.outbox.enqueueCommit(conversationId, {
      adds: claimed.keyPackages.map((k) => ({ instanceId: k.instanceId, accountId, keyPackage: k.data })),
      removes: [],
      reason: "add_member",
    });
  }

  async removeMember(conversationId: string, accountId: string): Promise<void> {
    const { ctx } = this;
    ctx.instance.assertActive();
    const state = this.requireState(conversationId);
    const leaves = ctx.engine.membersOf(state).filter((m) => m.accountId === accountId);
    if (leaves.length === 0) throw new NotFoundError(`member ${accountId}`);
    await ctx.outbox.enqueueCommit(conversationId, { adds: [], removes: leaves.map((m) => m.instanceId), reason: "remove_member" });
  }

  /** Leaves server-side; the other members' elector removes this account's leaves on the `member_left` control. */
  async leave(conversationId: string): Promise<void> {
    const { ctx } = this;
    ctx.instance.assertActive();
    const record = ctx.model.conversations.get(conversationId);
    if (!record) throw new NotFoundError(`conversation ${conversationId}`);
    await ctx.http.request({ method: "POST", path: `/v1/conversations/${conversationId}/leave`, signer: ctx.signer });
    const next: ConversationRecord = {
      ...record,
      removed: true,
      members: record.members.map((m) => (m.accountId === ctx.accountId ? { ...m, state: "left" as const } : m)),
    };
    await ctx.store.putJson("conversation", next.id, next);
    ctx.model.conversations.set(next.id, next);
    this.invalidate(conversationId);
  }

  async rename(conversationId: string, name: string): Promise<void> {
    const { ctx } = this;
    this.requireState(conversationId);
    await ctx.outbox.enqueueMessage(conversationId, { v: 1, t: "conversation", name });
    const record = ctx.model.conversations.get(conversationId)!;
    const next = { ...record, name };
    await ctx.store.putJson("conversation", next.id, next);
    ctx.model.conversations.set(next.id, next);
    this.invalidate(conversationId);
  }

  private requireState(conversationId: string) {
    const state = this.ctx.groups.get(conversationId);
    const record = this.ctx.model.conversations.get(conversationId);
    if (!state || !record) throw new NotFoundError(`conversation ${conversationId}`);
    if (!this.ctx.engine.isActive(state) || record.removed) throw new InvalidStateError("this instance is no longer in the conversation");
    return state;
  }

  // ---- server reconciliation ----------------------------------------------

  /** Pulls the server's list: membership changes we missed, and conversations we are in without a leaf. */
  async refreshFromServer(): Promise<void> {
    const { ctx } = this;
    if (!ctx.instance.isActive) return;
    const res = await ctx.http.request({ method: "GET", path: "/v1/conversations", schema: listConversationsResponseSchema, signer: ctx.signer });
    await ctx.mutex.run(async () => {
      for (const summary of res.conversations) {
        const existing = ctx.model.conversations.get(summary.id);
        if (!existing) {
          await this.storeSummary(summary, null);
          continue;
        }
        const members = summary.members.map((m) => ({ accountId: m.accountId, role: m.role, state: m.state }));
        if (JSON.stringify(members) !== JSON.stringify(existing.members)) {
          const next = { ...existing, members };
          await ctx.store.putJson("conversation", next.id, next);
          ctx.model.conversations.set(next.id, next);
          ctx.messages.invalidate(next.id); // the hold on pending echoes follows the member rows
          this.invalidate(next.id);
        }
      }
    });
  }

  /** The elector rules for adds. Runs after each sync; cheap when there is nothing to do. */
  async reconcile(): Promise<void> {
    const { ctx } = this;
    if (this.reconciling || !ctx.instance.isActive) return;
    this.reconciling = true;
    let retrySoon = false;
    try {
      const own = ctx.instance.trustedOwnInstances().trusted.filter((i) => i.status === "active" && i.id !== ctx.instanceId);
      /** Own instances that share, or are being given, a leaf in a conversation this instance is the elector of. */
      const electorFor = new Set<string>();
      for (const conversationId of ctx.groups.ids()) {
        const state = ctx.groups.get(conversationId)!;
        const record = ctx.model.conversations.get(conversationId);
        if (!record || !ctx.engine.isActive(state) || record.removed) continue;
        const members = ctx.engine.membersOf(state);
        const present = new Set(members.map((m) => m.instanceId));
        const pendingAdds = ctx.model
          .outboxItems(conversationId)
          .filter((i) => i.kind === "commit" && i.state === "pending")
          .flatMap((i) => i.commit?.adds ?? []);
        const pendingInstances = new Set(pendingAdds.map((a) => a.instanceId));
        const pendingAccounts = new Set(pendingAdds.map((a) => a.accountId));
        const nudged = this.nudged.delete(conversationId);

        // Rule 1, own devices: the lowest-id leaf of MY account adds my other trusted instances.
        const ownLeaves = members.filter((m) => m.accountId === ctx.accountId).map((m) => m.instanceId).sort();
        if (own.length && ownLeaves[0] === ctx.instanceId) {
          for (const i of own) if (present.has(i.id) || pendingInstances.has(i.id)) electorFor.add(i.id);
          const missing = own.filter((i) => !present.has(i.id) && !pendingInstances.has(i.id));
          if (missing.length) {
            for (const i of missing) electorFor.add(i.id);
            try {
              const claimed = await ctx.instance.claimKeyPackages(missing.map((i) => i.id));
              if (claimed.keyPackages.length) {
                await ctx.outbox.enqueueCommit(conversationId, {
                  adds: claimed.keyPackages.map((k) => ({ instanceId: k.instanceId, accountId: ctx.accountId, keyPackage: k.data })),
                  removes: [],
                  reason: "add_instances",
                });
              }
            } catch (error) {
              ctx.log.warn?.("could not add own instances", { conversationId, error: describeError(error) });
            }
          }
        }

        // Rule 2, unreachable members: the lowest-id leaf of the WHOLE group adds the first device of any
        // joined account that has none. Throttled per account; a nudge naming the conversation skips the throttle.
        if (members.map((m) => m.instanceId).sort()[0] !== ctx.instanceId) continue;
        const now = ctx.now();
        for (const accountId of this.unreachableMembersOf(conversationId)) {
          if (pendingAccounts.has(accountId)) continue;
          const key = `${conversationId}/${accountId}`;
          const nextAt = this.reachNextAt.get(key);
          if (!nudged && nextAt !== undefined && now < nextAt) continue;
          this.reachNextAt.set(key, now + REACH_THROTTLE_MS);
          if (nudged) this.reachRetried.delete(key);
          try {
            const { trusted, refused } = await ctx.instance.trustedInstancesOf(accountId);
            if (refused.size) ctx.log.warn?.("instances refused by the approval chain", { accountId, count: refused.size });
            const targets = trusted.filter((i) => !present.has(i.id));
            if (targets.length === 0) continue;
            const claimed = await ctx.instance.claimKeyPackages(targets.map((i) => i.id));
            if (claimed.keyPackages.length === 0) {
              // Listed, but its key packages are not up yet (it registered moments ago): ask again soon, once.
              if (!this.reachRetried.has(key)) {
                this.reachRetried.add(key);
                this.reachNextAt.set(key, now + REACH_RETRY_MS);
                retrySoon = true;
              }
              continue;
            }
            this.reachRetried.delete(key);
            await ctx.outbox.enqueueCommit(conversationId, {
              adds: claimed.keyPackages.map((k) => ({ instanceId: k.instanceId, accountId, keyPackage: k.data })),
              removes: [],
              reason: "reach_member",
            });
          } catch (error) {
            ctx.log.warn?.("could not reach a member's devices", { conversationId, accountId, error: describeError(error) });
          }
        }
      }
      // Not awaited: exporting and uploading an archive must not hold the sync loop; autoOffer never throws and dedupes.
      if (electorFor.size) void ctx.history.autoOffer([...electorFor]);
    } finally {
      this.reconciling = false;
    }
    if (retrySoon) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconcile().catch((error) => this.ctx.log.debug?.("reconcile retry failed", { error: describeError(error) }));
    }, REACH_RETRY_MS);
  }
}
