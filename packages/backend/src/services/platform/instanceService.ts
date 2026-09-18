/**
 * Enrollment and the instance lifecycle (`docs/platform/api-v1.md`, Instances).
 */

import { randomBytes } from "node:crypto";
import {
  base64UrlEncode,
  enrollmentApprovalMessage,
  type ClientInstance,
  type PublicInstance,
  type RegisterInstanceRequest,
  type RegisterInstanceResponse,
  type SetPushTokenRequest,
  type SetTransferKeyRequest,
} from "@allo/shared-types";
import { getDb, type AlloDatabase } from "../../db";
import {
  listConversationIdsWithLiveLeaf,
  listConversationsAwaitingAccountLeaf,
  markLeafRemoved,
} from "../../db/platform/conversationRepository";
import { appendControlEvent } from "../../db/platform/eventRepository";
import {
  activateInstance,
  clearPushToken,
  countActiveInstances,
  findInstanceById,
  insertInstance,
  listInstancesByAccount,
  listInstancesByAccountAndStatus,
  revokeInstance as revokeInstanceRow,
  setPushToken,
  setTransferPublicKey,
  type InstanceRow,
} from "../../db/platform/instanceRepository";
import { verifyEd25519 } from "../../middleware/instanceAuth";
import { getRealtime } from "../../runtime/realtime";
import { AlloHttpError, forbidden, notFound, unauthorized } from "../../utils/httpErrors";
import { toClientInstance, toPublicInstance } from "./wire";
import { logger } from "../../utils/logger";

export interface InstanceServiceDeps {
  db?: AlloDatabase;
}

/** Bootstrap rule: zero active instances ⇒ active at once; otherwise pending with a challenge. */
export async function registerInstance(
  accountId: string,
  request: RegisterInstanceRequest,
  deps: InstanceServiceDeps = {},
): Promise<RegisterInstanceResponse> {
  const db = deps.db ?? getDb();
  const response = await db.transaction(async (tx): Promise<RegisterInstanceResponse> => {
    const active = await countActiveInstances(accountId, tx);
    const bootstrap = active === 0;
    const challenge = bootstrap ? null : base64UrlEncode(randomBytes(32));
    let row: InstanceRow;
    try {
      row = await insertInstance(
        {
          accountId,
          appId: request.appId,
          platform: request.platform,
          displayName: request.displayName,
          signingPublicKey: request.signingPublicKey,
          transferPublicKey: request.transferPublicKey,
          status: bootstrap ? "active" : "pending",
          enrollmentChallenge: challenge,
        },
        tx,
      );
    } catch (error: unknown) {
      const { isUniqueViolation } = await import("@oxy.so/db");
      if (isUniqueViolation(error, "client_instances_account_id_signing_public_key_key")) {
        throw new AlloHttpError("idempotency_conflict", "This signing key is already enrolled on the account");
      }
      throw error;
    }
    const instance = toClientInstance(row);
    return bootstrap
      ? { instance, enrollment: "active" }
      : { instance, enrollment: "pending", challenge: challenge as string };
  });
  if (response.enrollment === "active") await nudgeConversationsAwaitingAccount(accountId, db);
  return response;
}

/**
 * An instance just became `active`. A conversation may already count its
 * account as a `joined` member with NO active leaf — created while the account
 * had no instance to add — and its electors would otherwise notice the new
 * leaf only on their sync interval. Nudge every active leaf of each such
 * conversation so an elector adds it now. Called after the activating
 * transaction has committed, so a nudged client that syncs at once sees the
 * instance in the account's listing.
 */
async function nudgeConversationsAwaitingAccount(accountId: string, db: AlloDatabase): Promise<void> {
  // Best effort: the activating write has committed, and a failed nudge must
  // not turn a successful registration or approval into a 500. The electors
  // still find the new leaf on their sync interval.
  try {
    const awaiting = await listConversationsAwaitingAccountLeaf(accountId, db);
    const realtime = getRealtime();
    for (const { conversationId, activeLeafInstanceIds } of awaiting) {
      realtime.nudge(activeLeafInstanceIds, { conversationId });
    }
  } catch (error) {
    logger.warn("nudging conversations awaiting an account failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function listOwnInstances(accountId: string, deps: InstanceServiceDeps = {}): Promise<ClientInstance[]> {
  const rows = await listInstancesByAccount(accountId, deps.db ?? getDb());
  return rows.map(toClientInstance);
}

/**
 * Another account's view: every ACTIVE and REVOKED instance, each with its
 * status, never a pending one. Revoked ones stay in the listing because a
 * chain verifier needs the approver's key even after the approver was
 * revoked — what it approved still chains ("verified but not trusted"), while
 * an approver missing from the listing makes the whole chain refuse. A
 * pending instance is nobody's yet and its challenge is still a secret.
 *
 * An account Allo has never seen answers an EMPTY list, not 404: "no device
 * yet" is a state a client asks about on purpose (a chat opened with someone
 * who has not installed Allo polls this until they do), and every browser
 * prints a 4xx to the console on each poll. The listing also reveals nothing
 * about whether an Oxy account exists that the empty list does not.
 */
export async function listPublicInstances(
  accountId: string,
  deps: InstanceServiceDeps = {},
): Promise<PublicInstance[]> {
  const db = deps.db ?? getDb();
  const all = await listInstancesByAccount(accountId, db);
  return all.filter((row) => row.status !== "pending").map(toPublicInstance);
}

export async function listPendingEnrollments(
  accountId: string,
  deps: InstanceServiceDeps = {},
): Promise<{ instance: ClientInstance; challenge: string }[]> {
  const rows = await listInstancesByAccountAndStatus(accountId, "pending", deps.db ?? getDb());
  return rows
    .filter((row) => row.enrollmentChallenge !== null)
    .map((row) => ({ instance: toClientInstance(row), challenge: row.enrollmentChallenge as string }));
}

/** Load an instance of the caller's account, or `not_found`. Another account's is also `not_found`: nothing leaks. */
async function requireOwnInstance(accountId: string, id: string, db: AlloDatabase): Promise<InstanceRow> {
  const row = await findInstanceById(id, db);
  if (!row || row.accountId !== accountId) throw notFound("Instance not found");
  return row;
}

export async function approveInstance(
  approver: { id: string; accountId: string },
  targetId: string,
  approvalSignature: string,
  deps: InstanceServiceDeps = {},
): Promise<ClientInstance> {
  const db = deps.db ?? getDb();
  const approverRow = await findInstanceById(approver.id, db);
  if (!approverRow || approverRow.status !== "active") throw forbidden("Only an active instance may approve");
  const target = await requireOwnInstance(approver.accountId, targetId, db);
  if (target.status !== "pending" || target.enrollmentChallenge === null) {
    throw new AlloHttpError("idempotency_conflict", "The instance is not awaiting approval");
  }
  const message = enrollmentApprovalMessage({
    accountId: approver.accountId,
    newInstanceId: target.id,
    newSigningPublicKey: target.signingPublicKey,
    challenge: target.enrollmentChallenge,
  });
  if (!verifyEd25519(message, approvalSignature, approverRow.signingPublicKey)) {
    throw unauthorized("The approval signature does not verify against the approving instance's key");
  }
  const activated = await activateInstance(target.id, { approvedByInstanceId: approver.id, approvalSignature }, db);
  if (!activated) throw new AlloHttpError("idempotency_conflict", "The instance was resolved concurrently");
  getRealtime().instanceApproved(activated.id, { instanceId: activated.id });
  await nudgeConversationsAwaitingAccount(approver.accountId, db);
  return toClientInstance(activated);
}

export async function rejectInstance(
  caller: { id: string; accountId: string },
  targetId: string,
  deps: InstanceServiceDeps = {},
): Promise<ClientInstance> {
  const db = deps.db ?? getDb();
  const target = await requireOwnInstance(caller.accountId, targetId, db);
  if (target.status !== "pending") throw new AlloHttpError("idempotency_conflict", "The instance is not pending");
  const row = await revokeInstanceRow(target.id, db);
  if (!row) throw notFound("Instance not found");
  return toClientInstance(row);
}

/**
 * Revoke: status `revoked`; every conversation where the instance holds a live
 * leaf gets the leaf marked `removed` (with no epoch — no commit has removed it
 * from the MLS group yet) and a `control` event to every other active leaf;
 * then the instance's sockets are cut. The revoked instance hears
 * `instance.revoked` on the account room before the disconnect.
 */
export async function revokeInstance(
  caller: { id: string; accountId: string },
  targetId: string,
  deps: InstanceServiceDeps = {},
): Promise<ClientInstance> {
  const db = deps.db ?? getDb();
  const target = await requireOwnInstance(caller.accountId, targetId, db);
  if (target.status === "revoked") return toClientInstance(target);

  const conversationIds = await listConversationIdsWithLiveLeaf(target.id, db);
  const nudges = new Map<string, string[]>();
  const row = await db.transaction(async (tx) => {
    const revoked = await revokeInstanceRow(target.id, tx);
    for (const conversationId of conversationIds) {
      await markLeafRemoved(conversationId, target.id, null, tx);
      const appended = await appendControlEvent(
        {
          conversationId,
          control: { t: "instance_revoked", instanceId: target.id, accountId: target.accountId },
          excludeInstanceIds: [target.id],
        },
        tx,
      );
      nudges.set(conversationId, appended.recipients);
    }
    return revoked;
  });
  if (!row) throw notFound("Instance not found");

  const realtime = getRealtime();
  realtime.instanceRevoked(target.accountId, { instanceId: target.id });
  for (const [conversationId, recipients] of nudges) realtime.nudge(recipients, { conversationId });
  await realtime.disconnectInstance(target.id);
  return toClientInstance(row);
}

/**
 * `PUT /v1/instances/me/transfer-key`: a Phase 2 instance (registered before
 * the field existed, `transferPublicKey: null`) publishes the X25519 key that
 * history can be sealed to; a later call rotates it. An offer sealed to the
 * OLD key stays on the row and will not open — the recipient sees a decrypt
 * failure, not the server — so a client rotates only when it has lost the key.
 */
export async function setInstanceTransferKey(
  instanceId: string,
  request: SetTransferKeyRequest,
  deps: InstanceServiceDeps = {},
): Promise<ClientInstance> {
  const row = await setTransferPublicKey(instanceId, request.transferPublicKey, deps.db ?? getDb());
  if (!row) throw notFound("Instance not found");
  return toClientInstance(row);
}

export async function setInstancePushToken(
  instanceId: string,
  request: SetPushTokenRequest,
  deps: InstanceServiceDeps = {},
): Promise<void> {
  await setPushToken(instanceId, request.provider, request.token, deps.db ?? getDb());
}

export async function clearInstancePushToken(instanceId: string, deps: InstanceServiceDeps = {}): Promise<void> {
  await clearPushToken(instanceId, deps.db ?? getDb());
}
