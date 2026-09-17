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
  });

  function entry(tag: string) {
    const found = readJournal(MIGRATIONS).find((e) => e.tag === tag);
    if (!found) throw new Error(`journal has no ${tag}`);
    return found;
  }

  async function forget(tag: string): Promise<void> {
    const { when } = entry(tag);
    const rows = await getPostgresClient()`
      delete from drizzle.__drizzle_migrations where created_at = ${when} returning id`;
    expect(rows.length, `the ledger row for ${tag} exists before it is removed`).toBe(1);
  }

  it("passes on a fully migrated database without warning", async () => {
    await assertPreMigrationsCurrent(getPostgresClient(), MIGRATIONS, log);
    expect(warnings).toEqual([]);
  });

  it("lets the boot through with a warning while only a post migration is pending", async () => {
    await forget("0005_retire_legacy_messaging");
    await assertPreMigrationsCurrent(getPostgresClient(), MIGRATIONS, log);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("post-phase migrations pending");
  });

  it("refuses the boot while a pre migration is pending, naming it", async () => {
    await forget("0004_platform_tables");
    await expect(assertPreMigrationsCurrent(getPostgresClient(), MIGRATIONS, log)).rejects.toBeInstanceOf(
      PreMigrationsPendingError,
    );
    await expect(assertPreMigrationsCurrent(getPostgresClient(), MIGRATIONS, log)).rejects.toThrow(
      /0004_platform_tables/,
    );
  });
});
