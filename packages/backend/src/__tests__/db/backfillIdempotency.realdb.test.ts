/**
 * The one claim `scripts/backfillFromMongo.ts` rests on, against a REAL server.
 *
 * The operational plan runs that script TWICE against production — once before
 * the switch merges and once after the rollout, so the window in between is
 * swept. That is only safe if a second pass over a row that already landed
 * writes NOTHING: not a new row, and not a new version of the existing one.
 *
 * "Writes nothing" is a property no mock can answer. A mocked `insert` accepts
 * any statement and reports whatever it was told to, so it agrees with the claim
 * by construction. Here the row's own `xmin` is the evidence — Postgres bumps it
 * on any real write, including one that stores identical values — which is the
 * same discriminator `moderation.realdb.test.ts` uses for the outbox enqueue,
 * and for the same reason.
 *
 * What this file does NOT do is drive the script itself: it needs a live Mongo,
 * and the shape under test is the CONFLICT TARGET of each insert. So each case
 * reproduces one insert exactly as the script issues it, including which unique
 * constraint it converges on — because choosing the wrong target is the mistake
 * that would survive every other check. A second pass keyed on `id` where the
 * live service had already re-created the row under a new primary key does not
 * converge; it raises a unique violation on `oxy_user_id` and takes the whole
 * run down.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDatabase, uuidv7 } from "@oxyhq/db";
import type postgres from "postgres";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import * as schema from "../../db/schema";

let handle: TestDatabaseHandle;
let db: ReturnType<typeof createDatabase<typeof schema>>["db"];
let client: postgres.Sql;

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

/** The row version. Any real write moves it, including one storing equal values. */
async function xminOf(table: string, id: string): Promise<string> {
  const rows = await client<{ xmin: string }[]>`
    select xmin::text as xmin from ${client(table)} where id = ${id}
  `;
  const row = rows[0];
  if (!row) throw new Error(`no ${table} row ${id}`);
  return row.xmin;
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

describe("a second backfill pass over a row that already landed", () => {
  it("writes nothing at all — no row, no new tuple version", async () => {
    const id = unique("settings");
    const oxyUserId = unique("user");
    const values = {
      id,
      oxyUserId,
      securityCloudSyncEnabled: false,
      createdAt: new Date("2026-06-11T22:58:41.404Z"),
      updatedAt: new Date("2026-06-11T22:58:41.404Z"),
    };

    const first = await db
      .insert(schema.userSettings)
      .values(values)
      .onConflictDoNothing({ target: schema.userSettings.oxyUserId })
      .returning({ id: schema.userSettings.id });
    expect(first).toHaveLength(1);
    const before = await xminOf("user_settings", id);

    // A real interval, so an unchanged version cannot be same-instant luck.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await db
      .insert(schema.userSettings)
      .values(values)
      .onConflictDoNothing({ target: schema.userSettings.oxyUserId })
      .returning({ id: schema.userSettings.id });

    // The empty RETURNING set IS how the script counts a skip.
    expect(second).toHaveLength(0);
    expect(await xminOf("user_settings", id)).toBe(before);

    const rows = await db
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.oxyUserId, oxyUserId));
    expect(rows).toHaveLength(1);
    // The stored row is still the FIRST one, with Mongo's own creation time.
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.createdAt.toISOString()).toBe("2026-06-11T22:58:41.404Z");
  });

  /**
   * The case that decides the conflict TARGET, and the reason it is not `id`.
   *
   * Between the two runs the live service can lazily re-create a settings row
   * for the same person under a fresh uuid v7 — `ensureUserSettings` does
   * exactly that on any read. The backfill's row then carries a DIFFERENT
   * primary key and the SAME `oxy_user_id`. Keyed on `id` there is no conflict
   * to skip, so the insert reaches the unique index on `oxy_user_id` and raises;
   * keyed on `oxy_user_id` it converges, leaves the live row alone, and the run
   * survives.
   *
   * The live row winning is the correct outcome: after the switch Postgres is
   * the authority and the backfill is the stale copy.
   */
  it("skips a user whose row the live service re-created under a new id", async () => {
    const oxyUserId = unique("user");
    const liveId = uuidv7();
    await db
      .insert(schema.userSettings)
      .values({ id: liveId, oxyUserId, securityCloudSyncEnabled: true });

    const backfilled = await db
      .insert(schema.userSettings)
      .values({
        id: unique("mongo-objectid"),
        oxyUserId,
        securityCloudSyncEnabled: false,
      })
      .onConflictDoNothing({ target: schema.userSettings.oxyUserId })
      .returning({ id: schema.userSettings.id });

    expect(backfilled).toHaveLength(0);
    const rows = await db
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.oxyUserId, oxyUserId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(liveId);
    // The live value survived; the stale copy did not overwrite it.
    expect(rows[0]?.securityCloudSyncEnabled).toBe(true);
  });

  it("converges on the natural key for a device, not on the primary key", async () => {
    // Same shape one table over: a re-registered device keeps its Signal device
    // number under a new primary key, so `(user_id, device_id)` is the target.
    const userId = unique("user");
    const liveId = uuidv7();
    const device = {
      userId,
      deviceId: 1,
      identityKeyPublic: "live-identity-key",
      signedPreKeyId: 7,
      signedPreKeyPublic: "live-signed-pre-key",
      signedPreKeySignature: "live-signature",
      registrationId: 42,
    };
    await db.insert(schema.devices).values({ id: liveId, ...device });

    const backfilled = await db
      .insert(schema.devices)
      .values({ ...device, id: unique("mongo-objectid"), identityKeyPublic: "stale-key" })
      .onConflictDoNothing({ target: [schema.devices.userId, schema.devices.deviceId] })
      .returning({ id: schema.devices.id });

    expect(backfilled).toHaveLength(0);
    const rows = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identityKeyPublic).toBe("live-identity-key");
  });

  /**
   * The child-row ids are DERIVED, and this is what that buys.
   *
   * A participant, a read receipt and a reaction were embedded in Mongo with no
   * `_id` of their own. Minting a uuid v7 for them would produce a different id
   * on the second run, so `ON CONFLICT DO NOTHING` would have nothing to
   * conflict WITH on the primary key — and the row would be inserted twice
   * unless the natural key happened to catch it. Deriving the id from the parent
   * and the natural key makes both runs name the same row.
   */
  it("re-derives the same child id on a second pass, so a participant cannot double", async () => {
    const conversationId = unique("conv");
    const userA = unique("user");
    const userB = unique("user");
    const childId = (userId: string) => `${conversationId}:participant:${userId}`;

    const insertPair = async () =>
      await db.transaction(async (tx) => {
        await tx
          .insert(schema.conversations)
          .values({ id: conversationId, type: "direct", createdBy: userA })
          .onConflictDoNothing({ target: schema.conversations.id });
        return await tx
          .insert(schema.conversationParticipants)
          .values([
            { id: childId(userA), conversationId, userId: userA },
            { id: childId(userB), conversationId, userId: userB },
          ])
          .onConflictDoNothing({
            target: [
              schema.conversationParticipants.conversationId,
              schema.conversationParticipants.userId,
            ],
          })
          .returning({ id: schema.conversationParticipants.id });
      });

    expect(await insertPair()).toHaveLength(2);
    expect(await insertPair()).toHaveLength(0);

    const rows = await db
      .select()
      .from(schema.conversationParticipants)
      .where(eq(schema.conversationParticipants.conversationId, conversationId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id).sort()).toEqual([childId(userA), childId(userB)].sort());
  });

  it("keeps the deferred participant-count constraint satisfiable in one transaction", async () => {
    /**
     * The reason the conversation and its participants are inserted TOGETHER.
     * `conversations_participant_count_check` is deferred, so a `direct`
     * conversation must have exactly two participants at COMMIT — inserting the
     * parents in their own transaction fails at the end of it, which is a
     * failure mode no amount of retrying fixes.
     */
    const conversationId = unique("conv");
    const failure = await db
      .transaction(async (tx) => {
        await tx
          .insert(schema.conversations)
          .values({ id: conversationId, type: "direct", createdBy: unique("user") });
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(failure).not.toBeNull();
    /**
     * Matched on the message rather than on a constraint NAME: this one is a
     * constraint TRIGGER that `RAISE`s, so there is no `constraint_name` on the
     * error to read — and the message is the more useful assertion anyway, since
     * it names the conversation and the count it actually saw.
     */
    expect(String(failure)).toContain("must have at least 2");
    expect(String(failure)).toContain(conversationId);
  });
});

/** Anti-vacuity: a broken harness must not read as five passing cases. */
describe("the harness itself", () => {
  it("is looking at a real, migrated database", async () => {
    const rows = await client<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;
    expect(rows[0]?.n).toBeGreaterThanOrEqual(19);
    expect(await xminOf.name).toBeTruthy();
    // And `xmin` really does move on a genuine write, or every assertion above
    // that compares two of them is vacuous.
    const id = unique("settings");
    await db.insert(schema.userSettings).values({ id, oxyUserId: unique("user") });
    const before = await xminOf("user_settings", id);
    await db
      .update(schema.userSettings)
      .set({ profileMinimalistMode: true })
      .where(eq(schema.userSettings.id, id));
    expect(await xminOf("user_settings", id)).not.toBe(before);
    await db.execute(sql`select 1`);
  });
});
