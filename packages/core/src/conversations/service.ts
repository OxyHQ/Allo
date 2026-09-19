/**
 * Conversations: creating a DM or a group (claim key packages for every
 * trusted instance of every member, create the MLS group, add them in the
 * initial commit, post it all in one request), adding and removing
 * members, leaving, naming (an E2EE `conversation` message), and the rules
 * that run after every sync (`reconcile`), in this order:
 *
 * - Self-join: in each conversation where this instance's account is a joined
 *   member and this instance holds no active leaf, it fetches the stored
 *   GroupInfo and joins by MLS external commit (`kind: 'external'`), with
 *   nobody else online. A device that lost its group state while the server
 *   still lists its leaf active replaces that leaf the same way
 *   (`kind: 'resync'`). No GroupInfo for the current epoch (a conversation
 *   whose last commit predates the field) means waiting for an elector below,
 *   and `ConversationView.joinState` says which of the two is happening.
 * - Re-publish: once per conversation per session, a member checks that the
 *   server holds a GroupInfo for its current epoch and `PUT`s its own when
 *   not, so old conversations become joinable.
 *
 * The two elector rules are the fallback:
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
import {
  conversationResponseSchema,
  createConversationResponseSchema,
  groupInfoResponseSchema,
  listConversationsResponseSchema,
  resetConversationResponseSchema,
  submitEventResponseSchema,
  type ConversationSummary,
  type StoredGroupInfo,
  type SubmitEventRequest,
} from "@allo/shared-types";
import type { Context } from "../context";
import type { GroupState } from "../crypto/engine";
import { EpochConflictError, InvalidStateError, NotFoundError, TransportError } from "../errors";
import { Model } from "../storage/model";
import type { ConversationRecord, EventRecord } from "../storage/records";
import type { ConversationView, TimelineContent } from "../types";
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
/** External commits a joiner posts per conversation per sync before giving the epoch race up until the next sync. */
export const MAX_JOIN_ATTEMPTS = 3;
/** Conversations whose stored GroupInfo one reconcile checks (and re-publishes), so a large account does not burst at start. */
export const REPUBLISH_BATCH = 20;

type JoinStatus = "joining" | "waiting_for_member";

/**
 * What a conversation's `lastMessage` may be: everything somebody SENT, which
 * is every kind but the two a list row cannot speak for — an item this device
 * could not decrypt, and a system note the app writes itself. A new message
 * kind belongs here, or the row keeps showing the one before it.
 */
const LAST_MESSAGE_KINDS = new Set<TimelineContent["kind"]>([
  "text",
  "media",
  "poll",
  "location",
  "contact",
  "call",
  "deleted",
]);

export class ConversationsService {
  private views = new Map<string, ConversationView>();
  private listCache: ConversationView[] | null = null;
  private reconciling = false;
  /** Conversations a revive has been attempted for, so a permanent failure is not retried every refresh. */
  private readonly reviving = new Set<string>();
  /** DMs a re-key has been attempted for, so a refusal is asked once rather than every sync. */
  private readonly rekeyTried = new Set<string>();
  /** `${conversationId}/${accountId}` → when the elector may look that account up again. */
  private readonly reachNextAt = new Map<string, number>();
  /** Keys whose last attempt was the quick retry: a second miss waits the full throttle, so a device that never uploads key packages is not polled every few seconds. */
  private readonly reachRetried = new Set<string>();
  /** Conversations the server nudged since the last reconcile: their lookups skip the throttle once. */
  private readonly nudged = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** What the self-join rule last learnt about a conversation this instance has no leaf in. */
  private readonly joinStatus = new Map<string, JoinStatus>();
  /** Conversations whose stored GroupInfo this session has checked; re-published when the server held none. */
  private readonly groupInfoChecked = new Set<string>();
  /**
   * Conversations seen once as "the server lists my leaf active, I hold no state". A resync runs on the
   * SECOND sighting, after one more sync pass drained the delivery stream: a Welcome for a leaf an elector
   * just added would otherwise be raced by a needless resync.
   */
  private readonly resyncSeen = new Set<string>();

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

  /**
   * The conversations to show.
   *
   * A conversation deleted on this device stays out until somebody says
   * something in it: `clearedUpToSeq` is the line that was deleted, so it
   * reappears the moment `lastSeq` moves past it. It is never dropped from
   * storage — the membership is the server's, and a returning message has to
   * find a conversation to land in.
   */
  list(): ConversationView[] {
    if (!this.listCache) {
      this.listCache = [...this.ctx.model.conversations.values()]
        .filter((record) => record.clearedUpToSeq === undefined || record.lastSeq > record.clearedUpToSeq)
        .map((record) => this.get(record.id)!)
        .sort((a, b) => (a.lastActivityAt > b.lastActivityAt ? -1 : a.lastActivityAt < b.lastActivityAt ? 1 : 0));
    }
    return this.listCache;
  }

  private toView(record: ConversationRecord): ConversationView {
    const { ctx } = this;
    const state = ctx.groups.get(record.id);
    const timeline = ctx.messages.timeline(record.id);
    const lastMessage = [...timeline].reverse().find((i) => LAST_MESSAGE_KINDS.has(i.content.kind));
    const me = record.members.find((m) => m.accountId === ctx.accountId);
    const joined = !!state && ctx.engine.isActive(state) && !record.removed;
    const memberAccountIds = record.members.filter((m) => m.state === "joined").map((m) => m.accountId);
    const joinState: ConversationView["joinState"] = joined
      ? "joined"
      : (this.joinStatus.get(record.id) ?? (me?.state === "joined" && !record.removed ? "joining" : "waiting_for_member"));
    return {
      id: record.id,
      kind: record.kind,
      appId: record.appId,
      title: record.name,
      memberAccountIds,
      myRole: me?.role ?? "member",
      epoch: state ? ctx.engine.epochOf(state) : 0,
      joined,
      joinState,
      integrity: record.refusedCommit ? "refused_commit" : "ok",
      ...(record.refusedCommit ? { refusedEpoch: record.refusedCommit.epoch, refusalReason: record.refusedCommit.reason } : {}),
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
          kind: "member",
          addedLeaves: result.added,
          removedLeaves: [],
          ...(result.welcome ? { welcome: { payload: base64Encode(result.welcome), recipients: claimed.keyPackages.map((k) => k.instanceId) } } : {}),
          groupInfo: base64Encode(result.groupInfo),
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
    // The initial commit carried the GroupInfo of epoch 1. Without one the group sits at epoch 0 with no commit
    // to carry it, so the creator publishes it now: the member's first device, or its own next one, joins from it.
    if (initialCommit) this.groupInfoChecked.add(summary.id);
    else await this.publishGroupInfo(summary.id, next);
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
      refusedCommit: existing?.refusedCommit ?? null,
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
    /**
     * Conversations whose MLS group has lost EVERY active leaf.
     *
     * Nothing can be committed to such a group again, so nobody can add this
     * device to it and nobody ever will — and a DM converges on its `dm_key`,
     * so there is no second conversation to start instead. Left alone it is a
     * person you can never message again. The condition is the same one the
     * server enforces on `/reset`, so a race with somebody else reviving it
     * just loses and is picked up by the next refresh.
     */
    const dead = res.conversations.filter(
      (summary) =>
        summary.myLeafState !== "active" &&
        summary.leaves.every((leaf) => leaf.state !== "active") &&
        summary.members.some((m) => m.accountId === ctx.accountId && m.state === "joined"),
    );
    /** Conversations whose group was replaced under us; dropped after the pass, then rejoined. */
    const stale: string[] = [];
    await ctx.mutex.run(async () => {
      for (const summary of res.conversations) {
        const existing = ctx.model.conversations.get(summary.id);
        if (!existing) {
          await this.storeSummary(summary, null);
          continue;
        }
        /**
         * OUR GROUP IS NOT THIS CONVERSATION'S ANY MORE.
         *
         * A re-key (`mayRekeyDirect`) replaces the MLS group under a
         * conversation. A device that was offline keeps the old state, and if
         * it also missed or ignored the Welcome it would go on encrypting for
         * a group nobody else is in — messages sent into a room of one, and
         * nothing saying so. The group id is the check, and dropping the stale
         * state is the repair: the join path then lets this device back in
         * from the new group's GroupInfo, which the re-key published.
         */
        const state = ctx.groups.get(summary.id);
        if (state && summary.mlsGroupId !== base64Encode(ctx.engine.groupIdOf(state))) {
          ctx.log.warn?.("this conversation's group was replaced; dropping the stale state and rejoining", {
            conversationId: summary.id,
          });
          stale.push(summary.id);
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
    // The stale ones lose their group state; the join path takes it from there,
    // letting this device back in from the new group's GroupInfo.
    for (const conversationId of stale) {
      await ctx.mutex.run(async () => {
        const batch = ctx.store.batch();
        ctx.groups.drop(batch, conversationId);
        await ctx.store.commit(batch);
      });
      this.joinStatus.delete(conversationId);
      this.rekeyTried.delete(conversationId);
      this.invalidate(conversationId);
    }
    if (stale.length) await this.reconcile();
    for (const summary of dead) {
      if (this.reviving.has(summary.id)) continue;
      this.reviving.add(summary.id);
      try {
        await this.revive(summary.id);
      } catch (error) {
        ctx.log.warn?.("could not revive a conversation with no live device", { conversationId: summary.id, error: describeError(error) });
      }
    }
  }

  /**
   * Rebuild the MLS group under a conversation that has lost every active
   * leaf, keeping the conversation itself.
   *
   * This is `create` again, with two differences: the conversation row already
   * exists, so its id, its members and its `dm_key` are kept; and the server
   * refuses unless the old group is provably dead, which is what stops it
   * being a way into a live conversation.
   *
   * Everything sent before stays unreadable. It already was: no one holds the
   * keys, and neither a history transfer nor a backup carries MLS state, so a
   * group with no live leaf had no way back before this existed.
   */
  async revive(conversationId: string): Promise<ConversationView> {
    const { ctx } = this;
    ctx.instance.assertActive();
    const record = ctx.model.conversations.get(conversationId);
    if (!record) throw new NotFoundError(`no such conversation: ${conversationId}`);
    const others = record.members.filter((m) => m.state === "joined" && m.accountId !== ctx.accountId).map((m) => m.accountId);

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
          // A founding commit like any other: the group underneath is new, and
          // its GroupInfo goes up with it so a leafless device can join the
          // revived group by itself rather than waiting to be added again.
          kind: "member",
          addedLeaves: result.added,
          removedLeaves: [],
          ...(result.welcome ? { welcome: { payload: base64Encode(result.welcome), recipients: claimed.keyPackages.map((k) => k.instanceId) } } : {}),
          groupInfo: base64Encode(result.groupInfo),
        },
      };
    }
    const res = await ctx.http.request({
      method: "POST",
      path: `/v1/conversations/${conversationId}/reset`,
      body: { mlsGroupId: base64Encode(groupId), idempotencyKey: uuidV7(ctx.now()), ...(initialCommit ? { initialCommit } : {}) },
      schema: resetConversationResponseSchema,
      signer: ctx.signer,
    });
    const summary = res.conversation;
    await ctx.mutex.run(async () => {
      const batch = ctx.store.batch();
      ctx.groups.stage(batch, summary.id, next);
      const rebuilt = { ...this.recordFromSummary(summary, ctx.engine.epochOf(next)), removed: false };
      batch.putJson("conversation", rebuilt.id, rebuilt);
      await ctx.store.commit(batch);
      ctx.groups.commitInMemory(summary.id, next);
      ctx.model.conversations.set(rebuilt.id, rebuilt);
    });
    ctx.log.info?.("revived a conversation whose group had no live device", { conversationId, added: claimed.keyPackages.length });
    this.invalidate(conversationId);
    return this.get(conversationId)!;
  }

  /** The self-join rule, the re-publish rule and the elector rules for adds. Runs after each sync; cheap when there is nothing to do. */
  async reconcile(): Promise<void> {
    const { ctx } = this;
    if (this.reconciling || !ctx.instance.isActive) return;
    this.reconciling = true;
    let retrySoon = false;
    try {
      await this.selfJoin();
      await this.republishGroupInfo();
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
            /**
             * A REVOKED instance is "refused" too, and saying so as a chain
             * failure is a lie that costs an evening: an account everybody
             * signed out of has every instance revoked and no active one, and
             * the honest reading of that is "nobody is there", not "somebody
             * is forging approvals". So the two are counted apart, and the
             * chain one is the only one worth a warning.
             */
            const forged = [...refused.values()].filter((why) => !why.startsWith("status is")).length;
            if (forged) ctx.log.warn?.("instances refused by the approval chain", { accountId, count: forged });
            const targets = trusted.filter((i) => !present.has(i.id));
            if (targets.length === 0) {
              // The branch that used to say nothing at all, which is why a
              // conversation stuck like this looked like it was still working.
              ctx.log.info?.("nobody to add for this member", {
                conversationId,
                accountId,
                trusted: trusted.length,
                revoked: refused.size - forged,
                forged,
              });
              continue;
            }
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

  // ---- self-join (external commit) and resync -----------------------------

  /** Rule 0: every conversation this account is a joined member of and this instance holds no active leaf in. */
  private async selfJoin(): Promise<void> {
    const { ctx } = this;
    for (const record of [...ctx.model.conversations.values()]) {
      if (record.removed) continue;
      if (record.members.find((m) => m.accountId === ctx.accountId)?.state !== "joined") continue;
      const state = ctx.groups.get(record.id);
      if (state && ctx.engine.isActive(state)) continue;
      try {
        await this.joinConversation(record.id);
      } catch (error) {
        ctx.log.warn?.("self-join failed", { conversationId: record.id, error: describeError(error) });
      }
    }
  }

  /**
   * GET the stored GroupInfo, build an external commit from it, post it. On `epoch_conflict` (somebody
   * committed first, possibly an elector adding THIS instance) the conversation is refetched and, unless
   * this instance's leaf is now active or on its way, the join is rebuilt from the fresh GroupInfo, at
   * most {@link MAX_JOIN_ATTEMPTS} times per sync. No GroupInfo means waiting for an elector as before.
   */
  private async joinConversation(conversationId: string): Promise<void> {
    const { ctx } = this;
    for (let attempt = 0; attempt < MAX_JOIN_ATTEMPTS; attempt++) {
      const stored = await this.fetchGroupInfo(conversationId);
      if (!stored) {
        /**
         * No GroupInfo, so there is no honest way in — and for a DM, waiting
         * is not an answer: the only other device may never be opened again.
         * A DM with nobody able to admit this device is re-keyed instead, a
         * move the server allows only under exactly these conditions (see
         * `mayRekeyDirect`). Nothing is lost that was not already lost: a
         * device with no leaf could read none of it anyway.
         */
        const record = ctx.model.conversations.get(conversationId);
        /**
         * A DM this ACCOUNT was once in and fell out of, with no GroupInfo to
         * join from, is re-keyed rather than waited on — the server's
         * `mayRekeyDirect` enforces the same rule and is the authority.
         *
         * The condition is checked BEFORE trying, not by trying: building the
         * new group claims the other side's key packages, and a claim spent on
         * a re-key the server then refuses is one the elector no longer has to
         * add this device with. An account that has never held a leaf here is
         * a newcomer, and a newcomer waits for the elector.
         */
        if (record?.kind === "dm" && !this.rekeyTried.has(conversationId)) {
          const summary = await this.fetchSummary(conversationId);
          const ours = summary.leaves.filter((leaf) => leaf.accountId === ctx.accountId);
          const fellOut = !ours.some((leaf) => leaf.state === "active") && ours.some((leaf) => leaf.state === "removed");
          if (fellOut) {
            this.rekeyTried.add(conversationId);
            try {
              await this.revive(conversationId);
              return;
            } catch (error) {
              ctx.log.info?.("this direct conversation could not be re-keyed; waiting for a member", {
                conversationId,
                reason: describeError(error),
              });
            }
          }
        }
        this.setJoinStatus(conversationId, "waiting_for_member");
        return;
      }
      this.setJoinStatus(conversationId, "joining");
      const summary = await this.fetchSummary(conversationId);
      if (summary.members.find((m) => m.accountId === ctx.accountId)?.state !== "joined") return;
      const live = ctx.groups.get(conversationId);
      if (live && ctx.engine.isActive(live)) return; // a Welcome landed meanwhile
      let resync: boolean;
      switch (summary.myLeafState) {
        case "active":
          // Lost state: the server still lists this leaf. Act on the second sighting only (see `resyncSeen`).
          if (!this.resyncSeen.has(conversationId)) {
            this.resyncSeen.add(conversationId);
            ctx.sync.request();
            return;
          }
          resync = true;
          break;
        case "pending_welcome":
          return; // an elector added this instance; its Welcome is in the delivery stream
        default:
          resync = false;
      }
      const join = await ctx.engine.joinExternal(ctx.identity, base64Decode(stored.data), { resync });
      const request: SubmitEventRequest = {
        idempotencyKey: uuidV7(ctx.now()),
        kind: "mls_commit",
        epoch: join.epoch,
        payload: base64Encode(join.commit),
        commit: {
          newEpoch: join.epoch + 1,
          kind: resync ? "resync" : "external",
          addedLeaves: [{ accountId: ctx.accountId, instanceId: ctx.instanceId }],
          removedLeaves: resync ? [ctx.instanceId] : [],
          groupInfo: base64Encode(join.groupInfo),
        },
      };
      try {
        const res = await ctx.http.request({
          method: "POST",
          path: `/v1/conversations/${conversationId}/events`,
          body: request,
          schema: submitEventResponseSchema,
          signer: ctx.signer,
        });
        await this.adoptJoin(conversationId, summary, join.next, join.epoch, res.event);
        ctx.log.info?.(resync ? "resynced by external commit" : "joined by external commit", { conversationId, epoch: join.epoch + 1 });
        return;
      } catch (error) {
        if (error instanceof EpochConflictError) {
          // The joiner adopted nothing (engine invariant 2): rebuild from the GroupInfo of the winning epoch, unless
          // the winner was an elector adding this very instance, in which case its Welcome is what to wait for.
          const again = await this.fetchSummary(conversationId);
          if (!resync && again.myLeafState !== null && again.myLeafState !== "removed") return;
          continue;
        }
        if (error instanceof TransportError && error.serverCode === "group_info_missing") {
          this.setJoinStatus(conversationId, "waiting_for_member");
          return;
        }
        throw error;
      }
    }
    ctx.log.info?.("self-join lost the epoch race repeatedly; will try again after the next sync", { conversationId });
  }

  /** The stored GroupInfo for the current epoch, or `null` when the server holds none (or predates the route). */
  private async fetchGroupInfo(conversationId: string): Promise<StoredGroupInfo | null> {
    try {
      const res = await this.ctx.http.request({ method: "GET", path: `/v1/conversations/${conversationId}/group-info`, schema: groupInfoResponseSchema, signer: this.ctx.signer });
      return res.groupInfo;
    } catch (error) {
      if (error instanceof TransportError && error.status === 404) return null;
      throw error;
    }
  }

  private async fetchSummary(conversationId: string): Promise<ConversationSummary> {
    const res = await this.ctx.http.request({ method: "GET", path: `/v1/conversations/${conversationId}`, schema: conversationResponseSchema, signer: this.ctx.signer });
    return res.conversation;
  }

  /** The server accepted our external commit: the joined state, the record and our own event land in one batch. */
  private async adoptJoin(conversationId: string, summary: ConversationSummary, next: GroupState, epoch: number, accepted: { id: string; seq: number; createdAt: string }): Promise<void> {
    const { ctx } = this;
    await ctx.mutex.run(async () => {
      const existing = ctx.model.conversations.get(conversationId);
      const joinedEpoch = ctx.engine.epochOf(next);
      // Membership follows the tree, as after any commit: every account with a leaf is joined.
      const accounts = new Set(ctx.engine.membersOf(next).map((m) => m.accountId));
      const members = summary.members.map((m) => ({ accountId: m.accountId, role: m.role, state: accounts.has(m.accountId) ? ("joined" as const) : m.state }));
      for (const a of accounts) if (!members.some((m) => m.accountId === a)) members.push({ accountId: a, role: "member", state: "joined" });
      const record: ConversationRecord = {
        id: summary.id,
        kind: summary.kind,
        appId: summary.appId,
        mlsGroupId: summary.mlsGroupId,
        createdByAccountId: summary.createdByAccountId,
        createdAt: summary.createdAt,
        name: existing?.name ?? null,
        members,
        lastSeq: Math.max(existing?.lastSeq ?? 0, accepted.seq),
        joinedEpoch,
        lastReadSeq: existing?.lastReadSeq ?? 0,
        removed: false,
        lastActivityAt: existing?.lastActivityAt ?? summary.createdAt,
        refusedCommit: existing?.refusedCommit ?? null,
      };
      const event: EventRecord = {
        id: accepted.id,
        conversationId,
        seq: accepted.seq,
        kind: "mls_commit",
        epoch,
        senderAccountId: ctx.accountId,
        senderInstanceId: ctx.instanceId,
        createdAt: accepted.createdAt,
        localKey: null,
        message: null,
        failure: null,
        system: null,
      };
      const batch = ctx.store.batch();
      ctx.groups.stage(batch, conversationId, next);
      batch.putJson("conversation", record.id, record);
      batch.putJson("event", Model.eventId(event), event);
      await ctx.store.commit(batch);
      ctx.groups.commitInMemory(conversationId, next);
      ctx.model.conversations.set(record.id, record);
      ctx.model.putEvent(event);
      this.resyncSeen.delete(conversationId);
      this.joinStatus.delete(conversationId);
      this.groupInfoChecked.add(conversationId); // the commit carried the GroupInfo of the new epoch
      ctx.messages.invalidate(conversationId);
      this.invalidate(conversationId);
    });
    // Deliveries queued before this leaf existed are from older epochs and are dropped on replay.
    await ctx.sync.replayQueued(conversationId);
    ctx.outbox.kick();
  }

  private setJoinStatus(conversationId: string, status: JoinStatus): void {
    if (this.joinStatus.get(conversationId) === status) return;
    this.joinStatus.set(conversationId, status);
    this.invalidate(conversationId);
  }

  // ---- re-publish (old conversations) --------------------------------------

  /**
   * Once per conversation per session: if the server holds no GroupInfo for this instance's current epoch,
   * publish ours, so a conversation whose last commit predates the field becomes joinable. A `404` from the
   * GET is a server without the route; an `epoch_conflict` from the PUT means our state is behind, and the
   * commit that moves it forward carries a GroupInfo of its own.
   */
  private async republishGroupInfo(): Promise<void> {
    const { ctx } = this;
    let budget = REPUBLISH_BATCH;
    for (const conversationId of ctx.groups.ids()) {
      if (budget === 0) return;
      if (this.groupInfoChecked.has(conversationId)) continue;
      const state = ctx.groups.get(conversationId)!;
      const record = ctx.model.conversations.get(conversationId);
      if (!record || !ctx.engine.isActive(state) || record.removed) continue;
      budget--;
      this.groupInfoChecked.add(conversationId);
      try {
        const stored = await this.fetchGroupInfo(conversationId);
        if (stored && stored.epoch >= ctx.engine.epochOf(state)) continue;
        await this.publishGroupInfo(conversationId, state);
      } catch (error) {
        ctx.log.warn?.("group info check failed", { conversationId, error: describeError(error) });
      }
    }
  }

  /** `PUT` this state's GroupInfo for its epoch. Best effort: a failure is logged and the once-per-session check may retry later. */
  private async publishGroupInfo(conversationId: string, state: GroupState): Promise<void> {
    const { ctx } = this;
    try {
      const epoch = ctx.engine.epochOf(state);
      const data = base64Encode(await ctx.engine.publishGroupInfo(state));
      await ctx.http.request({ method: "PUT", path: `/v1/conversations/${conversationId}/group-info`, body: { epoch, data }, signer: ctx.signer });
      this.groupInfoChecked.add(conversationId);
      ctx.log.debug?.("group info published", { conversationId, epoch });
    } catch (error) {
      if (error instanceof EpochConflictError) this.groupInfoChecked.add(conversationId); // behind: the commit that catches us up carries one
      else if (error instanceof TransportError && error.status === 404) this.groupInfoChecked.add(conversationId); // a server without the route
      else ctx.log.warn?.("group info publish failed", { conversationId, error: describeError(error) });
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconcile().catch((error) => this.ctx.log.debug?.("reconcile retry failed", { error: describeError(error) }));
    }, REACH_RETRY_MS);
  }
}
