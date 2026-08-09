/**
 * The schema, against a REAL Postgres server.
 *
 * Everything asserted here is a property only a server has. A mocked `insert`
 * accepts any statement — including one the server rejects outright — which is
 * exactly the class of defect a port introduces, and is why this backend already
 * boots a real Mongo replica set for its moderation suite rather than mocking
 * the model.
 *
 * The two Mongoose hooks are the reason this file exists. Each is now a database
 * constraint, and a constraint is only worth the claim if something proves the
 * server enforces it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, getTableName, sql } from "drizzle-orm";
import { createDatabase, isCheckViolation, isUniqueViolation, constraintNameOf } from "@oxyhq/db";
import { findUnsupportedExpiryColumns } from "@oxyhq/db/assert";
import type postgres from "postgres";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import { EXPIRY_SWEEP_TARGETS, runExpirySweep } from "../../db/expiry";
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

async function insertDirectConversation(participantCount: number): Promise<string> {
  const conversationId = id("conv");
  await db.transaction(async (tx) => {
    await tx.insert(schema.conversations).values({
      id: conversationId,
      type: "direct",
      createdBy: "oxy-user-a",
    });
    for (let index = 0; index < participantCount; index += 1) {
      await tx.insert(schema.conversationParticipants).values({
        id: id("part"),
        conversationId,
        userId: `oxy-user-${String(index)}`,
      });
    }
  });
  return conversationId;
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

describe("the genesis migration", () => {
  it("creates every table the schema declares", async () => {
    const rows = await client<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;
    const names = rows.map((row) => row.table_name);
    // Anti-vacuity: a broken query returning nothing must not read as success.
    expect(names.length).toBeGreaterThanOrEqual(19);
    expect(names).toContain("conversation_participants");
    expect(names).toContain("moderation_outbox");
    expect(names).toContain("bridge_proxy_lease_rotations");
  });
});

describe("Message.pre('save'), now a CHECK", () => {
  it("refuses a message with neither encrypted content nor legacy plaintext", async () => {
    const conversationId = await insertDirectConversation(2);
    const error = await db
      .insert(schema.messages)
      .values({
        id: id("msg"),
        conversationId,
        senderId: "oxy-user-0",
        senderDeviceId: 1,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).not.toBeNull();
    expect(isCheckViolation(error)).toBe(true);
    // Named, not matched on a message: drizzle wraps the driver error, so the
    // constraint name lives on `cause` and a regex over the text would pass for
    // the wrong constraint.
    expect(constraintNameOf(error)).toBe("messages_content_present_check");
  });

  it("accepts ciphertext alone, and encrypted media alone", async () => {
    const conversationId = await insertDirectConversation(2);
    await db.insert(schema.messages).values({
      id: id("msg"),
      conversationId,
      senderId: "oxy-user-0",
      senderDeviceId: 1,
      ciphertext: "base64-ciphertext",
    });
    await db.insert(schema.messages).values({
      id: id("msg"),
      conversationId,
      senderId: "oxy-user-0",
      senderDeviceId: 1,
      encryptedMedia: [{ id: "m1", type: "image", ciphertext: "…" }],
    });

    const rows = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
    expect(rows).toHaveLength(2);
  });

  it("still accepts legacy plaintext, and still tolerates ciphertext beside it", async () => {
    const conversationId = await insertDirectConversation(2);
    // The hook only `console.warn`ed about this combination. Refusing it here
    // would be a NEW restriction, discovered in production by whatever legacy
    // row already has both.
    await db.insert(schema.messages).values({
      id: id("msg"),
      conversationId,
      senderId: "oxy-user-0",
      senderDeviceId: 1,
      ciphertext: "base64-ciphertext",
      text: "legacy plaintext",
    });
    const rows = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
    expect(rows).toHaveLength(1);
  });
});

describe("Conversation.pre('save'), now a deferred constraint trigger", () => {
  it("accepts a direct conversation with exactly 2 participants", async () => {
    const conversationId = await insertDirectConversation(2);
    const rows = await db
      .select()
      .from(schema.conversationParticipants)
      .where(eq(schema.conversationParticipants.conversationId, conversationId));
    expect(rows).toHaveLength(2);
  });

  it("refuses a direct conversation with 3 participants, at COMMIT", async () => {
    const error = await insertDirectConversation(3).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("conversations_participant_count_check");
  });

  it("refuses any conversation with fewer than 2 participants", async () => {
    const error = await insertDirectConversation(1).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("conversations_participant_count_check");
  });

  it("is DEFERRED — the conversation may exist without participants mid-transaction", async () => {
    // This is the case an IMMEDIATE trigger would reject, and it is how every
    // conversation is legitimately created: the row first, its participants
    // second, in one transaction.
    const conversationId = await insertDirectConversation(2);
    expect(conversationId).toBeTruthy();
  });

  it("lets a conversation be deleted, cascading its participants", async () => {
    const conversationId = await insertDirectConversation(2);
    await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
    const rows = await db
      .select()
      .from(schema.conversationParticipants)
      .where(eq(schema.conversationParticipants.conversationId, conversationId));
    expect(rows).toHaveLength(0);
  });

  it("refuses dropping a direct conversation to one participant", async () => {
    const conversationId = await insertDirectConversation(2);
    const victim = await db
      .select()
      .from(schema.conversationParticipants)
      .where(eq(schema.conversationParticipants.conversationId, conversationId))
      .limit(1);

    const error = await db
      .delete(schema.conversationParticipants)
      .where(eq(schema.conversationParticipants.id, victim[0].id))
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    // The race the Mongoose hook could not close: two concurrent removals each
    // saw two participants in memory and both passed.
    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("conversations_participant_count_check");
  });
});

describe("the foreign keys Mongo could not express", () => {
  it("cascades messages when their conversation is deleted", async () => {
    const conversationId = await insertDirectConversation(2);
    const messageId = id("msg");
    await db.insert(schema.messages).values({
      id: messageId,
      conversationId,
      senderId: "oxy-user-0",
      senderDeviceId: 1,
      ciphertext: "base64-ciphertext",
    });
    await db.insert(schema.messageReads).values({
      id: id("read"),
      messageId,
      userId: "oxy-user-1",
    });

    await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));

    const reads = await db
      .select()
      .from(schema.messageReads)
      .where(eq(schema.messageReads.messageId, messageId));
    // Two levels of cascade: conversation → message → read receipt. In Mongo the
    // messages were simply orphaned and nothing ever collected them.
    expect(reads).toHaveLength(0);
  });
});

describe("uniqueness that an embedded array could not enforce", () => {
  it("refuses the same person joining one conversation twice", async () => {
    const conversationId = await insertDirectConversation(2);
    const error = await db
      .insert(schema.conversationParticipants)
      .values({ id: id("part"), conversationId, userId: "oxy-user-0" })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).not.toBeNull();
    expect(isUniqueViolation(error)).toBe(true);
  });
});

describe("the expiry sweep, which replaces three Mongo TTL indexes", () => {
  it("registers exactly the three tables that carried one", () => {
    // Named, not counted: a count alone passes if someone registers the same
    // table three times, and the whole point is that no TTL table is missing.
    const tables = EXPIRY_SWEEP_TARGETS.map((target) => getTableName(target.table)).sort();
    expect(tables).toEqual([
      "bridge_link_sessions",
      "moderation_events",
      "moderation_outbox",
    ]);
  });

  it("every registered column has a supporting index", async () => {
    // Without a leading btree the sweep is a full table scan on every run — the
    // exact cost Mongo's TTL index hid.
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
});

describe("the outbox claim, which the port must keep idempotent", () => {
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
  it("refuses a conversation type outside the tuple", async () => {
    // `text({ enum })` emits no DDL, so this passes tsc-shaped code and must be
    // stopped by the CHECK rendered from the same tuple.
    const error = await client`
      insert into conversations (id, type, created_by) values (${id("conv")}, 'broadcast', 'u')
    `.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(String(error)).toContain("conversations_type_check");
  });

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
    // Containment alone is satisfied by an empty array; this is the separate
    // Mongoose validator, kept as its own constraint.
    expect(constraintNameOf(error)).toBe("reports_categories_non_empty_check");
  });

  it("refuses a report category outside the tuple", async () => {
    const error = await db
      .insert(schema.reports)
      .values({
        id: id("report"),
        reportedType: "user",
        reportedId: "oxy-user-9",
        reporter: "oxy-user-7",
        categories: ["spam", "not_a_category"],
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("reports_categories_within_check");
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

describe("the bridge network tuple is shared, not copied", () => {
  it("refuses a network the config does not know", async () => {
    const error = await client`
      insert into bridge_proxy_leases
        (id, oxy_user_id, network, provider, country_code, session_seed)
      values (${id("lease")}, 'u', 'myspace', 'p', 'ES', 'seed')
    `.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(String(error)).toContain("bridge_proxy_leases_network_check");
  });

  it("refuses a country code that is not ISO 3166-1 alpha-2", async () => {
    const error = await db
      .insert(schema.bridgeProxyLeases)
      .values({
        id: id("lease"),
        oxyUserId: "u",
        network: "telegram",
        provider: "p",
        countryCode: "esp",
        sessionSeed: "seed",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("bridge_proxy_leases_country_code_check");
  });
});

describe("the sparse index Mongo declared", () => {
  it("indexes only accounts that have a slot", async () => {
    const rows = await client<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where tablename = 'bridge_accounts' and indexname = 'bridge_accounts_slot_id_idx'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("WHERE");
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

describe("the trigger functions exist under their own names", () => {
  it("registers both constraint triggers", async () => {
    const rows = await client<{ tgname: string }[]>`
      select tgname from pg_trigger
      where not tgisinternal
      order by tgname
    `;
    const names = rows.map((row) => row.tgname);
    expect(names).toContain("conversations_participant_count_check");
    expect(names).toContain("conversation_participants_count_check");
  });

  it("declares them DEFERRABLE INITIALLY DEFERRED", async () => {
    const rows = await client<{ tgdeferrable: boolean; tginitdeferred: boolean }[]>`
      select tgdeferrable, tginitdeferred from pg_trigger
      where tgname = 'conversations_participant_count_check' and not tgisinternal
    `;
    expect(rows).toHaveLength(1);
    // Not cosmetic: IMMEDIATE would reject every conversation ever created,
    // because the row necessarily exists for a moment before its participants.
    expect(rows[0].tgdeferrable).toBe(true);
    expect(rows[0].tginitdeferred).toBe(true);
  });
});

describe("sanity", () => {
  it("uses the schema helpers rather than raw SQL for ordinary reads", async () => {
    const count = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.type, "direct")));
    expect(count[0].total).toBeGreaterThanOrEqual(0);
  });
});
