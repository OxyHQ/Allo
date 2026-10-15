/**
 * `conversation_events` — the append, and the reads.
 *
 * {@link appendClientEvent} is the rule set of `POST /v1/conversations/:id/events`
 * from `docs/platform/api-v1.md`, run under `SELECT … FOR UPDATE` on the
 * conversation row. It REQUIRES a transaction: the event, the epoch move, the
 * leaf and member changes and the delivery rows are one write or none, and a
 * caller handing it the pool would commit each on its own.
 *
 * An `mls_commit` is one of three kinds (`CommitInfo.kind`), and the kind
 * decides who may append it:
 *
 * - `member`: the sender holds an active leaf. Adds, removes, updates.
 * - `external`: an MLS external commit by a device with NO leaf. What admits
 *   it is its account's `joined` member row (an account invited before it
 *   installed Allo has one) plus the stored GroupInfo it joined from, whose
 *   authenticity the members verify. The added leaf is exactly the sender and
 *   is `active` at `newEpoch` at once: there is no Welcome to wait for.
 * - `resync`: an external commit by a device that already holds a leaf and
 *   lost its group state. Added and removed leaf are both the sender; its leaf
 *   row is REPLACED rather than refused as "already holds an active leaf".
 *
 * Every accepted commit stores `commit.groupInfo` for `newEpoch` in the same
 * transaction ({@link upsertGroupInfo}), so "commit accepted but no GroupInfo
 * for the new epoch" cannot happen. The server never raises
 * `group_info_missing` on a commit: a joiner posts an external commit only
 * once it HOLDS a GroupInfo, and whether one exists is what `GET …/group-info`
 * answers (`null`), on which the client decides to wait for an elector.
 *
 * `payload` is a protected column; the two readers that return it
 * ({@link listEvents}, and the sync stream in `deliveryRepository.ts`) name it
 * explicitly.
 */

import { findManagedTeam } from './managedTeamRepository';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { SERVER_SENDER_ID, type ControlEvent, type SubmitEventRequest } from '@allo/shared-types';
import { AlloHttpError, forbidden, notFound, validationFailed } from '../../utils/httpErrors';
import { getDb, type AlloDatabaseOrTransaction, type AlloTransaction } from '../index';
import { requireTransaction } from '../moderation/transactionGuard';
import { conversationEvents, type EventKind } from '../schema/events';
import { assertContactAllowed } from '../social/blockRepository';
import { retainBlobs } from './blobRepository';
import {
  findAddableInstances,
  findMember,
  listLeaves,
  listMembers,
  lockConversation,
  markLeafRemoved,
  setMemberState,
  updateConversationCounters,
  upsertJoinedMember,
  upsertLeaf,
  type ConversationRow,
  type LeafRow,
} from './conversationRepository';
import { insertDeliveries } from './deliveryRepository';
import { upsertGroupInfo } from './groupInfoRepository';

export type EventRow = typeof conversationEvents.$inferSelect;

/** The columns a wire `ConversationEvent` is built from, payload included on purpose. */
export const EVENT_COLUMNS = {
  id: conversationEvents.id,
  conversationId: conversationEvents.conversationId,
  seq: conversationEvents.seq,
  kind: conversationEvents.kind,
  epoch: conversationEvents.epoch,
  senderAccountId: conversationEvents.senderAccountId,
  senderInstanceId: conversationEvents.senderInstanceId,
  payload: conversationEvents.payload,
  blobIds: conversationEvents.blobIds,
  createdAt: conversationEvents.createdAt,
} as const;

export interface AppendedEvent {
  event: { id: string; seq: number; createdAt: Date };
  /** True when the idempotency key matched an earlier append and nothing was written. */
  replayed: boolean;
  /** Instances that got a delivery row and should be nudged. */
  recipients: string[];
}

export interface Sender {
  instanceId: string;
  accountId: string;
}

interface InsertEventInput {
  conversationId: string;
  seq: number;
  kind: EventKind;
  epoch: number;
  senderAccountId: string;
  senderInstanceId: string | null;
  idempotencyKey: string | null;
  payload: Buffer;
  blobIds: string[];
}

async function insertEvent(input: InsertEventInput, tx: AlloTransaction): Promise<EventRow> {
  const [row] = await tx
    .insert(conversationEvents)
    .values({ id: uuidv7(), ...input })
    .returning();
  return row;
}

function activeLeaves(leaves: readonly LeafRow[]): LeafRow[] {
  return leaves.filter((leaf) => leaf.state === 'active');
}

/**
 * Append one client event and its deliveries. See the module comment for the
 * rules; each is stated once more at the line that enforces it.
 */
export async function appendClientEvent(
  input: { conversationId: string; sender: Sender; request: SubmitEventRequest },
  db: AlloDatabaseOrTransaction,
): Promise<AppendedEvent> {
  const tx = requireTransaction(db, `appendClientEvent(${input.conversationId})`);
  const { conversationId, sender, request } = input;

  const conversation = await lockConversation(conversationId, tx);
  if (!conversation) throw notFound('Conversation not found');

  // Is the caller anybody here at all? A stranger learns nothing, not even
  // that the conversation exists.
  const member = await findMember(conversationId, sender.accountId, tx);
  if (!member) throw notFound('Conversation not found');

  // Replay: the same (instance, key) with the same body is the same event.
  const [existing] = await tx
    .select()
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.senderInstanceId, sender.instanceId),
        eq(conversationEvents.idempotencyKey, request.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    const payload = Buffer.from(request.payload, 'base64');
    const same =
      existing.conversationId === conversationId &&
      existing.kind === request.kind &&
      existing.epoch === request.epoch &&
      Buffer.compare(existing.payload, payload) === 0;
    if (!same) {
      throw new AlloHttpError(
        'idempotency_conflict',
        'This idempotency key was used with a different body',
      );
    }
    return {
      event: { id: existing.id, seq: existing.seq, createdAt: existing.createdAt },
      replayed: true,
      recipients: [],
    };
  }

  // MLS maintenance remains available so existing devices can recover history.
  // Every application kind (including media, edits and receipts) is opaque here.
  if (conversation.kind === 'dm' && request.kind !== 'mls_commit') {
    const members = await listMembers(conversationId, tx);
    await assertContactAllowed(
      tx,
      sender.accountId,
      members.map((m) => m.accountId),
    );
  }

  const leaves = await listLeaves(conversationId, tx);
  const senderLeaf = leaves.find((leaf) => leaf.instanceId === sender.instanceId);
  // Who may append depends on how a commit was authored (module comment);
  // everything that is not an external commit needs an active leaf.
  const managedTeam = await findManagedTeam(conversationId, tx);
  if (managedTeam) {
    if (request.kind !== 'mls_commit' && managedTeam.frozen)
      throw new AlloHttpError('unavailable', 'Team membership is being confirmed', {
        teamPending: true,
      });
    if (request.kind === 'mls_commit' && request.commit) {
      const changes = request.commit;
      const allowed = new Set(managedTeam.targetAccountIds);
      if (
        changes.addedLeaves.some((leaf) => !allowed.has(leaf.accountId)) ||
        changes.addedAccountIds?.some((id) => !allowed.has(id)) ||
        changes.removedAccountIds?.some((id) => allowed.has(id))
      )
        throw forbidden('Managed team changes must match Homiio');
      const currentAccounts = new Set(
        (await listMembers(conversationId, tx))
          .filter((m) => m.state === 'joined')
          .map((m) => m.accountId),
      );
      const accountChange =
        changes.addedAccountIds?.length ||
        changes.removedAccountIds?.length ||
        changes.addedLeaves.some((leaf) => !currentAccounts.has(leaf.accountId));
      if (
        accountChange &&
        (!managedTeam.frozen || sender.accountId !== conversation.createdByAccountId)
      )
        throw forbidden('Managed team membership requires a pending creator operation');
    }
  }
  const commitKind = request.kind === 'mls_commit' ? (request.commit?.kind ?? 'member') : 'member';
  if (commitKind === 'external') {
    // The sender has no leaf yet; its account's `joined` row is the admission.
    // A `left` or `removed` account is not re-admitted by its own hand.
    if (member.state !== 'joined')
      throw forbidden('This account is no longer a member of the conversation');
  } else if (commitKind === 'resync') {
    // A resync replaces the sender's own leaf, so it must hold one: active, or
    // `removed` with no epoch (a server-side removal no commit has confirmed).
    if (member.state !== 'joined')
      throw forbidden('This account is no longer a member of the conversation');
    const holdsLeaf =
      senderLeaf !== undefined &&
      (senderLeaf.state === 'active' ||
        (senderLeaf.state === 'removed' && senderLeaf.removedEpoch === null));
    if (!holdsLeaf) throw forbidden('This instance holds no leaf in the conversation to resync');
  } else if (!senderLeaf || senderLeaf.state !== 'active') {
    throw forbidden('This instance holds no active leaf in the conversation');
  }

  if (request.epoch !== conversation.currentEpoch) {
    throw new AlloHttpError('epoch_conflict', 'The event is at a stale epoch', {
      currentEpoch: conversation.currentEpoch,
    });
  }

  const payload = Buffer.from(request.payload, 'base64');
  const blobIds = request.blobIds ?? [];
  // Every leaf active at THIS epoch, minus the sender. For a commit that is
  // exactly who must learn the epoch moved — the leaves it removes included.
  const recipients = activeLeaves(leaves)
    .filter((leaf) => leaf.instanceId !== sender.instanceId)
    .map((leaf) => leaf.instanceId);

  let seq = conversation.lastSeq + 1;
  let epoch = conversation.currentEpoch;

  if (request.kind !== 'mls_commit') {
    const event = await insertEvent(
      {
        conversationId,
        seq,
        kind: request.kind,
        epoch,
        senderAccountId: sender.accountId,
        senderInstanceId: sender.instanceId,
        idempotencyKey: request.idempotencyKey,
        payload,
        blobIds,
      },
      tx,
    );
    await insertDeliveries({ eventId: event.id, conversationId, instanceIds: recipients }, tx);
    await retainBlobs(blobIds, tx);
    await updateConversationCounters(conversationId, { currentEpoch: epoch, lastSeq: seq }, tx);
    return {
      event: { id: event.id, seq, createdAt: event.createdAt },
      replayed: false,
      recipients,
    };
  }

  // --- mls_commit ------------------------------------------------------------
  const commit = request.commit;
  if (!commit) throw validationFailed('an mls_commit carries commit info'); // the schema already refuses this
  const newEpoch = commit.newEpoch;
  const members = await listMembers(conversationId, tx);
  const joined = new Set(members.filter((m) => m.state === 'joined').map((m) => m.accountId));

  // A self-join (external or resync) adds exactly the sender and, for a
  // resync, removes exactly the sender. The schema fixed the COUNTS; only the
  // server knows who signed the request, so WHO is checked here and is not
  // trusted to the schema either: a joiner naming any other instance — even
  // another of its own account — is refused.
  const addedAccounts = [...new Set(commit.addedAccountIds ?? [])];
  const removedAccounts = [...new Set(commit.removedAccountIds ?? [])];
  if (addedAccounts.some((id) => removedAccounts.includes(id)))
    throw validationFailed('an account cannot be added and removed together');
  if (commit.kind !== 'member' && (addedAccounts.length || removedAccounts.length))
    throw forbidden('a self join cannot change account membership');
  if (conversation.kind === 'dm' && addedAccounts.some((id) => !joined.has(id)))
    throw forbidden('a dm cannot gain a third account');
  for (const id of removedAccounts) {
    if (id !== sender.accountId && member.role !== 'owner' && member.role !== 'admin')
      throw forbidden('only an owner or admin may remove another account');
    if (
      leaves.some(
        (leaf) =>
          leaf.accountId === id &&
          leaf.state !== 'removed' &&
          !commit.removedLeaves.includes(leaf.instanceId),
      )
    )
      throw validationFailed('removing an account must remove all its leaves');
    if (commit.addedLeaves.some((leaf) => leaf.accountId === id))
      throw validationFailed('a removed account cannot receive a new leaf');
  }
  const selfJoin = commit.kind === 'external' || commit.kind === 'resync';
  if (selfJoin) {
    const [added] = commit.addedLeaves;
    if (
      commit.addedLeaves.length !== 1 ||
      added.instanceId !== sender.instanceId ||
      added.accountId !== sender.accountId
    ) {
      throw validationFailed(`a ${commit.kind} commit adds exactly the sender's own leaf`, {
        instanceId: sender.instanceId,
      });
    }
    if (commit.welcome !== undefined)
      throw validationFailed(`a ${commit.kind} commit carries no welcome`);
    const expectedRemoved = commit.kind === 'resync' ? [sender.instanceId] : [];
    if (
      commit.removedLeaves.length !== expectedRemoved.length ||
      commit.removedLeaves.some((id, i) => id !== expectedRemoved[i])
    ) {
      throw validationFailed(
        commit.kind === 'resync'
          ? "a resync commit removes exactly the sender's own former leaf"
          : 'an external commit removes no leaf',
        { instanceId: sender.instanceId },
      );
    }
  }

  // Added leaves: real, active instances of the account the commit names.
  const addedIds = commit.addedLeaves.map((leaf) => leaf.instanceId);
  if (new Set(addedIds).size !== addedIds.length)
    throw validationFailed('an instance is added twice');
  const addable = new Map(
    (await findAddableInstances(addedIds, tx)).map((row) => [row.id, row.accountId]),
  );
  for (const added of commit.addedLeaves) {
    const accountId = addable.get(added.instanceId);
    if (accountId === undefined) {
      throw validationFailed('an added instance does not exist or is not active', {
        instanceId: added.instanceId,
      });
    }
    if (accountId !== added.accountId) {
      throw validationFailed('an added instance belongs to another account', {
        instanceId: added.instanceId,
      });
    }
    const current = leaves.find((leaf) => leaf.instanceId === added.instanceId);
    // A resync names the sender's own live leaf on both sides: a replace, not a
    // second leaf. Every other kind must not add a leaf that already exists.
    if (current?.state === 'active' && commit.kind !== 'resync') {
      throw validationFailed('an added instance already holds an active leaf', {
        instanceId: added.instanceId,
      });
    }
    // A DM has exactly two accounts; a group may grow, and any member may grow it.
    if (conversation.kind === 'dm' && !joined.has(added.accountId)) {
      throw forbidden('a dm cannot gain a third account');
    }
  }

  // Adding a device of an existing member is maintenance, not an invitation.
  // A new or re-added account must not be invited across a block.
  await assertContactAllowed(tx, sender.accountId, [
    ...commit.addedLeaves
      .filter((leaf) => !joined.has(leaf.accountId))
      .map((leaf) => leaf.accountId),
    ...addedAccounts.filter((id) => !joined.has(id)),
  ]);

  // Removed leaves: present, and either the sender's own account or removed by an owner/admin.
  // A resync's removed leaf is the sender's own, replaced by the upsert below
  // rather than marked removed after it; it is not a removal.
  const mayRemoveOthers = member.role === 'owner' || member.role === 'admin';
  const removedLeaves: LeafRow[] = [];
  for (const instanceId of commit.kind === 'resync' ? [] : commit.removedLeaves) {
    const leaf = leaves.find((l) => l.instanceId === instanceId);
    const removable =
      leaf && (leaf.state === 'active' || (leaf.state === 'removed' && leaf.removedEpoch === null));
    if (!removable) {
      throw validationFailed('a removed instance holds no leaf to remove', { instanceId });
    }
    if (leaf.accountId !== sender.accountId && !mayRemoveOthers) {
      throw forbidden("only an owner or admin may remove another account's instance");
    }
    removedLeaves.push(leaf);
  }

  // The welcome goes to added leaves and to nobody else.
  const welcome = commit.welcome;
  if (welcome) {
    const added = new Set(addedIds);
    for (const recipient of welcome.recipients) {
      if (!added.has(recipient)) {
        throw validationFailed('a welcome recipient is not an added leaf', {
          instanceId: recipient,
        });
      }
    }
  }

  // Apply. The commit itself is at the OLD epoch (the one it leaves).
  const commitEvent = await insertEvent(
    {
      conversationId,
      seq,
      kind: 'mls_commit',
      epoch,
      senderAccountId: sender.accountId,
      senderInstanceId: sender.instanceId,
      idempotencyKey: request.idempotencyKey,
      payload,
      blobIds,
    },
    tx,
  );
  await insertDeliveries({ eventId: commitEvent.id, conversationId, instanceIds: recipients }, tx);
  await retainBlobs(blobIds, tx);

  const welcomed = new Set(welcome?.recipients ?? []);
  for (const added of commit.addedLeaves) {
    await upsertLeaf(
      {
        conversationId,
        instanceId: added.instanceId,
        accountId: added.accountId,
        // Added leaves pass through `pending_welcome` and are `active` at the
        // new epoch once the welcome exists for them; a commit that adds a leaf
        // without welcoming it leaves it pending, which a later commit can fix.
        // A self-join has no welcome and needs none: the joiner holds the new
        // state already, so its leaf is active at `newEpoch` at once.
        state: selfJoin || welcomed.has(added.instanceId) ? 'active' : 'pending_welcome',
        addedEpoch: newEpoch,
      },
      tx,
    );
    await upsertJoinedMember(
      {
        conversationId,
        accountId: added.accountId,
        role: 'member',
        addedByAccountId: sender.accountId,
      },
      tx,
    );
  }
  for (const accountId of addedAccounts) {
    await upsertJoinedMember(
      { conversationId, accountId, role: 'member', addedByAccountId: sender.accountId },
      tx,
    );
  }
  for (const accountId of removedAccounts) {
    await setMemberState(
      conversationId,
      accountId,
      accountId === sender.accountId ? 'left' : 'removed',
      tx,
    );
  }
  for (const leaf of removedLeaves) {
    await markLeafRemoved(conversationId, leaf.instanceId, newEpoch, tx);
  }

  // An account whose LAST leaf this commit removed is no longer in the group.
  // Only accounts named in `removedLeaves` are examined: a joined member with
  // no leaf at all (invited before it installed Allo, waiting for the elector
  // to add its first device) has nothing to lose here and stays `joined`.
  // "No active leaf after the commit" alone would remove it on every commit.
  const remaining = await listLeaves(conversationId, tx);
  const accountsStillIn = new Set(activeLeaves(remaining).map((leaf) => leaf.accountId));
  for (const leaf of removedLeaves) {
    if (
      accountsStillIn.has(leaf.accountId) ||
      managedTeam?.targetAccountIds.includes(leaf.accountId)
    )
      continue;
    await setMemberState(
      conversationId,
      leaf.accountId,
      leaf.accountId === sender.accountId ? 'left' : 'removed',
      tx,
    );
  }

  epoch = newEpoch;
  let welcomeRecipients: string[] = [];
  if (welcome) {
    seq += 1;
    const welcomeEvent = await insertEvent(
      {
        conversationId,
        seq,
        kind: 'mls_welcome',
        epoch: newEpoch,
        senderAccountId: sender.accountId,
        senderInstanceId: sender.instanceId,
        idempotencyKey: null,
        payload: Buffer.from(welcome.payload, 'base64'),
        blobIds: [],
      },
      tx,
    );
    welcomeRecipients = [...welcomed];
    await insertDeliveries(
      { eventId: welcomeEvent.id, conversationId, instanceIds: welcomeRecipients },
      tx,
    );
  }

  await updateConversationCounters(conversationId, { currentEpoch: epoch, lastSeq: seq }, tx);
  // The GroupInfo of the epoch this commit created, from the committer's new
  // state. Same transaction as the commit: accepted-but-unjoinable is not a
  // state the conversation can be in.
  await upsertGroupInfo(
    {
      conversationId,
      epoch: newEpoch,
      signerInstanceId: sender.instanceId,
      data: Buffer.from(commit.groupInfo, 'base64'),
    },
    tx,
  );
  return {
    event: { id: commitEvent.id, seq: commitEvent.seq, createdAt: commitEvent.createdAt },
    replayed: false,
    recipients: [...new Set([...recipients, ...welcomeRecipients])],
  };
}

/**
 * Append a server-written `control` event, delivered to every active leaf
 * except `excludeInstanceIds`. The caller holds no lock; this takes it.
 */
export async function appendControlEvent(
  input: { conversationId: string; control: ControlEvent; excludeInstanceIds?: readonly string[] },
  db: AlloDatabaseOrTransaction,
): Promise<AppendedEvent> {
  const tx = requireTransaction(db, `appendControlEvent(${input.conversationId})`);
  const conversation = await lockConversation(input.conversationId, tx);
  if (!conversation) throw notFound('Conversation not found');
  const excluded = new Set(input.excludeInstanceIds ?? []);
  const recipients = activeLeaves(await listLeaves(input.conversationId, tx))
    .map((leaf) => leaf.instanceId)
    .filter((id) => !excluded.has(id));
  const seq = conversation.lastSeq + 1;
  const event = await insertEvent(
    {
      conversationId: input.conversationId,
      seq,
      kind: 'control',
      epoch: conversation.currentEpoch,
      senderAccountId: SERVER_SENDER_ID,
      senderInstanceId: null,
      idempotencyKey: null,
      payload: Buffer.from(JSON.stringify(input.control), 'utf8'),
      blobIds: [],
    },
    tx,
  );
  await insertDeliveries(
    { eventId: event.id, conversationId: input.conversationId, instanceIds: recipients },
    tx,
  );
  await updateConversationCounters(
    input.conversationId,
    { currentEpoch: conversation.currentEpoch, lastSeq: seq },
    tx,
  );
  return { event: { id: event.id, seq, createdAt: event.createdAt }, replayed: false, recipients };
}

export type EventReadRow = {
  [K in keyof typeof EVENT_COLUMNS]: (typeof conversationEvents.$inferSelect)[K];
};

/** `seq > after`, ascending, `limit + 1` rows so the caller can say `hasMore`. */
export async function listEvents(
  conversationId: string,
  after: number,
  limit: number,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<{ events: EventReadRow[]; hasMore: boolean }> {
  const rows = await db
    .select(EVENT_COLUMNS)
    .from(conversationEvents)
    .where(
      and(eq(conversationEvents.conversationId, conversationId), gt(conversationEvents.seq, after)),
    )
    .orderBy(asc(conversationEvents.seq))
    .limit(limit + 1);
  return { events: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function findEventsByIds(
  ids: readonly string[],
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<EventReadRow[]> {
  if (ids.length === 0) return [];
  return db
    .select(EVENT_COLUMNS)
    .from(conversationEvents)
    .where(inArray(conversationEvents.id, [...ids]));
}

export type { ConversationRow };
