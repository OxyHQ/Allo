/**
 * The moderation repositories, against a REAL Postgres server.
 *
 * Every claim in `db/moderation/` is a property only a server has: a transaction
 * that rolls both writes back, a primary key that answers "already seen" as a
 * value, `for update skip locked` handing two dispatchers different rows, and an
 * `on conflict do nothing` that leaves the tuple untouched. A mocked `insert`
 * accepts any statement — including one the server rejects outright — which is
 * exactly why this backend already boots a real Mongo replica set for the
 * moderation suite it is replacing rather than mocking the model.
 *
 * ## The concurrency cases hold a real lock
 *
 * `SKIP LOCKED` cannot be observed sequentially: one claim after another passes
 * whether or not it is there. So both concurrency cases below run claims that
 * OVERLAP in time — one with N claims in flight at once, one with the contended
 * row's lock held open inside a transaction.
 *
 * Only the SECOND of those discriminates, which is worth stating because the first
 * is the one that looks like the concurrency test. Mutation-tested by deleting
 * `skip locked` from the claim: the N-way race still PASSES, because under READ
 * COMMITTED a plain `for update` merely serialises the claimers and each one
 * re-reads and lands on a different row; the held-lock case deadlocks until the
 * test times out, because the claim it is waiting on cannot commit until it
 * returns. Do not delete that case as redundant with the race — it is the only one
 * that fails.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDatabase, constraintNameOf, isUniqueViolation } from "@oxyhq/db";
import type postgres from "postgres";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import * as schema from "../../db/schema";
import {
  MissingTransactionError,
  requireTransaction,
} from "../../db/moderation/transactionGuard";
import {
  claimModerationOutboxEvent,
  completeModerationOutboxEvent,
  enqueueModerationOutboxEvent,
  MODERATION_OUTBOX_RETENTION_SECONDS,
  releaseModerationOutboxEvent,
  renewModerationOutboxEvent,
} from "../../db/moderation/moderationOutboxRepository";
import {
  claimModerationEvent,
  markModerationEventIgnored,
  markModerationEventQueued,
  releaseModerationEvent,
} from "../../db/moderation/moderationEventRepository";
import {
  applyReportDecision,
  closeUndeliverableReport,
  findReportByCaseId,
  findReportById,
  findReportBySubject,
  insertReport,
  listReportsByReporter,
  markReportDeliveryFailed,
  markReportSubmitted,
} from "../../db/moderation/reportRepository";

let handle: TestDatabaseHandle;
let db: ReturnType<typeof createDatabase<typeof schema>>["db"];
let client: postgres.Sql;

/** Unique per call so cases cannot collide inside the one shared database. */
let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function future(): Date {
  return new Date(Date.now() + HOUR_MS);
}

/** The row's transaction id and its application-maintained timestamp, as TEXT. */
async function outboxTuple(eventId: string): Promise<{ xmin: string; updated_at: string }> {
  const rows = await client<{ xmin: string; updated_at: string }[]>`
    select xmin::text, updated_at::text from moderation_outbox where id = ${eventId}
  `;
  return rows[0];
}

async function insertDueOutboxEvent(eventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await enqueueModerationOutboxEvent(
      { eventId, kind: "report.submit", payload: { reportId: id("report") } },
      tx,
    );
  });
}

/**
 * Push every row that is currently due out of reach.
 *
 * An untargeted claim takes the OLDEST due work in the table, whatever it is —
 * that is the dispatcher's whole job — so a case asserting WHICH row was claimed
 * has to own the entire due set, and this suite shares one database with every
 * case that ran before it. Moving `available_at` rather than deleting keeps those
 * rows, and their history, exactly as their own cases left them.
 */
async function parkPendingOutboxWork(): Promise<void> {
  await db
    .update(schema.moderationOutbox)
    .set({ availableAt: future() })
    .where(eq(schema.moderationOutbox.status, "pending"));
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

describe("the transaction guard", () => {
  it("refuses the ROOT connection, naming the call that was misrouted", async () => {
    const eventId = id("outbox");

    const error = await enqueueModerationOutboxEvent(
      { eventId, kind: "report.submit", payload: { reportId: id("report") } },
      db,
    ).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MissingTransactionError);
    // The event id rides in the message: "some enqueue was misrouted" sends
    // whoever hits it hunting through every caller.
    expect(String(error)).toContain(`enqueueModerationOutboxEvent(${eventId})`);

    // And it refused BEFORE writing. A guard that throws after the insert would
    // leave exactly the row it exists to prevent.
    const rows = await db
      .select()
      .from(schema.moderationOutbox)
      .where(eq(schema.moderationOutbox.id, eventId));
    expect(rows).toHaveLength(0);
  });

  it("refuses the root connection for the inbound event's audit write too", async () => {
    const eventId = id("evt");
    await claimModerationEvent(eventId, db);

    const error = await markModerationEventQueued(
      { eventId, type: "case.decided", caseId: id("case"), payload: { decision: {} } },
      db,
    ).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MissingTransactionError);
    expect(String(error)).toContain(`markModerationEventQueued(${eventId})`);

    // Guarding only the outbox half would leave this reachable: the audit row
    // completed outside the transaction, the work queued inside it, and a crash
    // between them losing a decision that reads as already handled.
    const [row] = await db
      .select()
      .from(schema.moderationEvents)
      .where(eq(schema.moderationEvents.id, eventId));
    expect(row.state).toBe("claimed");
  });

  it("accepts a transaction handle, and a SAVEPOINT inside one", async () => {
    // A nested transaction is a savepoint and has `rollback` for the same reason
    // the outer one does, which is what makes the discriminator safe inside a
    // caller that already opened a transaction.
    await db.transaction(async (tx) => {
      expect(requireTransaction(tx, "outer")).toBe(tx);
      await tx.transaction(async (nested) => {
        expect(requireTransaction(nested, "nested")).toBe(nested);
      });
    });
  });
});

describe("intake: the report and its delivery event commit together, or neither", () => {
  it("commits both", async () => {
    const eventIds = await db.transaction(async (tx) => {
      const report = await insertReport(
        {
          reporter: id("reporter"),
          reportedType: "user",
          reportedId: id("subject"),
          categories: ["harassment", "spam"],
          localStatus: "queued",
        },
        tx,
      );
      const eventId = await enqueueModerationOutboxEvent(
        {
          eventId: `moderation:report.submit:${report.id}`,
          kind: "report.submit",
          payload: { reportId: report.id },
        },
        tx,
      );
      return { reportId: report.id, eventId };
    });

    const stored = await findReportById(eventIds.reportId, db);
    expect(stored?.localStatus).toBe("queued");
    // The id is generated by the repository — `reports.id` has no database
    // default, so a row inserted without one would not exist at all.
    expect(stored?.id).toBe(eventIds.reportId);

    const [event] = await db
      .select()
      .from(schema.moderationOutbox)
      .where(eq(schema.moderationOutbox.id, eventIds.eventId));
    expect(event.payloadReportId).toBe(eventIds.reportId);
    expect(event.status).toBe("pending");

    // The writer owns the deadline the expiry sweep reaps against.
    const expectedExpiry = event.createdAt.getTime() + MODERATION_OUTBOX_RETENTION_SECONDS * 1_000;
    expect(Math.abs(event.expiresAt.getTime() - expectedExpiry)).toBeLessThan(60_000);
  });

  it("commits NEITHER when the transaction fails after both writes", async () => {
    const reporter = id("reporter");
    const reportedId = id("subject");
    let eventId = "";

    const error = await db
      .transaction(async (tx) => {
        const report = await insertReport(
          {
            reporter,
            reportedType: "user",
            reportedId,
            categories: ["spam"],
            localStatus: "queued",
          },
          tx,
        );
        eventId = await enqueueModerationOutboxEvent(
          {
            eventId: `moderation:report.submit:${report.id}`,
            kind: "report.submit",
            payload: { reportId: report.id },
          },
          tx,
        );
        throw new Error("deliberate rollback");
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).not.toBeNull();
    // This is the property `POST /reports`'s 201 rests on: never a report with no
    // delivery event, and never a delivery event naming a report that rolled back.
    expect(await findReportBySubject({ reporter, reportedId, reportedType: "user" }, db)).toBeUndefined();
    const events = await db
      .select()
      .from(schema.moderationOutbox)
      .where(eq(schema.moderationOutbox.id, eventId));
    expect(events).toHaveLength(0);
  });

  it("refuses a second report of the same subject by the same reporter", async () => {
    const reporter = id("reporter");
    const reportedId = id("subject");
    const insert = () =>
      db.transaction(async (tx) =>
        insertReport(
          { reporter, reportedType: "user", reportedId, categories: ["spam"], localStatus: "queued" },
          tx,
        ),
      );

    await insert();
    const error = await insert().then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).not.toBeNull();
    // Named, not matched on a message: drizzle wraps the driver error, so the
    // constraint name lives on `cause` and a regex over the text would pass for
    // the wrong index.
    expect(isUniqueViolation(error)).toBe(true);
    expect(constraintNameOf(error)).toBe("reports_reporter_reported_id_reported_type_key");
  });

  it("stores a locally-recorded report with its reason and no delivery event", async () => {
    // The common case in Allo: a reported message never leaves, because the
    // server cannot read one.
    const report = await db.transaction(async (tx) =>
      insertReport(
        {
          reporter: id("reporter"),
          reportedType: "message",
          reportedId: id("msg"),
          categories: ["explicit_content"],
          localStatus: "received",
          localStatusReason: "Allo has no moderation subject provider for 'message'.",
        },
        tx,
      ),
    );

    expect(report.localStatus).toBe("received");
    expect(report.localStatusReason).toContain("no moderation subject provider");
    expect(report.status).toBe("pending");
  });
});

describe("the enqueue is idempotent, structurally", () => {
  it("treats a repeated enqueue of the same id as a genuine no-op", async () => {
    const eventId = id("outbox");
    const payload = { reportId: id("report") };
    await db.transaction(async (tx) =>
      enqueueModerationOutboxEvent({ eventId, kind: "report.submit", payload }, tx),
    );

    const before = await outboxTuple(eventId);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await db.transaction(async (tx) =>
      enqueueModerationOutboxEvent({ eventId, kind: "report.submit", payload }, tx),
    );
    const after = await outboxTuple(eventId);

    // `xmin` is the row's transaction id: a `DO UPDATE` careful enough to write
    // identical values still moves it, so this catches what comparing columns
    // cannot. `updated_at` catches the ordinary version, where drizzle applies
    // the column's `$onUpdate` inside the conflict branch's `set`.
    expect(after.xmin).toBe(before.xmin);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("does not let a repeat rewrite the payload of the row already queued", async () => {
    const eventId = id("outbox");
    const original = id("report");
    await db.transaction(async (tx) =>
      enqueueModerationOutboxEvent(
        { eventId, kind: "report.submit", payload: { reportId: original } },
        tx,
      ),
    );
    await db.transaction(async (tx) =>
      enqueueModerationOutboxEvent(
        { eventId, kind: "report.submit", payload: { reportId: id("other") } },
        tx,
      ),
    );

    const [row] = await db
      .select()
      .from(schema.moderationOutbox)
      .where(eq(schema.moderationOutbox.id, eventId));
    expect(row.payloadReportId).toBe(original);
  });
});

describe("the claim is a lease, and leases are held under concurrency", () => {
  it("hands N concurrent dispatchers N DIFFERENT rows", async () => {
    await parkPendingOutboxWork();
    const owners = ["a", "b", "c", "d", "e", "f"].map((suffix) => id(`owner-${suffix}`));
    const eventIds: string[] = [];
    for (let index = 0; index < owners.length; index += 1) {
      const eventId = id("outbox-race");
      await insertDueOutboxEvent(eventId);
      eventIds.push(eventId);
    }

    // In flight at once, on separate pooled connections. Sequential claims pass
    // whether or not `skip locked` is there; overlapping ones do not.
    const claimed = await Promise.all(
      owners.map((leaseOwner) => claimModerationOutboxEvent({ leaseOwner }, db)),
    );

    const ids = claimed.map((event) => event?.id);
    expect(ids.filter((value) => value === undefined)).toHaveLength(0);
    expect(new Set(ids).size).toBe(owners.length);
    // Anti-vacuity: the rows claimed must be the ones this case created, not
    // leftovers from another describe block that happened to be due.
    expect(ids.every((value) => eventIds.includes(String(value)))).toBe(true);
  });

  it("SKIPS a row another transaction is holding, rather than waiting for it", async () => {
    await parkPendingOutboxWork();
    const held = id("outbox-held");
    const free = id("outbox-free");
    await insertDueOutboxEvent(held);
    await insertDueOutboxEvent(free);

    let concurrent: Awaited<ReturnType<typeof claimModerationOutboxEvent>> = null;
    await db.transaction(async (tx) => {
      // Claimed and still uncommitted, so its row lock is live for the whole body.
      const first = await claimModerationOutboxEvent({ leaseOwner: id("owner"), eventId: held }, tx);
      expect(first?.id).toBe(held);

      // Without `skip locked` this second claim blocks on that lock until the
      // outer transaction commits — which it cannot, because it is awaiting this.
      concurrent = await claimModerationOutboxEvent({ leaseOwner: id("owner") }, db);
    });

    expect(concurrent).not.toBeNull();
    expect(concurrent?.id).toBe(free);
  });

  it("counts attempts and clears the previous error on every claim", async () => {
    const eventId = id("outbox");
    await insertDueOutboxEvent(eventId);
    const owner = id("owner");

    const first = await claimModerationOutboxEvent({ leaseOwner: owner, eventId }, db);
    expect(first?.attempts).toBe(1);
    expect(first?.leaseOwner).toBe(owner);
    // Absent optionals are normalized to `undefined`, because every reader of
    // `ModerationOutboxEvent` tests `=== undefined` and a `null` passes that.
    expect(first?.payload.eventId).toBeUndefined();

    await releaseModerationOutboxEvent(
      {
        eventId,
        leaseOwner: owner,
        deadLettered: false,
        availableAt: new Date(Date.now() - 1_000),
        error: "a transient failure",
      },
      db,
    );

    const second = await claimModerationOutboxEvent({ leaseOwner: owner, eventId }, db);
    expect(second?.attempts).toBe(2);
    const [row] = await db
      .select()
      .from(schema.moderationOutbox)
      .where(eq(schema.moderationOutbox.id, eventId));
    expect(row.lastError).toBeNull();
  });

  it("reclaims an EXPIRED lease and leaves a live one alone", async () => {
    const eventId = id("outbox");
    await insertDueOutboxEvent(eventId);

    const claimed = await claimModerationOutboxEvent(
      { leaseOwner: id("owner-dead"), eventId, leaseMs: MINUTE_MS },
      db,
    );
    expect(claimed?.id).toBe(eventId);

    // Nobody else may take it while the lease is live.
    expect(await claimModerationOutboxEvent({ leaseOwner: id("owner-early"), eventId }, db)).toBeNull();

    // The clock moves rather than the lease shortening, because that is the real
    // failure: a task that died holding this row, and a survivor that has to be
    // able to pick the work back up.
    const afterLapse = new Date(Date.now() + 2 * MINUTE_MS);
    const reclaimed = await claimModerationOutboxEvent(
      { leaseOwner: id("owner-live"), eventId, now: afterLapse },
      db,
    );
    expect(reclaimed?.id).toBe(eventId);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("never claims a row that has never been leased through the reclaim branch", async () => {
    // `lease_until` is NULL for a fresh row and `NULL <= now` is NULL, so the
    // reclaim branch excludes it by the comparison itself — as `{$lte: now}` did
    // for a missing field in Mongo.
    const eventId = id("outbox");
    await insertDueOutboxEvent(eventId);
    await db
      .update(schema.moderationOutbox)
      .set({ status: "processing" })
      .where(eq(schema.moderationOutbox.id, eventId));

    expect(await claimModerationOutboxEvent({ leaseOwner: id("owner"), eventId }, db)).toBeNull();
  });

  it("does not claim work that is not due yet", async () => {
    const eventId = id("outbox");
    await insertDueOutboxEvent(eventId);
    await db
      .update(schema.moderationOutbox)
      .set({ availableAt: future() })
      .where(eq(schema.moderationOutbox.id, eventId));

    expect(await claimModerationOutboxEvent({ leaseOwner: id("owner"), eventId }, db)).toBeNull();
  });
});

describe("only the owner of a live lease may finish the work", () => {
  it("completes for the owner and refuses everyone else", async () => {
    const eventId = id("outbox");
    await insertDueOutboxEvent(eventId);
    const owner = id("owner");
    await claimModerationOutboxEvent({ leaseOwner: owner, eventId }, db);

    expect(await completeModerationOutboxEvent(eventId, id("stranger"), new Date(), db)).toBe(false);
    expect(await completeModerationOutboxEvent(eventId, owner, new Date(), db)).toBe(true);

    const [row] = await db
      .select()
      .from(schema.moderationOutbox)
      .where(eq(schema.moderationOutbox.id, eventId));
    expect(row.status).toBe("processed");
    expect(row.leaseOwner).toBeNull();
    expect(row.processedAt).not.toBeNull();

    // Completing twice is not a second completion: the lease is gone.
    expect(await completeModerationOutboxEvent(eventId, owner, new Date(), db)).toBe(false);
  });

  it("refuses to complete or renew an EXPIRED lease", async () => {
    const eventId = id("outbox");
    await insertDueOutboxEvent(eventId);
    const owner = id("owner");
    const claimed = await claimModerationOutboxEvent(
      { leaseOwner: owner, eventId, leaseMs: MINUTE_MS },
      db,
    );
    // Not decoration: without it, a claim that silently matched nothing would
    // make the two refusals below pass for the wrong reason entirely.
    expect(claimed?.id).toBe(eventId);

    // A dispatcher whose lease lapsed must not write an outcome for work another
    // task may already have reclaimed.
    const afterLapse = new Date(Date.now() + 2 * MINUTE_MS);
    expect(await renewModerationOutboxEvent(eventId, owner, MINUTE_MS, afterLapse, db)).toBe(false);
    expect(await completeModerationOutboxEvent(eventId, owner, afterLapse, db)).toBe(false);
    // And it really is the lapse that refuses them, not the owner or the status.
    expect(await completeModerationOutboxEvent(eventId, owner, new Date(), db)).toBe(true);
  });

  it("extends a live lease for its owner", async () => {
    const eventId = id("outbox");
    await insertDueOutboxEvent(eventId);
    const owner = id("owner");
    const claimed = await claimModerationOutboxEvent({ leaseOwner: owner, eventId, leaseMs: 5_000 }, db);
    expect(claimed?.id).toBe(eventId);

    expect(await renewModerationOutboxEvent(eventId, owner, 2 * MINUTE_MS, new Date(), db)).toBe(true);
    const [row] = await db
      .select()
      .from(schema.moderationOutbox)
      .where(eq(schema.moderationOutbox.id, eventId));
    expect(row.leaseUntil.getTime()).toBeGreaterThan(claimed.leaseUntil.getTime());
  });

  it("dead-letters with its error, and bounds it", async () => {
    const eventId = id("outbox");
    await insertDueOutboxEvent(eventId);
    const owner = id("owner");
    await claimModerationOutboxEvent({ leaseOwner: owner, eventId }, db);

    const released = await releaseModerationOutboxEvent(
      {
        eventId,
        leaseOwner: owner,
        deadLettered: true,
        availableAt: new Date(),
        error: "x".repeat(5_000),
      },
      db,
    );

    expect(released).toBe(true);
    const [row] = await db
      .select()
      .from(schema.moderationOutbox)
      .where(eq(schema.moderationOutbox.id, eventId));
    expect(row.status).toBe("dead_letter");
    // The Mongoose schema bounded nothing and the service sliced at 2 000 before
    // every write; the bound lives at the repository now so it holds for callers
    // that do not.
    expect(row.lastError).toHaveLength(2_000);
    expect(row.leaseOwner).toBeNull();
  });
});

describe("the inbound webhook dedupe claim", () => {
  it("answers 'already seen' as a VALUE, not as a thrown duplicate key", async () => {
    const eventId = id("evt");
    expect(await claimModerationEvent(eventId, db)).toBe(true);
    // A second delivery, on another ECS task, gets `false` — not an exception a
    // `catch` has to classify apart from a lost connection.
    expect(await claimModerationEvent(eventId, db)).toBe(false);

    const [row] = await db
      .select()
      .from(schema.moderationEvents)
      .where(eq(schema.moderationEvents.id, eventId));
    expect(row.state).toBe("claimed");
  });

  it("releases a claim by deleting it, so a redelivery can be processed", async () => {
    const eventId = id("evt");
    await claimModerationEvent(eventId, db);
    await releaseModerationEvent(eventId, db);

    const rows = await db
      .select()
      .from(schema.moderationEvents)
      .where(eq(schema.moderationEvents.id, eventId));
    expect(rows).toHaveLength(0);
    expect(await claimModerationEvent(eventId, db)).toBe(true);
  });

  it("records a decision event and queues its work in ONE transaction", async () => {
    const eventId = id("evt");
    const caseId = id("case");
    await claimModerationEvent(eventId, db);

    await db.transaction(async (tx) => {
      await markModerationEventQueued(
        { eventId, type: "case.decided", caseId, payload: { caseId, decision: { revision: 1 } } },
        tx,
      );
      await enqueueModerationOutboxEvent(
        {
          eventId: `moderation:decision.apply:${eventId}`,
          kind: "decision.apply",
          payload: { eventId, caseId, decision: { revision: 1 } },
        },
        tx,
      );
    });

    const [event] = await db
      .select()
      .from(schema.moderationEvents)
      .where(eq(schema.moderationEvents.id, eventId));
    expect(event.state).toBe("queued");
    expect(event.caseId).toBe(caseId);
    expect(event.queuedAt).not.toBeNull();

    const [work] = await db
      .select()
      .from(schema.moderationOutbox)
      .where(eq(schema.moderationOutbox.id, `moderation:decision.apply:${eventId}`));
    expect(work.kind).toBe("decision.apply");
    expect(work.payloadCaseId).toBe(caseId);
    // The decision rides whole in `jsonb`: §10.11 makes it loose, and projecting
    // it into columns would drop whatever a newer CrowdSource added.
    expect(work.payloadDecision).toEqual({ revision: 1 });
  });

  it("leaves the claim held and nothing queued when that transaction fails", async () => {
    const eventId = id("evt");
    const caseId = id("case");
    await claimModerationEvent(eventId, db);

    const error = await db
      .transaction(async (tx) => {
        await markModerationEventQueued(
          { eventId, type: "case.decided", caseId, payload: { caseId } },
          tx,
        );
        await enqueueModerationOutboxEvent(
          { eventId: `moderation:decision.apply:${eventId}`, kind: "decision.apply", payload: { eventId, caseId } },
          tx,
        );
        throw new Error("deliberate rollback");
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).not.toBeNull();
    const [event] = await db
      .select()
      .from(schema.moderationEvents)
      .where(eq(schema.moderationEvents.id, eventId));
    // Still `claimed`: the only two outcomes are "recorded and queued" or
    // "neither", and "neither" is what the middleware releases and CrowdSource
    // redelivers.
    expect(event.state).toBe("claimed");
    const work = await db
      .select()
      .from(schema.moderationOutbox)
      .where(eq(schema.moderationOutbox.id, `moderation:decision.apply:${eventId}`));
    expect(work).toHaveLength(0);
  });

  it("never manufactures an audit row for an event nothing claimed", async () => {
    const eventId = id("evt-unclaimed");
    const queued = await db.transaction(async (tx) =>
      markModerationEventQueued({ eventId, type: "case.decided", caseId: id("case"), payload: {} }, tx),
    );

    expect(queued).toBe(false);
    const rows = await db
      .select()
      .from(schema.moderationEvents)
      .where(eq(schema.moderationEvents.id, eventId));
    expect(rows).toHaveLength(0);
  });

  it("records an ignored event without erasing a case id it already had", async () => {
    const eventId = id("evt");
    const caseId = id("case");
    await claimModerationEvent(eventId, db);
    await markModerationEventIgnored({ eventId, type: "case.created", caseId }, db);
    await markModerationEventIgnored({ eventId, type: "case.escalated" }, db);

    const [row] = await db
      .select()
      .from(schema.moderationEvents)
      .where(eq(schema.moderationEvents.id, eventId));
    expect(row.state).toBe("ignored");
    expect(row.type).toBe("case.escalated");
    expect(row.caseId).toBe(caseId);
  });
});

describe("recording a decision on the report it belongs to", () => {
  async function queuedReport(): Promise<string> {
    const report = await db.transaction(async (tx) =>
      insertReport(
        {
          reporter: id("reporter"),
          reportedType: "user",
          reportedId: id("subject"),
          categories: ["hate_speech"],
          localStatus: "queued",
        },
        tx,
      ),
    );
    return report.id;
  }

  it("applies the FIRST decision, whose expected revision is NULL", async () => {
    const reportId = await queuedReport();

    const applied = await applyReportDecision(
      {
        reportId,
        expectedRevision: null,
        status: "resolved",
        localStatus: "submitted",
        decisionId: id("decision"),
        decisionRevision: 1,
        decisionOutcome: "violation",
        decisionStatus: "final",
        decidedAt: new Date(),
        enforcedAction: "restrict",
      },
      db,
    );

    // `decision_revision = NULL` is NULL, so an `eq` here would match no row and
    // the first decision about EVERY report would be dropped in silence. This is
    // the case that tells `is not distinct from` from `=`.
    expect(applied).toBe(true);
    const stored = await findReportById(reportId, db);
    expect(stored?.decisionRevision).toBe(1);
    expect(stored?.enforcedAction).toBe("restrict");
    // Nothing acted, so nothing claims it did.
    expect(stored?.enforcedAt).toBeNull();
  });

  it("refuses a write whose expected revision is stale", async () => {
    const reportId = await queuedReport();
    const decision = (revision: number, expectedRevision: number | null) =>
      applyReportDecision(
        {
          reportId,
          expectedRevision,
          status: "resolved",
          localStatus: "submitted",
          decisionId: id("decision"),
          decisionRevision: revision,
          decisionOutcome: "no_violation",
          decisionStatus: "final",
          decidedAt: new Date(),
          enforcedAction: "restore",
        },
        db,
      );

    expect(await decision(2, null)).toBe(true);
    // A concurrent worker that read revision 2 before this one wrote it loses.
    expect(await decision(3, null)).toBe(false);
    expect(await decision(3, 2)).toBe(true);
    expect((await findReportById(reportId, db))?.decisionRevision).toBe(3);
  });

  it("finds the report a decision names by its case id", async () => {
    const reportId = await queuedReport();
    const caseId = id("case");
    await markReportSubmitted(
      {
        reportId,
        crowdSourceReportId: id("cs-report"),
        crowdSourceCaseId: caseId,
        crowdSourceMerged: false,
        contentSnapshotHash: "sha256:deadbeef",
      },
      db,
    );

    const found = await findReportByCaseId(caseId, db);
    expect(found?.id).toBe(reportId);
    expect(found?.localStatus).toBe("submitted");
    expect(found?.submittedAt).not.toBeNull();
  });
});

describe("what delivery writes back onto the report", () => {
  async function deliverableReport(): Promise<string> {
    const report = await db.transaction(async (tx) =>
      insertReport(
        {
          reporter: id("reporter"),
          reportedType: "user",
          reportedId: id("subject"),
          categories: ["misinformation"],
          localStatus: "queued",
          localStatusReason: "a reason from an earlier attempt",
        },
        tx,
      ),
    );
    return report.id;
  }

  it("clears the previous failure and reason when the report is submitted", async () => {
    const reportId = await deliverableReport();
    await markReportDeliveryFailed(reportId, "the gateway timed out", db);
    expect((await findReportById(reportId, db))?.localStatus).toBe("delivery_failed");

    await markReportSubmitted(
      {
        reportId,
        crowdSourceReportId: id("cs-report"),
        crowdSourceCaseId: id("case"),
        crowdSourceMerged: true,
        contentSnapshotHash: "sha256:cafe",
      },
      db,
    );

    const stored = await findReportById(reportId, db);
    expect(stored?.localStatus).toBe("submitted");
    // A stale reason is worse than none: both describe a state the row has left.
    expect(stored?.lastDeliveryError).toBeNull();
    expect(stored?.localStatusReason).toBeNull();
    expect(stored?.crowdSourceMerged).toBe(true);
  });

  it("bounds a delivery error at the length the Mongoose schema declared", async () => {
    const reportId = await deliverableReport();
    await markReportDeliveryFailed(reportId, "y".repeat(9_000), db);
    expect((await findReportById(reportId, db))?.lastDeliveryError).toHaveLength(2_000);
  });

  it("closes a report whose subject no longer exists, with the reason stored", async () => {
    const reportId = await deliverableReport();
    await closeUndeliverableReport(
      reportId,
      "The reported account no longer exists, so there is nothing to review.",
      db,
    );

    const stored = await findReportById(reportId, db);
    expect(stored?.localStatus).toBe("closed");
    expect(stored?.localStatusReason).toContain("no longer exists");
  });

  it("reports `false` rather than throwing when the report is already gone", async () => {
    // The delivery event can outlive its report; a worker looking for one that
    // was deleted has nothing to do and nothing to retry.
    expect(await markReportDeliveryFailed(id("missing"), "anything", db)).toBe(false);
    expect(await closeUndeliverableReport(id("missing"), "anything", db)).toBe(false);
  });
});

describe("the reporter's own list", () => {
  it("returns only this reporter's reports, newest first, and no operational state", async () => {
    const reporter = id("reporter");
    for (let index = 0; index < 3; index += 1) {
      await db.transaction(async (tx) =>
        insertReport(
          {
            reporter,
            reportedType: "user",
            reportedId: id("subject"),
            categories: ["spam"],
            localStatus: "queued",
            localStatusReason: "operational state that must not be returned",
          },
          tx,
        ),
      );
    }
    await db.transaction(async (tx) =>
      insertReport(
        {
          reporter: id("someone-else"),
          reportedType: "user",
          reportedId: id("subject"),
          categories: ["spam"],
          localStatus: "queued",
        },
        tx,
      ),
    );

    const rows = await listReportsByReporter(reporter, db);
    expect(rows).toHaveLength(3);
    // The projection is the security boundary: a reporter learning which of their
    // reports left the deployment learns which can be made to disappear.
    expect(Object.keys(rows[0]).sort()).toEqual([
      "categories",
      "createdAt",
      "details",
      "id",
      "reportedId",
      "reportedType",
      "status",
    ]);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index - 1].createdAt.getTime()).toBeGreaterThanOrEqual(
        rows[index].createdAt.getTime(),
      );
    }
  });

  it("truncates a reporter's details at the length the Mongoose schema declared", async () => {
    const report = await db.transaction(async (tx) =>
      insertReport(
        {
          reporter: id("reporter"),
          reportedType: "user",
          reportedId: id("subject"),
          categories: ["other"],
          details: "z".repeat(900),
          localStatus: "queued",
        },
        tx,
      ),
    );
    expect(report.details).toHaveLength(500);
  });
});

describe("sanity", () => {
  it("wrote through the schema helpers, so the casing matches the migration", async () => {
    const [row] = await client<{ total: number }[]>`
      select count(*)::int as total from moderation_outbox
    `;
    // Anti-vacuity: every case above would also pass against a database where
    // nothing was ever written, if the reads were as broken as the writes.
    expect(row.total).toBeGreaterThan(0);
    const rows = await db.select({ total: sql<number>`count(*)::int` }).from(schema.reports);
    expect(rows[0].total).toBeGreaterThan(0);
  });
});
