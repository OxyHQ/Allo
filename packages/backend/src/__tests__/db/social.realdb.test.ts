/**
 * The social repositories — blocks, restricts, settings and behaviour — against
 * a REAL Postgres server.
 *
 * Every property worth asserting in this domain is one only a server has: a
 * unique index deciding a race, a column DEFAULT supplying a value the
 * application deliberately does not, a CHECK refusing a value that type-checks.
 * A mocked `insert` accepts all three, which is exactly why the foundation PR
 * booted this harness rather than mocking drizzle.
 *
 * Nothing here imports a route or a Mongoose model. The repositories land
 * unused; this file is the only thing that calls them.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, getTableColumns } from "drizzle-orm";
import { createDatabase, constraintNameOf, isCheckViolation, isUniqueViolation } from "@oxyhq/db";
import type postgres from "postgres";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import * as schema from "../../db/schema";
import { blockUser, listBlockedUserIds, unblockUser } from "../../db/social/blockRepository";
import {
  listRestrictedUserIds,
  restrictUser,
  unrestrictUser,
} from "../../db/social/restrictRepository";
import { deleteUserBehavior } from "../../db/social/userBehaviorRepository";
import {
  ensureUserSettings,
  updateUserSettings,
  UPDATABLE_USER_SETTINGS_COLUMNS,
  type UserSettingsPatch,
} from "../../db/social/userSettingsRepository";

let handle: TestDatabaseHandle;
let db: ReturnType<typeof createDatabase<typeof schema>>["db"];
let client: postgres.Sql;

/** Unique per call so cases cannot collide inside the one shared database. */
let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

/**
 * Open eight pool connections before a case races on them.
 *
 * Not ceremony — measured. postgres.js opens connections on demand, so the FIRST
 * concurrent burst after a run of sequential queries queues onto the single
 * connection that happens to be open and executes strictly in order. A racing
 * case in that position silently tests nothing: mutating `blockUser` to the
 * read-then-write it replaced left every racing case here GREEN, while the same
 * bursts preceded by this warm-up caught it 20 times out of 20.
 */
async function warmPool(userId: string): Promise<void> {
  await Promise.all(Array.from({ length: 8 }, () => listBlockedUserIds(db, userId)));
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

describe("blocks converge on the unique index instead of reading first", () => {
  it("reports whether the call is what created the block", async () => {
    const pair = { userId: id("blocker"), blockedId: id("blocked") };

    expect(await blockUser(db, pair)).toBe(true);
    expect(await blockUser(db, pair)).toBe(false);

    const rows = await db.select().from(schema.blocks).where(eq(schema.blocks.userId, pair.userId));
    // The second call is what `POST /blocks` answers 200 to rather than 201, and
    // it must not have written a second row to do it.
    expect(rows).toHaveLength(1);
  });

  it("blocks in ONE statement, so there is no window between a read and a write", async () => {
    const statements: string[] = [];
    const observed = createDatabase({
      databaseUrl: handle.databaseUrl,
      schema,
      client: {
        debug: (_connection: number, query: string) => {
          statements.push(query.toLowerCase());
        },
      },
    });

    try {
      const pair = { userId: id("blocker"), blockedId: id("blocked") };
      // Open the socket first: postgres.js emits its own setup chatter on a new
      // connection and none of it belongs to the measurement.
      await listBlockedUserIds(observed.db, pair.userId);

      statements.length = 0;
      expect(await blockUser(observed.db, pair)).toBe(true);
      const firstCall = [...statements];

      statements.length = 0;
      expect(await blockUser(observed.db, pair)).toBe(false);
      const secondCall = [...statements];

      // THE property, and the only deterministic way to observe it. Both a
      // correct repository and a read-then-write one answer `false` for a block
      // that already exists, so no assertion about the RESULT can tell them
      // apart; what differs is that the second issues two statements with a gap
      // between them, and the gap is the race. Measured: the mutation makes this
      // read 2.
      expect(firstCall).toHaveLength(1);
      expect(secondCall).toHaveLength(1);
      expect(firstCall[0]).toContain('insert into "blocks"');
      expect(firstCall[0]).toContain("on conflict");
      expect(firstCall[0]).not.toContain("select");

      // Anti-vacuity: the hook really does count each statement, so `1` above is
      // a measurement rather than a callback that never fired.
      statements.length = 0;
      await listBlockedUserIds(observed.db, pair.userId);
      await listBlockedUserIds(observed.db, pair.userId);
      expect(statements).toHaveLength(2);
    } finally {
      await observed.client.end();
    }
  });

  it("survives eight concurrent blocks of the same person", async () => {
    const pair = { userId: id("blocker"), blockedId: id("blocked") };
    await warmPool(pair.userId);

    // The race the Mongoose version lost: `findOne` then `create` let every one
    // of these see nothing and insert, and seven of the eight then failed on the
    // index. See `warmPool` — without it these serialise and prove nothing.
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => blockUser(db, pair)),
    );

    // Not "at least one": exactly one, and none of the eight rejected. A
    // repository that let the duplicate-key error escape fails here, not only
    // one that wrote two rows.
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const rows = await db.select().from(schema.blocks).where(eq(schema.blocks.userId, pair.userId));
    expect(rows).toHaveLength(1);
  });

  it("scopes the unique index to the PAIR, so two people may block one person", async () => {
    const target = id("blocked");
    const first = id("blocker");
    const second = id("blocker");

    expect(await blockUser(db, { userId: first, blockedId: target })).toBe(true);
    // A conflict target of `blockedId` alone would swallow this and report false.
    expect(await blockUser(db, { userId: second, blockedId: target })).toBe(true);

    const rows = await db
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.blockedId, target));
    expect(rows).toHaveLength(2);
  });

  it("names the index the repository's conflict target relies on", async () => {
    const pair = { userId: id("blocker"), blockedId: id("blocked") };
    await blockUser(db, pair);

    // Written raw, bypassing `ON CONFLICT`, so the constraint itself answers —
    // this is what proves the index the repository infers actually exists under
    // the name the schema declares.
    const error = await db
      .insert(schema.blocks)
      .values({ id: id("blk"), userId: pair.userId, blockedId: pair.blockedId })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).not.toBeNull();
    expect(isUniqueViolation(error)).toBe(true);
    // Named, not matched on a message: drizzle wraps the driver error, so the
    // constraint name lives on `cause` and a regex over the text would pass for
    // the wrong index.
    expect(constraintNameOf(error)).toBe("blocks_user_id_blocked_id_key");
  });

  it("lists only the owner's blocks, newest first", async () => {
    const owner = id("blocker");
    const other = id("blocker");
    const first = id("blocked");
    const second = id("blocked");
    const third = id("blocked");

    await blockUser(db, { userId: owner, blockedId: first });
    await blockUser(db, { userId: owner, blockedId: second });
    await blockUser(db, { userId: owner, blockedId: third });
    // Anti-vacuity for the scoping half: a query missing its `where` would
    // return this too, and an assertion on the owner's rows alone could not see it.
    await blockUser(db, { userId: other, blockedId: first });

    expect(await listBlockedUserIds(db, owner)).toEqual([third, second, first]);
    expect(await listBlockedUserIds(db, other)).toEqual([first]);
  });

  it("returns an empty list for someone who has blocked nobody", async () => {
    expect(await listBlockedUserIds(db, id("stranger"))).toEqual([]);
  });

  it("reports whether unblocking removed anything", async () => {
    const pair = { userId: id("blocker"), blockedId: id("blocked") };
    await blockUser(db, pair);

    // `DELETE /blocks/:blockedId` answers 404 on the second call, so the two
    // outcomes cannot collapse into "succeeded".
    expect(await unblockUser(db, pair)).toBe(true);
    expect(await unblockUser(db, pair)).toBe(false);
    expect(await listBlockedUserIds(db, pair.userId)).toEqual([]);
  });

  it("unblocks only the named pair", async () => {
    const owner = id("blocker");
    const kept = id("blocked");
    const removed = id("blocked");
    await blockUser(db, { userId: owner, blockedId: kept });
    await blockUser(db, { userId: owner, blockedId: removed });

    await unblockUser(db, { userId: owner, blockedId: removed });
    expect(await listBlockedUserIds(db, owner)).toEqual([kept]);
  });
});

describe("restricts are the same shape and a separate table", () => {
  it("converges, lists and removes exactly as blocks do", async () => {
    const pair = { userId: id("restricter"), restrictedId: id("restricted") };

    expect(await restrictUser(db, pair)).toBe(true);
    expect(await restrictUser(db, pair)).toBe(false);
    expect(await listRestrictedUserIds(db, pair.userId)).toEqual([pair.restrictedId]);
    expect(await unrestrictUser(db, pair)).toBe(true);
    expect(await unrestrictUser(db, pair)).toBe(false);
  });

  it("survives eight concurrent restrictions of the same person", async () => {
    const pair = { userId: id("restricter"), restrictedId: id("restricted") };
    await warmPool(pair.userId);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => restrictUser(db, pair)),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it("does not touch blocks — the two tables are not one table with a kind", async () => {
    const userId = id("blocker");
    const target = id("target");

    await blockUser(db, { userId, blockedId: target });

    // If the port had "DRY'd" these into one table, this would read as restricted.
    expect(await listRestrictedUserIds(db, userId)).toEqual([]);
    expect(await listBlockedUserIds(db, userId)).toEqual([target]);

    await restrictUser(db, { userId, restrictedId: target });
    await unblockUser(db, { userId, blockedId: target });

    // And removing one must not remove the other.
    expect(await listRestrictedUserIds(db, userId)).toEqual([target]);
    expect(await listBlockedUserIds(db, userId)).toEqual([]);
  });
});

describe("user_settings defaults come from the schema, not from the repository", () => {
  it("creates a row with every field ABSENT and lets the server fill it", async () => {
    const oxyUserId = id("settings-user");
    const row = await ensureUserSettings(db, oxyUserId);

    // The fixture shape that matters: NOTHING was supplied but the id and the
    // owner, so each value below is the column's own DEFAULT. A row written with
    // these fields set explicitly could not tell a correct repository from one
    // that hardcodes its own literals.
    expect(row.appearanceThemeMode).toBe("system");
    expect(row.appearancePrimaryColor).toBeNull();
    expect(row.privacyProfileVisibility).toBe("public");
    expect(row.privacyShowContactInfo).toBe(true);
    expect(row.privacyHideLikeCounts).toBe(false);
    expect(row.privacyHiddenWords).toEqual([]);
    expect(row.privacyRestrictedUsers).toEqual([]);
    expect(row.profileCoverPhotoEnabled).toBe(true);
    expect(row.profileMinimalistMode).toBe(false);
  });

  it("keeps cloud sync opt-IN while encryption and P2P are opt-OUT", async () => {
    const row = await ensureUserSettings(db, id("settings-user"));

    // The asymmetry IS the product's device-first stance, so it is asserted as
    // three separate facts rather than "the security defaults are correct".
    expect(row.securityCloudSyncEnabled).toBe(false);
    expect(row.securityEncryptionEnabled).toBe(true);
    expect(row.securityPeerToPeerEnabled).toBe(true);
  });

  it("takes the security values from the column DEFAULT, not from a literal it writes", async () => {
    // The case above cannot distinguish "the repository omitted the column" from
    // "the repository wrote `false` itself" — both produce a `false`. Moving the
    // DEFAULT out from under it can: only a repository that genuinely omits the
    // column sees the new default. A repository that "helpfully normalises"
    // missing settings would still report false here, and that is the mistake
    // most likely to be made, because it looks like defensive coding.
    await client`alter table user_settings alter column security_cloud_sync_enabled set default true`;
    try {
      const row = await ensureUserSettings(db, id("settings-user"));
      expect(row.securityCloudSyncEnabled).toBe(true);
    } finally {
      await client`alter table user_settings alter column security_cloud_sync_enabled set default false`;
    }

    // And the restore worked, so no later case inherits a poisoned default.
    const after = await ensureUserSettings(db, id("settings-user"));
    expect(after.securityCloudSyncEnabled).toBe(false);
  });
});

describe("ensuring settings is idempotent and does not rewrite the row", () => {
  it("returns the same row twice without touching it", async () => {
    const oxyUserId = id("settings-user");
    const first = await ensureUserSettings(db, oxyUserId);

    const probe = async () =>
      client<{ xmin: string; updated_at: string }[]>`
        select xmin::text, updated_at::text from user_settings where oxy_user_id = ${oxyUserId}
      `;

    const before = await probe();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await ensureUserSettings(db, oxyUserId);
    const after = await probe();

    expect(second.id).toBe(first.id);
    // `xmin` is the row's transaction id: an `ON CONFLICT DO UPDATE` careful
    // enough to write identical values still moves it, so this catches what
    // comparing columns cannot. Reading settings must not be a write.
    expect(after[0].xmin).toBe(before[0].xmin);
    expect(after[0].updated_at).toBe(before[0].updated_at);
  });

  it("gives every racer the same row on a user's first request", async () => {
    const oxyUserId = id("settings-user");
    await warmPool(oxyUserId);

    // Eight concurrent first requests: seven lose the unique constraint and take
    // the re-read path, and none may error or produce a second row.
    const rows = await Promise.all(
      Array.from({ length: 8 }, () => ensureUserSettings(db, oxyUserId)),
    );

    const ids = new Set(rows.map((row) => row.id));
    expect(ids.size).toBe(1);
    const stored = await db
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.oxyUserId, oxyUserId));
    expect(stored).toHaveLength(1);
  });
});

describe("a settings update is partial, and is an allow-list", () => {
  it("upserts when there is no row yet, applying the patch over the defaults", async () => {
    const oxyUserId = id("settings-user");
    const row = await updateUserSettings(db, oxyUserId, {
      appearanceThemeMode: "dark",
      securityCloudSyncEnabled: true,
    });

    expect(row.appearanceThemeMode).toBe("dark");
    expect(row.securityCloudSyncEnabled).toBe(true);
    // Untouched columns still get their defaults — this is the `{ upsert: true }`
    // half, and it must not produce a row of nulls.
    expect(row.securityEncryptionEnabled).toBe(true);
    expect(row.privacyProfileVisibility).toBe("public");
  });

  it("leaves every column the patch did not name alone", async () => {
    const oxyUserId = id("settings-user");
    await updateUserSettings(db, oxyUserId, {
      appearanceThemeMode: "dark",
      appearancePrimaryColor: "#ff0000",
      privacyProfileVisibility: "private",
      privacyShowContactInfo: false,
      privacyHiddenWords: ["one", "two"],
      profileDisplayName: "Ada",
      securityCloudSyncEnabled: true,
    });

    const row = await updateUserSettings(db, oxyUserId, { privacyAllowTags: false });

    expect(row.privacyAllowTags).toBe(false);
    // A read-modify-write, or an update built from a reconstructed nested
    // object, would reset these to their defaults here.
    expect(row.appearanceThemeMode).toBe("dark");
    expect(row.appearancePrimaryColor).toBe("#ff0000");
    expect(row.privacyProfileVisibility).toBe("private");
    expect(row.privacyShowContactInfo).toBe(false);
    expect(row.privacyHiddenWords).toEqual(["one", "two"]);
    expect(row.profileDisplayName).toBe("Ada");
    expect(row.securityCloudSyncEnabled).toBe(true);
  });

  it("tells `null` (clear it) from absent (leave it)", async () => {
    const oxyUserId = id("settings-user");
    await updateUserSettings(db, oxyUserId, {
      appearancePrimaryColor: "#00ff00",
      profileDisplayName: "Grace",
    });

    // The distinction the `!== undefined` test exists to make. A fixture set
    // carrying only non-null values sits entirely on one side of it and would
    // pass against an implementation that treated both as "skip" — or both as
    // "write null".
    const row = await updateUserSettings(db, oxyUserId, { appearancePrimaryColor: null });

    expect(row.appearancePrimaryColor).toBeNull();
    expect(row.profileDisplayName).toBe("Grace");
  });

  it("treats an empty patch as Mongo's upsert-and-return, not an error", async () => {
    const oxyUserId = id("settings-user");

    // Reachable in production: the route builds its patch from whichever request
    // fields validated, so a body with nothing recognisable lands here.
    const created = await updateUserSettings(db, oxyUserId, {});
    expect(created.oxyUserId).toBe(oxyUserId);

    const again = await updateUserSettings(db, oxyUserId, {});
    expect(again.id).toBe(created.id);

    const stored = await db
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.oxyUserId, oxyUserId));
    expect(stored).toHaveLength(1);
  });

  it("drops keys outside the allow-list instead of assigning them", async () => {
    const oxyUserId = id("settings-user");
    const victim = id("settings-user");
    const created = await ensureUserSettings(db, oxyUserId);

    // A subtype of the patch, which is how this reaches a repository in
    // practice: nobody writes a cast, somebody widens a type or forwards a
    // richer object. TypeScript's excess-property check only fires on object
    // literals at the call site, so the type alone does not stop this — the
    // allow-list loop does.
    interface HostilePatch extends UserSettingsPatch {
      id?: string;
      oxyUserId?: string;
      createdAt?: Date;
    }
    const hostile: HostilePatch = {
      privacyAllowTags: false,
      id: id("forged"),
      oxyUserId: victim,
      createdAt: new Date(0),
    };

    const row = await updateUserSettings(db, oxyUserId, hostile);

    expect(row.privacyAllowTags).toBe(false);
    expect(row.id).toBe(created.id);
    expect(row.oxyUserId).toBe(oxyUserId);
    expect(row.createdAt.getTime()).toBe(created.createdAt.getTime());

    // And nothing was written under the victim's name.
    const stolen = await db
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.oxyUserId, victim));
    expect(stolen).toHaveLength(0);
  });

  it("moves updated_at when it changes something, and never created_at", async () => {
    const oxyUserId = id("settings-user");
    const created = await ensureUserSettings(db, oxyUserId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const row = await updateUserSettings(db, oxyUserId, { profileMinimalistMode: true });

    expect(row.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    expect(row.createdAt.getTime()).toBe(created.createdAt.getTime());
  });
});

describe("the allow-list is checked against the real table", () => {
  it("names every settings column except identity and timestamps", async () => {
    const IDENTITY_AND_TIMESTAMPS = ["id", "oxyUserId", "createdAt", "updatedAt"];
    const schemaColumns = Object.keys(getTableColumns(schema.userSettings))
      .filter((name) => !IDENTITY_AND_TIMESTAMPS.includes(name))
      .sort();

    // A column added to the schema and forgotten in the tuple would be silently
    // unsettable — an endpoint that appears to accept a field and never stores
    // it. This is the gate that makes the tuple and the table one fact.
    expect([...UPDATABLE_USER_SETTINGS_COLUMNS].sort()).toEqual(schemaColumns);
    // Anti-vacuity: a traversal returning nothing would satisfy the equality above.
    expect(UPDATABLE_USER_SETTINGS_COLUMNS).toHaveLength(21);
  });

  it("excludes identity and timestamp columns", async () => {
    // Stated separately from the equality: that assertion is symmetric, so it
    // would also be satisfied if `getTableColumns` and the tuple BOTH contained
    // `oxyUserId`. These four are the ones whose presence would be a bug.
    for (const forbidden of ["id", "oxyUserId", "createdAt", "updatedAt"]) {
      expect(UPDATABLE_USER_SETTINGS_COLUMNS).not.toContain(forbidden);
    }
  });
});

describe("the closed value sets are enforced by the database", () => {
  it("refuses a theme mode outside the tuple", async () => {
    const oxyUserId = id("settings-user");
    await ensureUserSettings(db, oxyUserId);

    // `text({ enum })` emits no DDL, so the repository's type is a narrowing
    // only. Written raw here because that is the shape a bad value arrives in —
    // from somewhere the TypeScript type never covered.
    const error = await client`
      update user_settings set appearance_theme_mode = 'neon' where oxy_user_id = ${oxyUserId}
    `.then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).not.toBeNull();
    expect(isCheckViolation(error)).toBe(true);
    expect(constraintNameOf(error)).toBe("user_settings_appearance_theme_mode_check");
  });

  it("refuses a profile visibility outside the tuple", async () => {
    // Positive control first: the same raw statement with a value the tuple
    // allows must SUCCEED, so the refusal below is the CHECK answering and not a
    // misspelled column or a missing default.
    const accepted = await client`
      insert into user_settings (id, oxy_user_id, privacy_profile_visibility)
      values (${id("settings")}, ${id("settings-user")}, 'followers_only')
    `.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(accepted).toBeNull();

    const error = await client`
      insert into user_settings (id, oxy_user_id, privacy_profile_visibility)
      values (${id("settings")}, ${id("settings-user")}, 'everyone')
    `.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(isCheckViolation(error)).toBe(true);
    expect(constraintNameOf(error)).toBe("user_settings_privacy_profile_visibility_check");
  });

  it("refuses a second settings row for the same user", async () => {
    const oxyUserId = id("settings-user");
    await ensureUserSettings(db, oxyUserId);

    const error = await db
      .insert(schema.userSettings)
      .values({ id: id("settings"), oxyUserId })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).not.toBeNull();
    expect(isUniqueViolation(error)).toBe(true);
    // The constraint `ensureUserSettings`'s conflict target infers.
    expect(constraintNameOf(error)).toBe("user_settings_oxy_user_id_key");
  });
});

describe("user_behaviors is deleted whole and never read into", () => {
  it("reports whether a row existed to reset", async () => {
    const oxyUserId = id("behavior-user");
    await db.insert(schema.userBehaviors).values({ id: id("behavior"), oxyUserId });

    // The route says "reset successfully" or "nothing to reset" from exactly
    // this, so a `DELETE` that reported success either way would be wrong.
    expect(await deleteUserBehavior(db, oxyUserId)).toBe(true);
    expect(await deleteUserBehavior(db, oxyUserId)).toBe(false);
  });

  it("deletes only the named user's row", async () => {
    const oxyUserId = id("behavior-user");
    const other = id("behavior-user");
    await db.insert(schema.userBehaviors).values([
      { id: id("behavior"), oxyUserId },
      { id: id("behavior"), oxyUserId: other },
    ]);

    await deleteUserBehavior(db, oxyUserId);

    const survivors = await db
      .select()
      .from(schema.userBehaviors)
      .where(eq(schema.userBehaviors.oxyUserId, other));
    expect(survivors).toHaveLength(1);
  });

  it("does not care what shape `preferences` has", async () => {
    const oxyUserId = id("behavior-user");
    // `Schema.Types.Mixed` with no reader: an arbitrary, deeply nested value is
    // exactly what a live row may hold, and nothing on the delete path may parse
    // it. If this ever needs a fixture shaped a particular way, something
    // started reading inside the column.
    await db.insert(schema.userBehaviors).values({
      id: id("behavior"),
      oxyUserId,
      preferences: { a: [1, { b: null }], "weird key": "…", nested: { deep: { deeper: true } } },
    });

    expect(await deleteUserBehavior(db, oxyUserId)).toBe(true);
  });

  it("defaults `preferences` to an empty object rather than null", async () => {
    const oxyUserId = id("behavior-user");
    await db.insert(schema.userBehaviors).values({ id: id("behavior"), oxyUserId });

    const rows = await db
      .select()
      .from(schema.userBehaviors)
      .where(eq(schema.userBehaviors.oxyUserId, oxyUserId));
    // Mongo's `default: {}`, now the column's. A null here would make every
    // future reader of this column need a guard the port could have avoided.
    expect(rows[0].preferences).toEqual({});
  });

  it("refuses a second behaviour row for the same user", async () => {
    const oxyUserId = id("behavior-user");
    await db.insert(schema.userBehaviors).values({ id: id("behavior"), oxyUserId });

    const error = await db
      .insert(schema.userBehaviors)
      .values({ id: id("behavior"), oxyUserId })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).not.toBeNull();
    expect(isUniqueViolation(error)).toBe(true);
    expect(constraintNameOf(error)).toBe("user_behaviors_oxy_user_id_key");
  });
});

describe("the driver-error helpers tell the two failure kinds apart", () => {
  it("does not read a CHECK violation as a unique violation", async () => {
    const error = await client`
      insert into user_settings (id, oxy_user_id, appearance_theme_mode)
      values (${id("settings")}, ${id("settings-user")}, 'neon')
    `.then(
      () => null,
      (caught: unknown) => caught,
    );

    // Both predicates asserted on one error: a helper that answered `true` for
    // any driver error at all would pass every other case in this file.
    expect(isCheckViolation(error)).toBe(true);
    expect(isUniqueViolation(error)).toBe(false);
  });
});
