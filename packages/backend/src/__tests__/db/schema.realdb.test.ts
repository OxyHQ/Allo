/**
 * The schema, against a REAL Postgres server.
 *
 * Everything asserted here is a property only a server has. A mocked `insert`
 * accepts any statement — including one the server rejects outright — which is
 * exactly the class of defect a schema change introduces, and a constraint is
 * only worth the claim if something proves the server enforces it.
 *
 * Only the tables the schema barrel declares are asserted on. The migrated
 * database may hold more (a `post`-phase migration drops what a schema change
 * retired only after the rollout), and a table that exists in the database but
 * not in `db/schema/` is not this suite's business.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { createDatabase, constraintNameOf } from "@oxy.so/db";
import { findUnsupportedExpiryColumns } from "@oxy.so/db/assert";
import type postgres from "postgres";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import {
  EXPIRY_SWEEP_TARGETS,
  runExpirySweep,
  startExpirySweep,
  stopExpirySweep,
} from "../../db/expiry";
import {
  MAX_REPORT_DELIVERY_ERROR_LENGTH,
  MAX_REPORT_DETAILS_LENGTH,
  MAX_REPORT_LOCAL_STATUS_REASON_LENGTH,
} from "../../db/schema/moderation";
import * as schema from "../../db/schema";

let handle: TestDatabaseHandle;
let db: ReturnType<typeof createDatabase<typeof schema>>["db"];
let client: postgres.Sql;

const silentLog = { info: () => undefined, debug: () => undefined };

/** Unique per call so cases cannot collide inside the one shared database. */
let counter = 0;
function id(prefix: string): string {
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

describe("the migrations", () => {
  it("create every table the schema declares", async () => {
    const rows = await client<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;
    const names = rows.map((row) => row.table_name);

    /**
     * Derived from the barrel rather than listed, so a domain file added to
     * `schema/index.ts` is asserted on the day it is added. Anti-vacuity: the
     * barrel must declare something, and the moderation and social tables must
     * be among them.
     */
    const declared = (Object.values(schema) as unknown[])
      .filter((value): value is PgTable => is(value, PgTable))
      .map((table) => getTableName(table))
      .sort();
    expect(declared.length).toBeGreaterThanOrEqual(7);
    expect(declared).toContain("reports");
    expect(declared).toContain("moderation_outbox");
    expect(declared).toContain("user_settings");
    expect(declared).toContain("blocks");

    for (const table of declared) {
      expect(names, `${table} is declared but was not created`).toContain(table);
    }
  });
});

describe("the expiry sweep", () => {
  it("registers exactly the tables whose rows carry a deadline", () => {
    // Named, not counted: a count alone passes if someone registers the same
    // table twice, and the whole point is that no deadline table is missing.
    const tables = EXPIRY_SWEEP_TARGETS.map((target) => getTableName(target.table)).sort();
    expect(tables).toEqual(["blobs", "instance_deliveries", "moderation_events", "moderation_outbox"]);
  });

  it("every registered column has a supporting index", async () => {
    // Without a leading btree the sweep is a full table scan on every run.
    const violations = await findUnsupportedExpiryColumns(db, EXPIRY_SWEEP_TARGETS);
    expect(violations).toEqual([]);
  });

  it("deletes expired rows and leaves live ones", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);
    const expiredId = id("evt-expired");
    const liveId = id("evt-live");

    await db.insert(schema.moderationEvents).values([
      { id: expiredId, expiresAt: past },
      { id: liveId, expiresAt: future },
    ]);

    const results = await runExpirySweep(db, silentLog);
    const events = results.find((result) => result.table.includes("moderation_events"));
    expect(events?.deleted).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .select()
      .from(schema.moderationEvents)
      .where(eq(schema.moderationEvents.id, liveId));
    expect(remaining).toHaveLength(1);

    const gone = await db
      .select()
      .from(schema.moderationEvents)
      .where(eq(schema.moderationEvents.id, expiredId));
    expect(gone).toHaveLength(0);
  });

  /**
   * The registry and the schedule are two halves of one fact, and only one of
   * them is visible in a diff.
   *
   * A registry nothing calls reaps exactly as much as no registry at all, and it
   * fails silently: no error, no failing test, no symptom until a table has grown
   * for months. So the wiring is asserted from `server.ts`'s own source — there is
   * nothing in the module graph to observe, because the thing being checked is
   * that a call EXISTS.
   *
   * Reading the file rather than importing it because importing `server.ts`
   * boots an HTTP listener and opens a database connection.
   */
  it("is actually started by server.ts", () => {
    const source = readFileSync(join(__dirname, "..", "..", "..", "server.ts"), "utf8");

    // Vacuity floor: if the path were wrong or the file empty, every `toContain`
    // below would fail rather than pass, but this says so directly.
    expect(source.length).toBeGreaterThan(3_000);
    expect(source).toContain("bootServer");

    expect(source).toContain('from "./src/db/expiry"');
    expect(source).toContain("startExpirySweep(");
  });

  it("sweeps once immediately on start, and says so even when it reaped nothing", async () => {
    const lines: { level: string; message: string }[] = [];
    const log = {
      info: (message: string) => lines.push({ level: "info", message }),
      debug: (message: string) => lines.push({ level: "debug", message }),
      error: (message: string) => lines.push({ level: "error", message }),
    };

    const expiredId = id("evt-start-expired");
    await db
      .insert(schema.moderationEvents)
      .values({ id: expiredId, expiresAt: new Date(Date.now() - 60_000) });

    try {
      startExpirySweep(db, log);
      // The immediate pass is fire-and-forget by design, so wait for the row to
      // go rather than for a promise this function deliberately does not return.
      await expect
        .poll(async () => {
          const rows = await db
            .select()
            .from(schema.moderationEvents)
            .where(eq(schema.moderationEvents.id, expiredId));
          return rows.length;
        })
        .toBe(0);
    } finally {
      stopExpirySweep();
    }

    // "Reaped nothing" and "never ran" must be distinguishable in the log, which
    // is the whole reason the summary is emitted unconditionally.
    const swept = lines.find((line) => line.message.includes("expiry sweep:"));
    expect(swept?.level).toBe("info");
    expect(swept?.message).toContain(`tablesSwept=${EXPIRY_SWEEP_TARGETS.length}`);

    lines.length = 0;
    await runExpirySweep(db, log);
    expect(lines).toEqual([
      {
        level: "debug",
        message: `expiry sweep: tablesSwept=${EXPIRY_SWEEP_TARGETS.length} deleted=0`,
      },
    ]);
  });
});

describe("the outbox claim, which must stay idempotent", () => {
  it("treats a repeated enqueue of the same id as a no-op", async () => {
    const outboxId = id("outbox");
    const expiresAt = new Date(Date.now() + 3_600_000);
    await db
      .insert(schema.moderationOutbox)
      .values({ id: outboxId, kind: "report.submit", expiresAt });

    // Both rendered as text by Postgres, so the comparison cannot depend on how
    // the driver happens to decode a timestamptz.
    const probe = async () =>
      client<{ xmin: string; updated_at: string }[]>`
        select xmin::text, updated_at::text from moderation_outbox where id = ${outboxId}
      `;

    const before = await probe();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db
      .insert(schema.moderationOutbox)
      .values({ id: outboxId, kind: "report.submit", expiresAt })
      .onConflictDoNothing();
    const after = await probe();

    // `xmin` is the row's transaction id: a `DO UPDATE` careful enough to write
    // identical values still moves it, so this catches what comparing columns
    // cannot.
    expect(after[0].xmin).toBe(before[0].xmin);
    expect(after[0].updated_at).toBe(before[0].updated_at);
  });
});

describe("closed value sets are enforced by the database, not just by TypeScript", () => {
  it("refuses a report with an empty category array", async () => {
    const error = await db
      .insert(schema.reports)
      .values({
        id: id("report"),
        reportedType: "user",
        reportedId: "oxy-user-9",
        reporter: "oxy-user-8",
        categories: [],
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).not.toBeNull();
    // Containment alone is satisfied by an empty array; this is a separate
    // constraint.
    expect(constraintNameOf(error)).toBe("reports_categories_non_empty_check");
  });

  /**
   * Through RAW SQL, and that is the honest way to test this one.
   *
   * `categories` is declared `text({ enum: REPORT_CATEGORIES }).array()`, so
   * drizzle refuses an unknown member at COMPILE time — which is the first line
   * of defence and is why this insert can no longer be written through the query
   * builder without a cast. The CHECK exists for everything that is not this
   * application: a migration, a repair script, `psql`. Reaching the server the
   * way those do is the only way to find out whether it is really enforced.
   */
  it("refuses a report category outside the tuple", async () => {
    const error = await client`
      insert into reports (id, reported_type, reported_id, reporter, categories)
      values (${id("report")}, 'user', 'oxy-user-9', 'oxy-user-7', array['spam', 'not_a_category'])
    `.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("reports_categories_within_check");
  });

  it("refuses a reported type outside the tuple", async () => {
    // `text({ enum })` emits no DDL, so this passes tsc-shaped code and must be
    // stopped by the CHECK rendered from the same tuple.
    const error = await client`
      insert into reports (id, reported_type, reported_id, reporter, categories)
      values (${id("report")}, 'starship', 'oxy-user-9', 'oxy-user-7', array['spam'])
    `.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(String(error)).toContain("reports_reported_type_check");
  });

  /**
   * The three length bounds, as CHECKs.
   *
   * `reportRepository` truncates to the same three lengths at every write, so
   * these constraints are unreachable through it by construction — which is the
   * point of having both. The repository decides what a REPORTER experiences (a
   * 201 with the tail trimmed); the CHECK decides what is STORABLE, for the
   * writer that does not exist yet.
   */
  it.each([
    ["details", "reports_details_length_check", MAX_REPORT_DETAILS_LENGTH],
    [
      "local_status_reason",
      "reports_local_status_reason_length_check",
      MAX_REPORT_LOCAL_STATUS_REASON_LENGTH,
    ],
    [
      "last_delivery_error",
      "reports_last_delivery_error_length_check",
      MAX_REPORT_DELIVERY_ERROR_LENGTH,
    ],
  ])("bounds %s at its declared length", async (column, constraint, limit) => {
    // A distinct (reporter, subject) per insert: every row here is a REPORT, and
    // `reports_reporter_reported_id_reported_type_key` would otherwise reject the
    // second one for a reason that has nothing to do with the bound under test.
    const insert = (length: number) =>
      client`
        insert into reports (id, reported_type, reported_id, reporter, categories, ${client(column)})
        values (
          ${id("report")}, 'user', ${id("subject")}, ${id("reporter")},
          array['spam'], ${"x".repeat(length)}
        )
      `.then(
        () => null,
        (caught: unknown) => caught,
      );

    // Exactly at the bound is allowed — an off-by-one CHECK would refuse the
    // value the repository's own truncation produces, which is the failure that
    // would only appear on a report whose details ran long.
    expect(await insert(limit)).toBeNull();
    expect(constraintNameOf(await insert(limit + 1))).toBe(constraint);
  });
});

describe("the transaction guard the moderation services depend on", () => {
  it("commits a report and its outbox row together, or neither", async () => {
    const reportId = id("report");
    const outboxId = id("outbox");
    const expiresAt = new Date(Date.now() + 3_600_000);

    const error = await db
      .transaction(async (tx) => {
        await tx.insert(schema.reports).values({
          id: reportId,
          reportedType: "user",
          reportedId: "oxy-user-9",
          reporter: "oxy-user-6",
          categories: ["spam"],
        });
        await tx
          .insert(schema.moderationOutbox)
          .values({ id: outboxId, kind: "report.submit", expiresAt });
        throw new Error("deliberate rollback");
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).not.toBeNull();
    const reports = await db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.id, reportId));
    const outbox = await db
      .select()
      .from(schema.moderationOutbox)
      .where(eq(schema.moderationOutbox.id, outboxId));
    // Neither survives: this is the property `POST /reports`'s 201 rests on.
    expect(reports).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });
});

describe("timestamps", () => {
  it("stores every timestamp as timestamptz", async () => {
    const rows = await client<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and data_type = 'timestamp without time zone'
    `;
    // `timestamp` without a zone reinterprets the value in the session's
    // TimeZone on every read, silently changing what it means.
    expect(rows).toEqual([]);
  });
});

describe("sanity", () => {
  it("uses the schema helpers rather than raw SQL for ordinary reads", async () => {
    const count = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.reports)
      .where(eq(schema.reports.reportedType, "user"));
    expect(count[0].total).toBeGreaterThanOrEqual(0);
  });
});
