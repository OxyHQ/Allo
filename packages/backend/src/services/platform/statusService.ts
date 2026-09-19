/**
 * Status updates, and the rules the server keeps, in check order.
 *
 * The client decides WHO a status goes to — it knows who it talks to, and the
 * server is never asked for a contact list. What the server decides is who it
 * is willing to DELIVER to, and it refuses three kinds of recipient:
 *
 * 1. **A device that is not there.** Unknown, pending or revoked.
 * 2. **An account that shares no conversation with the author.** A status to
 *    somebody you have never spoken to is not a status, it is mail.
 * 3. **Either direction of a block.** As everywhere else: a block that the
 *    blocked person can route around is not a block.
 *
 * Refused recipients are NAMED back to the author, because an app that says
 * "posted" while three people never got it is lying in the one direction that
 * matters.
 *
 * Everything the server holds it cannot open: the body is AES-256-GCM under a
 * key it never sees, and each recipient's copy of that key is HPKE-sealed to
 * that device's transfer key. What it does learn is the audience — it has to,
 * to deliver — and `threat-model.md` §5 says so.
 */

import {
  MAX_STATUS_PAGE,
  STATUS_LIFETIME_MS,
  type CreateStatusRequest,
  type CreateStatusResponse,
  type ListStatusViewsResponse,
  type ListStatusesResponse,
  type Status,
} from "@allo/shared-types";
import { getDb, type AlloDatabase } from "../../db";
import { retainBlobs } from "../../db/platform/blobRepository";
import { listSharedAccountsAmong } from "../../db/platform/conversationRepository";
import { findInstanceById } from "../../db/platform/instanceRepository";
import {
  findStatusById,
  findStatusByIdempotencyKey,
  holdsKey,
  insertStatus,
  insertStatusKeys,
  listInbox,
  listOwn,
  listViews,
  markStatusDeleted,
  recordView,
  type StatusRow,
} from "../../db/platform/statusRepository";
import { blockedEitherWay } from "../../db/social/blockRepository";
import { statusViewReceiptsOf } from "../../db/social/userSettingsRepository";
import { forbidden, notFound, validationFailed } from "../../utils/httpErrors";
import { getRealtime } from "../../runtime/realtime";
import { toStatus } from "./wire";

/** The slack a client's clock is allowed against the server's, as everywhere else. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface StatusCaller {
  instanceId: string;
  accountId: string;
}

export interface StatusServiceDeps {
  db?: AlloDatabase;
  now?: () => Date;
}

export async function createStatus(
  caller: StatusCaller,
  request: CreateStatusRequest,
  deps: StatusServiceDeps = {},
): Promise<CreateStatusResponse> {
  const db = deps.db ?? getDb();
  const now = deps.now?.() ?? new Date();

  const replayed = await findStatusByIdempotencyKey(caller.instanceId, request.idempotencyKey, db);
  if (replayed) return { status: toStatus(replayed, null), refused: [] };

  const { allowed, refused } = await screenRecipients(caller, request, db);
  // The author signs the deadline, so the server cannot move it; what the
  // server can do is refuse one that is not a status's deadline at all.
  const expiresAt = new Date(request.expiresAt);
  const ceiling = now.getTime() + STATUS_LIFETIME_MS + CLOCK_SKEW_MS;
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() > ceiling || expiresAt.getTime() <= now.getTime()) {
    throw validationFailed("a status lives at most 24 hours", { path: ["expiresAt"] });
  }

  const row = await db.transaction(async (tx) => {
    const status = await insertStatus(
      {
        id: request.id,
        authorAccountId: caller.accountId,
        authorInstanceId: caller.instanceId,
        payload: Buffer.from(request.payload, "base64"),
        nonce: Buffer.from(request.nonce, "base64"),
        sha256: request.sha256,
        blobIds: request.blobIds,
        signature: request.signature,
        idempotencyKey: request.idempotencyKey,
        expiresAt,
      },
      tx,
    );
    await insertStatusKeys(
      allowed.map((recipient) => ({
        statusId: status.id,
        instanceId: recipient.instanceId,
        accountId: recipient.accountId,
        sealedKey: recipient.sealedKey,
        expiresAt,
      })),
      tx,
    );
    // The blobs the envelope names stop being collectable for as long as the
    // status lives. The server cannot read the envelope, so the author declares
    // them — exactly as an event's sender does.
    if (request.blobIds.length > 0) await retainBlobs(request.blobIds, tx);
    return status;
  });

  // After the commit, never inside it.
  const realtime = getRealtime();
  for (const recipient of allowed) {
    realtime.statusPosted(recipient.instanceId, { statusId: row.id, authorAccountId: caller.accountId });
  }

  return { status: toStatus(row, null), refused };
}

interface ScreenedRecipient {
  instanceId: string;
  accountId: string;
  sealedKey: string;
}

async function screenRecipients(
  caller: StatusCaller,
  request: CreateStatusRequest,
  db: AlloDatabase,
): Promise<{ allowed: ScreenedRecipient[]; refused: string[] }> {
  const allowed: ScreenedRecipient[] = [];
  const refused: string[] = [];

  const instances = await Promise.all(request.recipients.map((r) => findInstanceById(r.instanceId, db)));
  const candidates = request.recipients.map((recipient, index) => ({ recipient, instance: instances[index] }));

  const otherAccounts = [
    ...new Set(
      candidates
        .map(({ instance }) => instance?.accountId)
        .filter((accountId): accountId is string => Boolean(accountId) && accountId !== caller.accountId),
    ),
  ];
  const [shared, blocked] = await Promise.all([
    listSharedAccountsAmong(caller.accountId, otherAccounts, db),
    blockedEitherWay(db, caller.accountId, otherAccounts),
  ]);

  for (const { recipient, instance } of candidates) {
    const reachable =
      instance?.status === "active" &&
      // An author's own other devices are always allowed: that is how a status
      // shows on the phone that did not post it.
      (instance.accountId === caller.accountId || (shared.has(instance.accountId) && !blocked.has(instance.accountId)));
    if (!reachable || !instance) {
      refused.push(recipient.instanceId);
      continue;
    }
    allowed.push({ instanceId: recipient.instanceId, accountId: instance.accountId, sealedKey: recipient.sealedKey });
  }
  return { allowed, refused };
}

/** What this device may read: everything sealed to it, plus what its own account posted. */
export async function listStatuses(caller: StatusCaller, deps: StatusServiceDeps = {}): Promise<ListStatusesResponse> {
  const db = deps.db ?? getDb();
  const [inbox, own] = await Promise.all([
    listInbox(caller.instanceId, MAX_STATUS_PAGE, db),
    listOwn(caller.accountId, MAX_STATUS_PAGE, db),
  ]);
  const seen = new Set<string>();
  const statuses: Status[] = [];
  for (const { status, sealedKey } of inbox) {
    seen.add(status.id);
    statuses.push(toStatus(status, sealedKey));
  }
  for (const status of own) {
    if (seen.has(status.id)) continue;
    statuses.push(toStatus(status, null));
  }
  statuses.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { statuses };
}

/** The author takes it down early. Nobody else can, and a stranger is not told it exists. */
export async function deleteStatus(caller: StatusCaller, statusId: string, deps: StatusServiceDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const now = deps.now?.() ?? new Date();
  const row = await requireOwn(caller, statusId, db);
  await markStatusDeleted(row.id, now, db);
}

/**
 * A viewer saw it.
 *
 * Whether their NAME travels with that is their own setting, and the count is
 * honest either way: the author sees how many people saw it and the names of
 * those who publish them, and cannot tell which of the two a missing name is.
 */
export async function viewStatus(caller: StatusCaller, statusId: string, deps: StatusServiceDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const now = deps.now?.() ?? new Date();
  const status = await findStatusById(statusId, db);
  if (!status) throw notFound("no such status");
  if (status.authorAccountId === caller.accountId) return; // your own is not a view
  if (!(await holdsKey(statusId, caller.instanceId, db))) throw notFound("no such status");

  const publishes = await statusViewReceiptsOf(db, [caller.accountId]);
  await recordView(
    {
      statusId,
      accountId: caller.accountId,
      published: publishes.has(caller.accountId),
      viewedAt: now,
      expiresAt: status.expiresAt,
    },
    db,
  );
}

/** Who has seen it — the author's question, and nobody else's. */
export async function listStatusViews(
  caller: StatusCaller,
  statusId: string,
  deps: StatusServiceDeps = {},
): Promise<ListStatusViewsResponse> {
  const db = deps.db ?? getDb();
  await requireOwn(caller, statusId, db);
  const summary = await listViews(statusId, db);
  return {
    views: summary.views.map((view) => ({ accountId: view.accountId, viewedAt: view.viewedAt.toISOString() })),
    total: summary.total,
  };
}

async function requireOwn(caller: StatusCaller, statusId: string, db: AlloDatabase): Promise<StatusRow> {
  const row = await findStatusById(statusId, db);
  // A status that is not yours answers the same as one that does not exist:
  // an id is not proof of anything, and a 403 would confirm it is real.
  if (!row) throw notFound("no such status");
  if (row.authorAccountId !== caller.accountId) throw notFound("no such status");
  if (row.authorInstanceId !== caller.instanceId && row.authorAccountId !== caller.accountId) throw forbidden("not yours");
  return row;
}
