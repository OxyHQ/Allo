import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readJournal } from "@oxy.so/db/migrate";

import { closePostgres, connectPostgres, getPostgresClient } from "../../db";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import {
  PreMigrationsPendingError,
  assertPreMigrationsCurrent,
  classifyPendingMigrations,
} from "../../runtime/migrationGate";

/**
 * The boot gate against the two-phase deploy contract: a pending `post`
 * migration is the expected state between the rollout and the post one-shot,
 * a pending `pre` migration is the failure the gate exists to catch.
 *
 * The first platform release measured the other behaviour: every task refused
 * to boot on the pending post migration, ECS rolled back, and the post
 * one-shot that would have cleared it never ran.
 */

const MIGRATIONS = join(__dirname, "..", "..", "..", "drizzle");
/** Throwaway migration folders for the synthetic pending cases below. */
const SYNTHETIC_ROOT = join(tmpdir(), `allo-migration-gate-${process.pid}`);

describe("classifyPendingMigrations", () => {
  const phases = new Map([
    ["0004_platform_tables", "pre" as const],
    ["0005_retire_legacy_messaging", "post" as const],
  ]);

  it("tolerates pending post migrations and refuses pending pre ones", () => {
    expect(classifyPendingMigrations([{ tag: "0005_retire_legacy_messaging", when: 2 }], phases)).toEqual({
      tolerated: ["0005_retire_legacy_messaging"],
      refused: [],
    });
    const both = classifyPendingMigrations(
      [
        { tag: "0004_platform_tables", when: 1 },
        { tag: "0005_retire_legacy_messaging", when: 2 },
      ],
      phases,
    );
    expect(both.tolerated).toEqual(["0005_retire_legacy_messaging"]);
    expect(both.refused.map((r) => r.tag)).toEqual(["0004_platform_tables"]);
  });

  it("refuses a pending migration whose phase could not be read", () => {
    const verdict = classifyPendingMigrations([{ tag: "0009_missing", when: 9 }], phases, [
      "0009_missing: no such file",
    ]);
    expect(verdict.tolerated).toEqual([]);
    expect(verdict.refused).toEqual([{ tag: "0009_missing", reason: "0009_missing: no such file" }]);
  });
});

describe("assertPreMigrationsCurrent against a real ledger", () => {
  let handle: TestDatabaseHandle;
  const warnings: string[] = [];
  const log = { warn: (message: string) => void warnings.push(message) };

  beforeAll(async () => {
    handle = await setUpTestDatabase();
    connectPostgres(handle.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await closePostgres();
    await handle?.drop();
    rmSync(SYNTHETIC_ROOT, { recursive: true, force: true });
  });

  /**
   * The ledger is a HIGH-WATER MARK: `pendingEntries` is every journal entry
   * newer than the newest `created_at` recorded, mirroring the apply rule.
   * Deleting a mid-chain ledger row therefore makes nothing pending — the
   * first version of this test forgot `0005` and worked only while `0005`
   * was the last migration; `0006` landing turned both cases green for the
   * wrong reason. So the pending state is produced the way it arises in a
   * deploy instead: migrations NEWER than everything applied. A throwaway
   * folder carries the real journal plus synthetic tail entries, each with the
   * `.sql` the phase is read from; the real ledger is left alone.
   */
  function folderWith(tail: { tag: string; phase: "pre" | "post" }[]): string {
    const journal = readJournal(MIGRATIONS);
    const last = journal[journal.length - 1];
    const folder = join(SYNTHETIC_ROOT, tail.map((t) => t.tag).join("+"));
    mkdirSync(join(folder, "meta"), { recursive: true });
    const entries = [
      ...journal.map((entry, idx) => ({ idx, version: "7", when: entry.when, tag: entry.tag, breakpoints: true })),
      ...tail.map((t, i) => ({ idx: journal.length + i, version: "7", when: last.when + 1_000 * (i + 1), tag: t.tag, breakpoints: true })),
    ];
    writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2));
    for (const t of tail) writeFileSync(join(folder, `${t.tag}.sql`), `-- oxy:deploy-phase=${t.phase}\nselect 1;\n`);
    return folder;
  }

  it("passes on a fully migrated database without warning", async () => {
    await assertPreMigrationsCurrent(getPostgresClient(), MIGRATIONS, log);
    expect(warnings).toEqual([]);
  });

  it("lets the boot through with a warning while only a post migration is pending", async () => {
    const folder = folderWith([{ tag: "0900_synthetic_post", phase: "post" }]);
    await assertPreMigrationsCurrent(getPostgresClient(), folder, log);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("post-phase migrations pending");
  });

  it("refuses the boot while a pre migration is pending, naming it and only it", async () => {
    const folder = folderWith([
      { tag: "0900_synthetic_post", phase: "post" },
      { tag: "0901_synthetic_pre", phase: "pre" },
    ]);
    const attempt = assertPreMigrationsCurrent(getPostgresClient(), folder, log);
    await expect(attempt).rejects.toBeInstanceOf(PreMigrationsPendingError);
    await expect(attempt).rejects.toThrow(/0901_synthetic_pre/);
    await attempt.catch((error: PreMigrationsPendingError) => {
      // The pending post one is tolerated even while the pre one refuses the boot.
      expect(error.refused.map((r) => r.tag)).toEqual(["0901_synthetic_pre"]);
    });
  });
});
