/**
 * The bridge repositories, against a REAL Postgres server.
 *
 * Every claim these modules make is a claim about a STATEMENT — a conflict
 * branch that omits a column, a `FOR UPDATE` that orders two writers, a CHECK
 * that refuses a country code, a projection that withholds a seed. A mocked
 * `insert` accepts all of them equally, including the ones the server rejects
 * outright, so nothing short of a server can tell a working repository from a
 * plausible one.
 *
 * Nothing in `src/services` or `src/routes` imports these repositories yet; this
 * file is their only caller, and it is deliberately the only one until the
 * call-site switch lands.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, constraintNameOf, isCheckViolation, uuidv7 } from "@oxyhq/db";
import type postgres from "postgres";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import * as schema from "../../db/schema";
import {
  applyReportedState,
  countAccounts,
  deleteAccount,
  findAccountByNetworkRemoteLogin,
  findAccountByRemoteLogin,
  findAccountForUser,
  findSlotOwner,
  listAccountsForUser,
  markAccountNotified,
  markStaleAccountsFailed,
  reconcileAccount,
  upsertLinkedAccount,
} from "../../db/bridges/accounts";
import {
  closeLinkSession,
  completeLinkSession,
  findLinkSessionForUser,
  findOpenLinkSessions,
  insertLinkSession,
  recordLinkSessionStep,
} from "../../db/bridges/linkSessions";
import {
  acquireLease,
  findLease,
  listLeaseRotations,
  recordLeaseExit,
  rotateLease,
} from "../../db/bridges/proxyLeases";

let handle: TestDatabaseHandle;
let db: ReturnType<typeof createDatabase<typeof schema>>["db"];
let client: postgres.Sql;

/** Unique per call, so cases cannot collide inside the one shared database. */
let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

beforeAll(async () => {
  handle = await setUpTestDatabase();
  const created = createDatabase({ databaseUrl: handle.databaseUrl, schema });
  db = created.db;
  client = created.client;
}, 180_000);

afterAll(async () => {
  await client?.end();
  await handle?.drop();
});

describe("bridge_accounts — the upsert that replaces findOneAndUpdate(upsert)", () => {
  it("creates an account, and converges on the unique index rather than duplicating it", async () => {
    const oxyUserId = unique("user");
    const remoteLoginId = unique("login");
    const at = new Date();

    const first = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "telegram",
      remoteLoginId,
      at,
      remoteName: "Ada",
      spaceRoomId: "!space:allo.you",
      remoteProfileUsername: "ada",
    });
    expect(first.state).toBe("connecting");
    expect(first.remoteName).toBe("Ada");

    const second = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "telegram",
      remoteLoginId,
      at: new Date(at.getTime() + 1_000),
    });

    // The row is the same row: the caller's second id was discarded by the
    // database, which is what makes two concurrent completions of one login
    // produce one account instead of a duplicate-key error.
    expect(second.id).toBe(first.id);
    expect(await countAccounts(db, { oxyUserId, network: "telegram" })).toBe(1);
  });

  it("does NOT erase a detail the second call omits", async () => {
    // The port hazard `keepUnlessSupplied` exists for. A key Mongo never
    // receives is a key Mongo never writes; `excluded.remote_name` is NULL for
    // an absent value, and assigning it would wipe the display name the last
    // `whoami` established — silently, and visible only one call later.
    const oxyUserId = unique("user");
    const remoteLoginId = unique("login");
    const at = new Date();

    await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "slack",
      remoteLoginId,
      at,
      remoteName: "Grace",
      spaceRoomId: "!grace:allo.you",
      remoteProfileName: "Grace H",
      remoteProfileUsername: "grace",
      remoteProfilePhone: "+100",
      remoteProfileAvatarUrl: "mxc://a",
    });

    const kept = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "slack",
      remoteLoginId,
      at: new Date(at.getTime() + 1_000),
    });

    expect(kept.remoteName).toBe("Grace");
    expect(kept.spaceRoomId).toBe("!grace:allo.you");
    expect(kept.remoteProfileName).toBe("Grace H");
    expect(kept.remoteProfileUsername).toBe("grace");
    expect(kept.remoteProfilePhone).toBe("+100");
    expect(kept.remoteProfileAvatarUrl).toBe("mxc://a");
  });

  it("overwrites a detail the second call DOES supply", async () => {
    // The other half of the same statement: `coalesce` must not become "never
    // update", or a renamed remote account would keep its old name forever.
    const oxyUserId = unique("user");
    const remoteLoginId = unique("login");
    const at = new Date();

    await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "slack",
      remoteLoginId,
      at,
      remoteName: "Old",
    });
    const renamed = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "slack",
      remoteLoginId,
      at: new Date(at.getTime() + 1_000),
      remoteName: "New",
    });
    expect(renamed.remoteName).toBe("New");
  });

  it("keeps linked_at from the FIRST link, because a re-link is not a new one", async () => {
    const oxyUserId = unique("user");
    const remoteLoginId = unique("login");
    const first = new Date("2024-01-01T00:00:00.000Z");
    const later = new Date("2025-06-01T00:00:00.000Z");

    const created = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "telegram",
      remoteLoginId,
      at: first,
    });
    const relinked = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "telegram",
      remoteLoginId,
      at: later,
    });

    expect(created.linkedAt.toISOString()).toBe(first.toISOString());
    expect(relinked.linkedAt.toISOString()).toBe(first.toISOString());
    // `last_state_at` DOES move — it is when the state was last reported.
    expect(relinked.lastStateAt.toISOString()).toBe(later.toISOString());
  });
});

describe("bridge_accounts — reported state", () => {
  it("records a state event this deployment has never heard of", async () => {
    // `raw_state_event` carries no CHECK, deliberately. A refusal here would
    // drop the status update that tells an operator something changed — which
    // is exactly the update worth having when a bridge ships a new vocabulary.
    const oxyUserId = unique("user");
    const account = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "telegram",
      remoteLoginId: unique("login"),
      at: new Date(),
    });

    const updated = await applyReportedState(db, {
      id: account.id,
      state: "degraded",
      at: new Date(),
      rawStateEvent: "SOMETHING_NOBODY_HAS_SEEN_YET",
    });
    expect(updated?.rawStateEvent).toBe("SOMETHING_NOBODY_HAS_SEEN_YET");
  });

  it("replaces the whole raw state, so a cleared error does not linger", async () => {
    const account = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId: unique("user"),
      network: "telegram",
      remoteLoginId: unique("login"),
      at: new Date(),
    });

    const failing = await applyReportedState(db, {
      id: account.id,
      state: "action_required",
      at: new Date(),
      rawStateEvent: "BAD_CREDENTIALS",
      rawStateError: "FI.MAU.TELEGRAM.INVALID_PASSWORD",
      rawStateTtl: 3_600,
    });
    expect(failing?.rawStateError).toBe("FI.MAU.TELEGRAM.INVALID_PASSWORD");
    expect(failing?.rawStateTtl).toBe(3_600);

    const recovered = await applyReportedState(db, {
      id: account.id,
      state: "connected",
      at: new Date(),
      rawStateEvent: "CONNECTED",
    });
    // Mongo's `$set: { rawState: {…} }` replaced the subdocument wholesale, so
    // an absent error means there is no longer an error.
    expect(recovered?.rawStateError).toBeNull();
    expect(recovered?.rawStateTtl).toBeNull();
  });

  it("clears the notification marker when an account reaches connected", async () => {
    const account = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId: unique("user"),
      network: "telegram",
      remoteLoginId: unique("login"),
      at: new Date(),
    });
    await markAccountNotified(db, {
      id: account.id,
      state: "action_required",
      at: new Date(),
    });

    const recovered = await applyReportedState(db, {
      id: account.id,
      state: "connected",
      at: new Date(),
      rawStateEvent: "CONNECTED",
    });

    // Without this, a user who reconnects and is later logged out again would
    // never be told the second time.
    expect(recovered?.lastNotifiedState).toBeNull();
    expect(recovered?.lastNotifiedAt).toBeNull();
    expect(recovered?.lastConnectedAt).not.toBeNull();
  });

  it("clears it from the reconcile path too, which is a different writer", async () => {
    const account = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId: unique("user"),
      network: "telegram",
      remoteLoginId: unique("login"),
      at: new Date(),
    });
    await markAccountNotified(db, { id: account.id, state: "failed", at: new Date() });

    const reconciled = await reconcileAccount(db, {
      id: account.id,
      state: "connected",
      at: new Date(),
      remoteName: "Reconciled",
    });
    expect(reconciled?.lastNotifiedState).toBeNull();
    expect(reconciled?.lastConnectedAt).not.toBeNull();
    expect(reconciled?.remoteName).toBe("Reconciled");
  });
});

describe("bridge_accounts — the stale sweep, which was a Mongo $expr", () => {
  it("holds each account to its OWN reported TTL", async () => {
    /**
     * The sweep is deliberately UNSCOPED — it is a faithful port of an
     * `updateMany` with no user filter — so in a database shared with every
     * other case in this file, any neighbour's account could satisfy its
     * predicate and inflate the count. The clock is therefore set earlier than
     * every other timestamp this file writes (the oldest elsewhere is 2024),
     * which makes the fixtures below the only rows that can possibly be stale
     * and lets the count stay exact rather than becoming a toothless `>= 2`.
     */
    const now = new Date("2021-06-01T12:00:00.000Z");
    const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000);
    const tenHoursAgo = new Date(now.getTime() - 10 * 3_600_000);
    const oxyUserId = unique("user");

    const shortTtl = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "telegram",
      remoteLoginId: unique("login"),
      at: twoHoursAgo,
    });
    await applyReportedState(db, {
      id: shortTtl.id,
      state: "connected",
      at: twoHoursAgo,
      rawStateEvent: "CONNECTED",
      rawStateTtl: 3_600,
    });

    const longTtl = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "slack",
      remoteLoginId: unique("login"),
      at: twoHoursAgo,
    });
    await applyReportedState(db, {
      id: longTtl.id,
      state: "connected",
      at: twoHoursAgo,
      rawStateEvent: "CONNECTED",
      rawStateTtl: 21_600,
    });

    // No TTL ever reported: held to the caller's default rather than to no
    // budget at all, which is how a dead process stays green forever.
    const noTtl = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "discord",
      remoteLoginId: unique("login"),
      at: tenHoursAgo,
    });
    await reconcileAccount(db, { id: noTtl.id, state: "connecting", at: tenHoursAgo });

    const stillLinking = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "whatsapp",
      remoteLoginId: unique("login"),
      at: tenHoursAgo,
    });
    await reconcileAccount(db, { id: stillLinking.id, state: "linking", at: tenHoursAgo });

    const alreadyFailed = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "instagram",
      remoteLoginId: unique("login"),
      at: tenHoursAgo,
    });
    await reconcileAccount(db, { id: alreadyFailed.id, state: "failed", at: tenHoursAgo });

    const marked = await markStaleAccountsFailed(db, {
      now,
      marginSeconds: 300,
      defaultTtlSeconds: 21_600,
    });
    expect(marked).toBe(2);

    const after = await listAccountsForUser(db, oxyUserId);
    const stateOf = (id: string) => after.find((row) => row.id === id)?.state;

    expect(stateOf(shortTtl.id)).toBe("failed");
    expect(stateOf(noTtl.id)).toBe("failed");
    // Six hours of budget and two hours of silence: healthy.
    expect(stateOf(longTtl.id)).toBe("connected");
    // An attempt in progress has no reported state; its own expiry governs it.
    expect(stateOf(stillLinking.id)).toBe("linking");
    expect(stateOf(alreadyFailed.id)).toBe("failed");

    const swept = after.find((row) => row.id === shortTtl.id);
    expect(swept?.rawStateReason).toBe("stale");
    // The bridge's own last word is left intact beside the sweep's reason.
    expect(swept?.rawStateEvent).toBe("CONNECTED");
  });
});

describe("bridge_accounts — lookups", () => {
  it("scopes a lookup by oxyUserId, so an id alone is never enough", async () => {
    const owner = unique("user");
    const stranger = unique("user");
    const account = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId: owner,
      network: "telegram",
      remoteLoginId: unique("login"),
      at: new Date(),
    });

    expect(await findAccountForUser(db, { oxyUserId: owner, id: account.id })).toBeDefined();
    expect(
      await findAccountForUser(db, { oxyUserId: stranger, id: account.id }),
    ).toBeUndefined();
  });

  it("finds an account by network and remote login when a report names no user", async () => {
    const oxyUserId = unique("user");
    const remoteLoginId = unique("login");
    await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "telegram",
      remoteLoginId,
      at: new Date(),
    });

    const scoped = await findAccountByRemoteLogin(db, {
      oxyUserId,
      network: "telegram",
      remoteLoginId,
    });
    const fallback = await findAccountByNetworkRemoteLogin(db, {
      network: "telegram",
      remoteLoginId,
    });
    expect(fallback?.id).toBe(scoped?.id);
  });

  it("resolves a slot to its owner and nothing else", async () => {
    const oxyUserId = unique("user");
    const slotId = unique("slot");
    const account = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "whatsapp",
      remoteLoginId: unique("login"),
      at: new Date(),
    });
    await db
      .update(schema.bridgeAccounts)
      .set({ slotId })
      .where(eq(schema.bridgeAccounts.id, account.id));

    const owner = await findSlotOwner(db, slotId);
    expect(owner).toEqual({ oxyUserId, network: "whatsapp" });
    // Named columns, not a whole row: this runs on the bridge's connect path.
    expect(Object.keys(owner ?? {}).sort()).toEqual(["network", "oxyUserId"]);
    expect(await findSlotOwner(db, unique("slot"))).toBeUndefined();
  });

  it("reports whether a delete removed anything", async () => {
    const account = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId: unique("user"),
      network: "telegram",
      remoteLoginId: unique("login"),
      at: new Date(),
    });
    expect(await deleteAccount(db, account.id)).toBe(true);
    expect(await deleteAccount(db, account.id)).toBe(false);
  });
});

describe("bridge_link_sessions — expiry is the query's business, not the sweep's", () => {
  it("returns an EXPIRED attempt, so the caller can answer 410 rather than 404", async () => {
    // The sweep lags, exactly as Mongo's TTL monitor lagged its check interval,
    // and this read must not pretend otherwise. Filtering here would collapse
    // "this attempt expired" into "no such attempt" — the distinction the
    // `expired` outcome exists to preserve.
    const oxyUserId = unique("user");
    const linkId = unique("lnk");
    await insertLinkSession(db, {
      id: uuidv7(),
      linkId,
      oxyUserId,
      network: "telegram",
      flowId: "phone",
      remoteLoginProcessId: unique("proc"),
      currentStepId: "step-1",
      currentStepType: "user_input",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const found = await findLinkSessionForUser(db, { oxyUserId, linkId });
    expect(found).toBeDefined();
    expect(found?.outcome).toBe("pending");
    expect(found?.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it("excludes an expired attempt from the OPEN-attempt question", async () => {
    // The read where a lagging sweep changes the ANSWER rather than the row
    // count, so the deadline is part of the predicate.
    const oxyUserId = unique("user");
    await insertLinkSession(db, {
      id: uuidv7(),
      linkId: unique("lnk"),
      oxyUserId,
      network: "telegram",
      flowId: "phone",
      remoteLoginProcessId: unique("proc"),
      expiresAt: new Date(Date.now() - 60_000),
    });
    const live = await insertLinkSession(db, {
      id: uuidv7(),
      linkId: unique("lnk"),
      oxyUserId,
      network: "telegram",
      flowId: "phone",
      remoteLoginProcessId: unique("proc"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const cancelled = await insertLinkSession(db, {
      id: uuidv7(),
      linkId: unique("lnk"),
      oxyUserId,
      network: "telegram",
      flowId: "phone",
      remoteLoginProcessId: unique("proc"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await closeLinkSession(db, { id: cancelled.id, outcome: "cancelled", at: new Date() });

    const open = await findOpenLinkSessions(db, {
      oxyUserId,
      network: "telegram",
      now: new Date(),
    });
    expect(open.map((row) => row.id)).toEqual([live.id]);
  });

  it("withholds the bridge's login-process handle from the open-attempt read", async () => {
    const oxyUserId = unique("user");
    const linkId = unique("lnk");
    await insertLinkSession(db, {
      id: uuidv7(),
      linkId,
      oxyUserId,
      network: "telegram",
      flowId: "phone",
      remoteLoginProcessId: unique("proc"),
      currentStepId: "step-1",
      currentStepType: "user_input",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const open = await findOpenLinkSessions(db, {
      oxyUserId,
      network: "telegram",
      now: new Date(),
    });
    expect(open).toHaveLength(1);
    const keys = Object.keys(open[0]);
    // Positive floor first: an empty projection would satisfy the exclusions
    // below without withholding anything.
    expect(keys).toContain("linkId");
    expect(keys).toContain("outcome");
    expect(keys).not.toContain("remoteLoginProcessId");
    expect(keys).not.toContain("currentStepId");

    // The relay read is the ONE opt-in, and it really does carry them.
    const relay = await findLinkSessionForUser(db, { oxyUserId, linkId });
    expect(relay?.remoteLoginProcessId).toBeTruthy();
    expect(relay?.currentStepId).toBe("step-1");
  });
});

describe("bridge_link_sessions — the lifecycle of one attempt", () => {
  it("advances a step with the deadline that step earns", async () => {
    const session = await insertLinkSession(db, {
      id: uuidv7(),
      linkId: unique("lnk"),
      oxyUserId: unique("user"),
      network: "telegram",
      flowId: "phone",
      remoteLoginProcessId: unique("proc"),
      currentStepId: "step-1",
      currentStepType: "user_input",
      expiresAt: new Date(Date.now() + 600_000),
    });

    const shorter = new Date(Date.now() + 170_000);
    const advanced = await recordLinkSessionStep(db, {
      id: session.id,
      currentStepId: "step-2",
      currentStepType: "display_and_wait",
      expiresAt: shorter,
      at: new Date(),
    });
    expect(advanced?.currentStepType).toBe("display_and_wait");
    expect(advanced?.expiresAt.toISOString()).toBe(shorter.toISOString());
  });

  it("keeps a completed attempt after the account it produced is unlinked", async () => {
    // `result_account_id` was a bare ObjectId nothing checked. As a real FK with
    // ON DELETE SET NULL the session outlives the account — it is the record of
    // an ATTEMPT — without pointing at one that is gone.
    const oxyUserId = unique("user");
    const account = await upsertLinkedAccount(db, {
      id: uuidv7(),
      oxyUserId,
      network: "telegram",
      remoteLoginId: unique("login"),
      at: new Date(),
    });
    const linkId = unique("lnk");
    const session = await insertLinkSession(db, {
      id: uuidv7(),
      linkId,
      oxyUserId,
      network: "telegram",
      flowId: "phone",
      remoteLoginProcessId: unique("proc"),
      expiresAt: new Date(Date.now() + 600_000),
    });

    const completed = await completeLinkSession(db, {
      id: session.id,
      currentStepId: "step-final",
      resultAccountId: account.id,
      at: new Date(),
    });
    expect(completed?.outcome).toBe("completed");
    expect(completed?.resultAccountId).toBe(account.id);

    await deleteAccount(db, account.id);

    const survivor = await findLinkSessionForUser(db, { oxyUserId, linkId });
    expect(survivor?.outcome).toBe("completed");
    expect(survivor?.resultAccountId).toBeNull();
  });

  it("records a failure code beside a failed outcome", async () => {
    const session = await insertLinkSession(db, {
      id: uuidv7(),
      linkId: unique("lnk"),
      oxyUserId: unique("user"),
      network: "telegram",
      flowId: "phone",
      remoteLoginProcessId: unique("proc"),
      expiresAt: new Date(Date.now() + 600_000),
    });
    const closed = await closeLinkSession(db, {
      id: session.id,
      outcome: "failed",
      failureCode: "FI.MAU.TELEGRAM.PHONE_CODE_INVALID",
      at: new Date(),
    });
    expect(closed?.outcome).toBe("failed");
    expect(closed?.failureCode).toBe("FI.MAU.TELEGRAM.PHONE_CODE_INVALID");
  });
});

describe("bridge_proxy_leases — acquisition converges on the unique index", () => {
  it("creates a lease, and reports that it did", async () => {
    const oxyUserId = unique("user");
    const { lease, created } = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "whatsapp",
      provider: "provider-a",
      countryCode: "ES",
      regionCode: "MD",
      sessionSeed: "seed-one",
      at: new Date(),
    });
    expect(created).toBe(true);
    expect(lease.state).toBe("active");
    expect(lease.countryCode).toBe("ES");
  });

  it("returns an existing lease UNTOUCHED, however different today's candidate is", async () => {
    // §8.3 rules 2, 3 and 7 in one statement: `country_code`, `region_code` and
    // `session_seed` are absent from the conflict branch, so no acquisition can
    // move a user's geography or hand them a new session — not because the
    // caller checked first, but because the SET list has nowhere to put it.
    const oxyUserId = unique("user");
    const first = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "whatsapp",
      provider: "provider-a",
      countryCode: "ES",
      regionCode: "MD",
      sessionSeed: "seed-original",
      at: new Date(),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "whatsapp",
      provider: "provider-b",
      countryCode: "DE",
      regionCode: "BE",
      sessionSeed: "seed-replacement",
      at: new Date(),
    });

    expect(second.created).toBe(false);
    expect(second.lease.id).toBe(first.lease.id);
    expect(second.lease.countryCode).toBe("ES");
    expect(second.lease.regionCode).toBe("MD");
    expect(second.lease.sessionSeed).toBe("seed-original");
    expect(second.lease.provider).toBe("provider-a");
    // A conflict branch that changed nothing must not claim it changed
    // something: `updated_at` is guarded by the same predicate as the revival.
    expect(second.lease.updatedAt.toISOString()).toBe(first.lease.updatedAt.toISOString());
  });

  it("does NOT quietly reactivate a quarantined lease", async () => {
    // Quarantine is a decision about a geography we no longer trust. Undoing it
    // on the next link attempt would connect from the country already judged
    // wrong.
    const oxyUserId = unique("user");
    const created = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "instagram",
      provider: "provider-a",
      countryCode: "ES",
      sessionSeed: "seed-q",
      at: new Date(),
    });
    await recordLeaseExit(db, {
      id: created.lease.id,
      observedIp: "203.0.113.7",
      observedCountry: "DE",
      at: new Date(),
      quarantine: true,
    });

    const reacquired = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "instagram",
      provider: "provider-a",
      countryCode: "ES",
      sessionSeed: "seed-new",
      at: new Date(),
    });
    expect(reacquired.lease.state).toBe("quarantined");
  });

  it("revives a released lease in place, keeping its country and its seed", async () => {
    const oxyUserId = unique("user");
    const created = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "messenger",
      provider: "provider-a",
      countryCode: "ES",
      sessionSeed: "seed-kept",
      at: new Date(),
    });
    await db
      .update(schema.bridgeProxyLeases)
      .set({ state: "released", releasedAt: new Date() })
      .where(eq(schema.bridgeProxyLeases.id, created.lease.id));

    const revived = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "messenger",
      provider: "provider-b",
      countryCode: "DE",
      sessionSeed: "seed-ignored",
      at: new Date(),
    });

    expect(revived.created).toBe(false);
    expect(revived.lease.state).toBe("active");
    expect(revived.lease.releasedAt).toBeNull();
    // Releasing is an operational act; it does not make the user's home country
    // a different country.
    expect(revived.lease.countryCode).toBe("ES");
    expect(revived.lease.sessionSeed).toBe("seed-kept");
  });

  it("gives eight concurrent acquisitions one lease, without a retry anywhere", async () => {
    const oxyUserId = unique("user");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        acquireLease(db, {
          id: uuidv7(),
          oxyUserId,
          network: "whatsapp",
          provider: "provider-a",
          countryCode: "ES",
          sessionSeed: `seed-${String(index)}`,
          at: new Date(),
        }),
      ),
    );

    const ids = new Set(results.map((result) => result.lease.id));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    // Every caller ends up on the winner's seed, so no lease is silently
    // orphaned the way the Mongo race's loser was.
    const seeds = new Set(results.map((result) => result.lease.sessionSeed));
    expect(seeds.size).toBe(1);
  });

  /**
   * Both halves of `^[A-Z]{2}$`, separately.
   *
   * `"esp"` alone is not enough, and finding that out cost a surviving
   * mutation: it is wrong on BOTH axes at once, so a repository that
   * "helpfully" upper-cased the input would still be refused (`"ESP"` is three
   * letters) and the case-sensitivity of the constraint would go untested.
   * `"es"` is wrong on the CASE axis only, which is the one input shape that
   * tells a normalizing repository from one that stores what it was given.
   */
  it.each([
    ["wrong length", "esp"],
    ["wrong case", "es"],
  ])("refuses a country code with the %s", async (_axis, countryCode) => {
    const error = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId: unique("user"),
      network: "whatsapp",
      provider: "provider-a",
      countryCode,
      sessionSeed: "seed",
      at: new Date(),
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).not.toBeNull();
    expect(isCheckViolation(error)).toBe(true);
    // Named, not matched on a message: drizzle wraps the driver error, so the
    // constraint name lives on `cause` and a regex over the text would pass for
    // the wrong constraint.
    expect(constraintNameOf(error)).toBe("bridge_proxy_leases_country_code_check");
  });
});

describe("bridge_proxy_leases — the egress identity never leaves in a read", () => {
  it("never returns last_exit_ip, not even to the path that wrote it", async () => {
    const oxyUserId = unique("user");
    const created = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "whatsapp",
      provider: "provider-a",
      countryCode: "ES",
      sessionSeed: "seed-ip",
      at: new Date(),
    });
    const observed = await recordLeaseExit(db, {
      id: created.lease.id,
      observedIp: "198.51.100.9",
      observedCountry: "ES",
      at: new Date(),
      quarantine: false,
    });

    const keys = Object.keys(observed ?? {});
    expect(keys).toContain("lastExitCountry");
    // The seed IS the one protected column this domain legitimately needs, and
    // it is opted into by name in exactly one place.
    expect(keys).toContain("sessionSeed");
    expect(keys).not.toContain("lastExitIp");

    // The row really was written; only the projection withholds it.
    const stored = await client<{ last_exit_ip: string }[]>`
      select last_exit_ip from bridge_proxy_leases where id = ${created.lease.id}
    `;
    expect(stored[0].last_exit_ip).toBe("198.51.100.9");
    expect(observed?.lastExitCountry).toBe("ES");

    const found = await findLease(db, { oxyUserId, network: "whatsapp" });
    expect(Object.keys(found ?? {})).not.toContain("lastExitIp");
  });
});

describe("bridge_proxy_lease_rotations — append-only evidence", () => {
  it("appends a rotation and never replaces the history", async () => {
    const oxyUserId = unique("user");
    const created = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "whatsapp",
      provider: "provider-a",
      countryCode: "ES",
      regionCode: "MD",
      sessionSeed: "seed-0",
      at: new Date(),
    });

    for (const [index, reason] of (
      ["provider_retired", "ban_quarantine", "operator_forced"] as const
    ).entries()) {
      const rotated = await rotateLease(db, {
        oxyUserId,
        network: "whatsapp",
        rotationId: uuidv7(),
        toSeed: `seed-${String(index + 1)}`,
        reason,
        at: new Date(Date.now() + index * 1_000),
      });
      expect(rotated?.lease.sessionSeed).toBe(`seed-${String(index + 1)}`);
      // Rotation is always WITHIN country (§8.3 rule 4).
      expect(rotated?.lease.countryCode).toBe("ES");
      expect(rotated?.lease.regionCode).toBe("MD");
    }

    const chain = await client<{ from_seed: string; to_seed: string; reason: string }[]>`
      select from_seed, to_seed, reason from bridge_proxy_lease_rotations
      where lease_id = ${created.lease.id} order by rotated_at
    `;
    // Three rows, not one overwritten three times — which is exactly what an
    // embedded array could not guarantee.
    expect(chain).toHaveLength(3);
    expect(chain.map((row) => [row.from_seed, row.to_seed])).toEqual([
      ["seed-0", "seed-1"],
      ["seed-1", "seed-2"],
      ["seed-2", "seed-3"],
    ]);
    expect(chain.map((row) => row.reason)).toEqual([
      "provider_retired",
      "ban_quarantine",
      "operator_forced",
    ]);
  });

  it("returns a lease to active, which is what makes rotation the remedy for a quarantine", async () => {
    const oxyUserId = unique("user");
    const created = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "instagram",
      provider: "provider-a",
      countryCode: "ES",
      sessionSeed: "seed-q0",
      at: new Date(),
    });
    await recordLeaseExit(db, {
      id: created.lease.id,
      observedIp: "203.0.113.1",
      observedCountry: "DE",
      at: new Date(),
      quarantine: true,
    });

    const rotated = await rotateLease(db, {
      oxyUserId,
      network: "instagram",
      rotationId: uuidv7(),
      toSeed: "seed-q1",
      reason: "ban_quarantine",
      at: new Date(),
    });
    expect(rotated?.lease.state).toBe("active");
  });

  it("chains concurrent rotations instead of recording the same predecessor twice", async () => {
    // The race the Mongo version had: `sessionSeed` was read in one query and
    // pushed as `fromSeed` in another, so two rotations could both name the
    // seed that only one of them replaced. `FOR UPDATE` in the same transaction
    // as the swap is what orders them.
    const oxyUserId = unique("user");
    const created = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "whatsapp",
      provider: "provider-a",
      countryCode: "ES",
      sessionSeed: "race-0",
      at: new Date(),
    });

    await Promise.all([
      rotateLease(db, {
        oxyUserId,
        network: "whatsapp",
        rotationId: uuidv7(),
        toSeed: "race-a",
        reason: "operator_forced",
        at: new Date(),
      }),
      rotateLease(db, {
        oxyUserId,
        network: "whatsapp",
        rotationId: uuidv7(),
        toSeed: "race-b",
        reason: "operator_forced",
        at: new Date(),
      }),
    ]);

    const rows = await client<{ from_seed: string; to_seed: string }[]>`
      select from_seed, to_seed from bridge_proxy_lease_rotations
      where lease_id = ${created.lease.id}
    `;
    expect(rows).toHaveLength(2);
    // Whichever order they landed in, the two must form a CHAIN: one starts at
    // the original seed, and the other starts where that one ended. Two rows
    // both reading `race-0` is the corruption this test exists to catch.
    const first = rows.find((row) => row.from_seed === "race-0");
    const second = rows.find((row) => row.from_seed !== "race-0");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.from_seed).toBe(first?.to_seed);
  });

  it("shows an operator WHEN and WHY, and never the seeds themselves", async () => {
    const oxyUserId = unique("user");
    const created = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "messenger",
      provider: "provider-a",
      countryCode: "ES",
      sessionSeed: "ev-0",
      at: new Date(),
    });
    await rotateLease(db, {
      oxyUserId,
      network: "messenger",
      rotationId: uuidv7(),
      toSeed: "ev-1",
      reason: "provider_retired",
      at: new Date(),
    });

    const evidence = await listLeaseRotations(db, created.lease.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].reason).toBe("provider_retired");
    const keys = Object.keys(evidence[0]);
    expect(keys).toContain("rotatedAt");
    expect(keys).not.toContain("fromSeed");
    expect(keys).not.toContain("toSeed");
  });

  it("answers undefined when there is no lease to rotate", async () => {
    const rotated = await rotateLease(db, {
      oxyUserId: unique("user"),
      network: "whatsapp",
      rotationId: uuidv7(),
      toSeed: "nothing",
      reason: "operator_forced",
      at: new Date(),
    });
    expect(rotated).toBeUndefined();
  });

  it("cascades the history when its lease is deleted", async () => {
    const oxyUserId = unique("user");
    const created = await acquireLease(db, {
      id: uuidv7(),
      oxyUserId,
      network: "whatsapp",
      provider: "provider-a",
      countryCode: "ES",
      sessionSeed: "cascade-0",
      at: new Date(),
    });
    await rotateLease(db, {
      oxyUserId,
      network: "whatsapp",
      rotationId: uuidv7(),
      toSeed: "cascade-1",
      reason: "operator_forced",
      at: new Date(),
    });
    expect(await listLeaseRotations(db, created.lease.id)).toHaveLength(1);

    await db
      .delete(schema.bridgeProxyLeases)
      .where(eq(schema.bridgeProxyLeases.id, created.lease.id));
    expect(await listLeaseRotations(db, created.lease.id)).toHaveLength(0);
  });
});
