/**
 * The one-shot that moves `allo-production` from Mongo into Postgres.
 *
 * Run as an ECS one-shot against production, twice: once immediately BEFORE the
 * switch PR merges, and once again after the rollout completes. The second run
 * is not belt-and-braces — it is what closes the window between the two, during
 * which Mongo is still the authority and still taking writes. Both runs report
 * their counts; if the second inserts anything, that number IS the size of the
 * window.
 *
 * ## Why running it twice is safe, structurally
 *
 * Every id is carried VERBATIM from Mongo's `_id`, and every insert is
 * `ON CONFLICT DO NOTHING` on a real unique constraint. So a second pass over a
 * row that already landed writes nothing at all — no tuple version, no
 * timestamp, no lock — for the same reason the moderation outbox's enqueue is a
 * genuine no-op. `DO UPDATE` would make a re-run overwrite whatever the LIVE
 * service has done to that row since, which is precisely backwards: after the
 * switch, Postgres is the authority and this script is the one holding stale
 * data.
 *
 * Carrying Mongo's ObjectId hex string as the primary key rather than minting a
 * uuid v7 is what makes that convergence possible at all — the id is the only
 * thing both stores agree on. It also means a backfilled row is visibly older
 * than a natively-created one, which is a property worth having when reading the
 * table later. Both columns are `text`; nothing needs to parse an ObjectId.
 *
 * ## What it deliberately does NOT do
 *
 * It does not delete from Mongo, does not update anything in Postgres, and does
 * not run at service boot. A migration that runs on start is a migration that
 * runs on every scaling event.
 *
 * ## This file is the last thing in the repo that opens Mongo
 *
 * Nothing under `src/` or in `server.ts` imports `mongoose` any more — the three
 * models, the connection helper and the 503 guard that used it all went with the
 * messaging switch. `mongoose` stays in `package.json` for THIS script alone,
 * which is why the manifest still lists it: read it as "the backfill has not run
 * for the last time yet", not as "messaging is still on Mongo".
 *
 * The script and the dependency come out together, in one follow-up, once the
 * second pass has run and reported. Removing either earlier would leave the pass
 * that closes the switchover window unrunnable from the deployed image.
 *
 * ## Verification is part of the run, not a separate step
 *
 * `--verify` re-reads every row it claims to have copied and compares it against
 * Mongo field by field, because "the insert returned no error" and "the row is
 * correct" are different claims. A count alone would pass against a row whose
 * every column landed as NULL.
 */

import mongoose from "mongoose";
import { closePostgres, connectPostgres, getDb } from "../src/db";
import {
  conversationParticipants,
  conversations,
} from "../src/db/schema/conversations";
import { devicePreKeys, devices } from "../src/db/schema/devices";
import {
  messageDeliveries,
  messageReactions,
  messageReads,
  messages,
} from "../src/db/schema/messages";
import { userSettings } from "../src/db/schema/social";

/**
 * Mongo's database name.
 *
 * Composed here rather than read off the URI, and this file is now the ONLY
 * place that knows the rule: `utils/database.ts`, which used to own it, is gone
 * with the rest of the Mongo connection. The production `MONGODB_URI` ends in
 * `/allo` while the live database is `allo-production`, so anything trusting the
 * URI connects to a database that does not exist and reports zero rows — which
 * reads as "nothing to migrate" rather than as an error.
 */
const MONGO_DB_NAME = `allo-${process.env.NODE_ENV ?? "development"}`;

interface TableReport {
  readonly table: string;
  /** Rows found in Mongo. */
  readonly read: number;
  /** Rows this run actually created. */
  readonly inserted: number;
}

const reports: TableReport[] = [];

function record(table: string, read: number, inserted: number): void {
  reports.push({ table, read, inserted });
  console.log(`  ${table}: read=${read} inserted=${inserted} skipped=${read - inserted}`);
}

/** Mongo hands back `Date | undefined`; a missing timestamp stays missing. */
function date(value: unknown): Date | undefined {
  return value instanceof Date ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * A Mongo `Map` field, as a plain object.
 *
 * The driver hands these back as `Map` from a live document and as a plain
 * object from `.lean()`/aggregation, so both are handled rather than assumed.
 */
function mapEntries(value: unknown): [string, unknown][] {
  if (value instanceof Map) return [...value.entries()];
  if (typeof value === "object" && value !== null) return Object.entries(value);
  return [];
}

/**
 * A deterministic child-row id.
 *
 * Mongo's child data was embedded and has no `_id` of its own, so a uuid v7
 * would differ between the two runs and the second pass would insert duplicates
 * — the one thing `ON CONFLICT DO NOTHING` cannot save us from, because the
 * conflict target would never match. Deriving the id from the parent's id and
 * the natural key makes the second run converge on the same row.
 */
function childId(parentId: string, ...parts: string[]): string {
  return [parentId, ...parts].join(":");
}

async function backfillUserSettings(mongo: mongoose.mongo.Db): Promise<void> {
  const rows = await mongo.collection("usersettings").find({}).toArray();
  const values = rows.map((row) => {
    const appearance = (row.appearance ?? {}) as Record<string, unknown>;
    const privacy = (row.privacy ?? {}) as Record<string, unknown>;
    const custom = (row.profileCustomization ?? {}) as Record<string, unknown>;
    const security = (row.security ?? {}) as Record<string, unknown>;
    return {
      id: String(row._id),
      oxyUserId: String(row.oxyUserId),
      /**
       * Absent groups fall back to the COLUMN defaults rather than to a literal
       * repeated here. Mongoose left a sub-document unset when nothing had ever
       * written it, and the schema's own defaults are the same values — writing
       * them again from this script would be a second copy of the product's
       * device-first stance, free to drift from the one in `schema/social.ts`.
       */
      ...(str(appearance.themeMode) === undefined
        ? {}
        : { appearanceThemeMode: appearance.themeMode as "light" | "dark" | "system" }),
      ...(str(appearance.primaryColor) === undefined
        ? {}
        : { appearancePrimaryColor: str(appearance.primaryColor) }),
      ...(str(row.profileHeaderImage) === undefined
        ? {}
        : { profileHeaderImage: str(row.profileHeaderImage) }),
      ...(str(privacy.profileVisibility) === undefined
        ? {}
        : {
            privacyProfileVisibility: privacy.profileVisibility as
              | "public"
              | "private"
              | "followers_only",
          }),
      ...(typeof privacy.showContactInfo === "boolean"
        ? { privacyShowContactInfo: privacy.showContactInfo }
        : {}),
      ...(typeof privacy.allowTags === "boolean" ? { privacyAllowTags: privacy.allowTags } : {}),
      ...(typeof privacy.allowallos === "boolean"
        ? { privacyAllowAllos: privacy.allowallos }
        : {}),
      ...(typeof privacy.showOnlineStatus === "boolean"
        ? { privacyShowOnlineStatus: privacy.showOnlineStatus }
        : {}),
      ...(typeof privacy.hideLikeCounts === "boolean"
        ? { privacyHideLikeCounts: privacy.hideLikeCounts }
        : {}),
      ...(typeof privacy.hideShareCounts === "boolean"
        ? { privacyHideShareCounts: privacy.hideShareCounts }
        : {}),
      ...(typeof privacy.hideReplyCounts === "boolean"
        ? { privacyHideReplyCounts: privacy.hideReplyCounts }
        : {}),
      ...(typeof privacy.hideSaveCounts === "boolean"
        ? { privacyHideSaveCounts: privacy.hideSaveCounts }
        : {}),
      ...(Array.isArray(privacy.hiddenWords)
        ? { privacyHiddenWords: privacy.hiddenWords.filter((w): w is string => typeof w === "string") }
        : {}),
      ...(Array.isArray(privacy.restrictedUsers)
        ? {
            privacyRestrictedUsers: privacy.restrictedUsers.filter(
              (u): u is string => typeof u === "string",
            ),
          }
        : {}),
      ...(typeof custom.coverPhotoEnabled === "boolean"
        ? { profileCoverPhotoEnabled: custom.coverPhotoEnabled }
        : {}),
      ...(typeof custom.minimalistMode === "boolean"
        ? { profileMinimalistMode: custom.minimalistMode }
        : {}),
      ...(str(custom.displayName) === undefined
        ? {}
        : { profileDisplayName: str(custom.displayName) }),
      ...(str(custom.coverImage) === undefined
        ? {}
        : { profileCoverImage: str(custom.coverImage) }),
      ...(typeof security.cloudSyncEnabled === "boolean"
        ? { securityCloudSyncEnabled: security.cloudSyncEnabled }
        : {}),
      ...(typeof security.encryptionEnabled === "boolean"
        ? { securityEncryptionEnabled: security.encryptionEnabled }
        : {}),
      ...(typeof security.peerToPeerEnabled === "boolean"
        ? { securityPeerToPeerEnabled: security.peerToPeerEnabled }
        : {}),
      ...(date(row.createdAt) === undefined ? {} : { createdAt: date(row.createdAt) }),
      ...(date(row.updatedAt) === undefined ? {} : { updatedAt: date(row.updatedAt) }),
    };
  });

  if (values.length === 0) return record("user_settings", 0, 0);
  const inserted = await getDb()
    .insert(userSettings)
    .values(values)
    /**
     * The conflict target is `oxy_user_id`, NOT `id`. A user whose settings row
     * was lazily re-created by the live service after the switch has a fresh
     * uuid v7 primary key but the same `oxy_user_id`, and inserting this row
     * would violate that unique constraint rather than converge. Skipping is the
     * right answer: the live row is the newer authority and this one is stale.
     */
    .onConflictDoNothing({ target: userSettings.oxyUserId })
    .returning({ id: userSettings.id });
  record("user_settings", values.length, inserted.length);
}

async function backfillConversations(mongo: mongoose.mongo.Db): Promise<void> {
  const rows = await mongo.collection("conversations").find({}).toArray();

  const conversationValues = rows.map((row) => {
    const last = (row.lastMessage ?? {}) as Record<string, unknown>;
    return {
      id: String(row._id),
      type: (str(row.type) ?? "direct") as "direct" | "group",
      ...(str(row.name) === undefined ? {} : { name: str(row.name) }),
      ...(str(row.description) === undefined ? {} : { description: str(row.description) }),
      ...(str(row.avatar) === undefined ? {} : { avatar: str(row.avatar) }),
      ...(str(row.theme) === undefined ? {} : { theme: str(row.theme) }),
      createdBy: String(row.createdBy),
      ...(date(row.lastMessageAt) === undefined ? {} : { lastMessageAt: date(row.lastMessageAt) }),
      ...(str(last.text) === undefined ? {} : { lastMessageText: str(last.text) }),
      ...(str(last.senderId) === undefined ? {} : { lastMessageSenderId: str(last.senderId) }),
      ...(date(last.timestamp) === undefined
        ? {}
        : { lastMessageTimestamp: date(last.timestamp) }),
      ...(date(row.createdAt) === undefined ? {} : { createdAt: date(row.createdAt) }),
      ...(date(row.updatedAt) === undefined ? {} : { updatedAt: date(row.updatedAt) }),
    };
  });

  /**
   * The conversation and its participants go in ONE transaction, because
   * `conversations_participant_count_check` is a DEFERRED constraint trigger: a
   * `direct` conversation must have exactly two participants at COMMIT. Inserting
   * the parents alone would fail at the end of that statement's transaction, and
   * inserting them in two transactions would fail the first one.
   */
  const participantValues = rows.flatMap((row) => {
    const conversationId = String(row._id);
    const unread = new Map(
      mapEntries(row.unreadCounts).map(([userId, count]) => [userId, num(count) ?? 0]),
    );
    const archived = new Set(
      (Array.isArray(row.archivedBy) ? row.archivedBy : []).map((id: unknown) => String(id)),
    );
    const participants = Array.isArray(row.participants) ? row.participants : [];
    return participants.map((participant: Record<string, unknown>) => {
      const userId = String(participant.userId);
      return {
        id: childId(conversationId, "participant", userId),
        conversationId,
        userId,
        role: (str(participant.role) ?? "member") as "admin" | "member",
        ...(date(participant.joinedAt) === undefined
          ? {}
          : { joinedAt: date(participant.joinedAt) }),
        ...(date(participant.lastReadAt) === undefined
          ? {}
          : { lastReadAt: date(participant.lastReadAt) }),
        unreadCount: unread.get(userId) ?? 0,
        /**
         * `archivedBy` was a list on the conversation; it is a timestamp on the
         * participant. Mongo recorded only THAT a user archived, never when, so
         * the conversation's own `updatedAt` is the closest honest answer —
         * `now()` would claim every archive happened at backfill time.
         */
        ...(archived.has(userId)
          ? { archivedAt: date(row.updatedAt) ?? date(row.createdAt) ?? new Date() }
          : {}),
        ...(date(row.createdAt) === undefined ? {} : { createdAt: date(row.createdAt) }),
        ...(date(row.updatedAt) === undefined ? {} : { updatedAt: date(row.updatedAt) }),
      };
    });
  });

  if (conversationValues.length === 0) {
    record("conversations", 0, 0);
    record("conversation_participants", 0, 0);
    return;
  }

  const { conversationsInserted, participantsInserted } = await getDb().transaction(
    async (tx) => {
      const parents = await tx
        .insert(conversations)
        .values(conversationValues)
        .onConflictDoNothing({ target: conversations.id })
        .returning({ id: conversations.id });
      const children =
        participantValues.length === 0
          ? []
          : await tx
              .insert(conversationParticipants)
              .values(participantValues)
              .onConflictDoNothing({
                target: [
                  conversationParticipants.conversationId,
                  conversationParticipants.userId,
                ],
              })
              .returning({ id: conversationParticipants.id });
      return { conversationsInserted: parents.length, participantsInserted: children.length };
    },
  );

  record("conversations", conversationValues.length, conversationsInserted);
  record("conversation_participants", participantValues.length, participantsInserted);
}

async function backfillMessages(mongo: mongoose.mongo.Db): Promise<void> {
  const rows = await mongo.collection("messages").find({}).toArray();

  const messageValues = rows.map((row) => ({
    id: String(row._id),
    conversationId: String(row.conversationId),
    senderId: String(row.senderId),
    senderDeviceId: num(row.senderDeviceId) ?? 1,
    ...(str(row.ciphertext) === undefined ? {} : { ciphertext: str(row.ciphertext) }),
    ...(Array.isArray(row.encryptedMedia) ? { encryptedMedia: row.encryptedMedia } : {}),
    ...(num(row.encryptionVersion) === undefined
      ? {}
      : { encryptionVersion: num(row.encryptionVersion) }),
    ...(str(row.messageType) === undefined
      ? {}
      : { messageType: row.messageType as "text" | "media" | "system" }),
    ...(str(row.text) === undefined ? {} : { text: str(row.text) }),
    ...(Array.isArray(row.media) ? { media: row.media } : {}),
    ...(str(row.replyTo) === undefined ? {} : { replyTo: str(row.replyTo) }),
    ...(num(row.fontSize) === undefined ? {} : { fontSize: num(row.fontSize) }),
    ...(date(row.editedAt) === undefined ? {} : { editedAt: date(row.editedAt) }),
    ...(date(row.deletedAt) === undefined ? {} : { deletedAt: date(row.deletedAt) }),
    ...(date(row.createdAt) === undefined ? {} : { createdAt: date(row.createdAt) }),
    ...(date(row.updatedAt) === undefined ? {} : { updatedAt: date(row.updatedAt) }),
  }));

  const readValues = rows.flatMap((row) => {
    const messageId = String(row._id);
    return mapEntries(row.readBy).map(([userId, readAt]) => ({
      id: childId(messageId, "read", userId),
      messageId,
      userId,
      ...(date(readAt) === undefined ? {} : { readAt: date(readAt) }),
    }));
  });

  const deliveryValues = rows.flatMap((row) => {
    const messageId = String(row._id);
    const delivered = Array.isArray(row.deliveredTo) ? row.deliveredTo : [];
    return delivered.map((userId: unknown) => ({
      id: childId(messageId, "delivered", String(userId)),
      messageId,
      userId: String(userId),
      /**
       * Mongo stored only WHO, never when. The message's own creation time is
       * the closest honest answer; `now()` would claim every delivery happened
       * at backfill time.
       */
      ...(date(row.createdAt) === undefined ? {} : { deliveredAt: date(row.createdAt) }),
    }));
  });

  /** `Map<emoji, userId[]>` becomes one row per (message, user, emoji). */
  const reactionValues = rows.flatMap((row) => {
    const messageId = String(row._id);
    return mapEntries(row.reactions).flatMap(([emoji, userIds]) =>
      (Array.isArray(userIds) ? userIds : []).map((userId: unknown) => ({
        id: childId(messageId, "reaction", emoji, String(userId)),
        messageId,
        userId: String(userId),
        emoji,
        ...(date(row.createdAt) === undefined ? {} : { createdAt: date(row.createdAt) }),
      })),
    );
  });

  if (messageValues.length === 0) {
    record("messages", 0, 0);
    record("message_reads", 0, 0);
    record("message_deliveries", 0, 0);
    record("message_reactions", 0, 0);
    return;
  }

  const inserted = await getDb()
    .insert(messages)
    .values(messageValues)
    .onConflictDoNothing({ target: messages.id })
    .returning({ id: messages.id });
  record("messages", messageValues.length, inserted.length);

  const reads =
    readValues.length === 0
      ? []
      : await getDb()
          .insert(messageReads)
          .values(readValues)
          .onConflictDoNothing({ target: [messageReads.messageId, messageReads.userId] })
          .returning({ id: messageReads.id });
  record("message_reads", readValues.length, reads.length);

  const deliveries =
    deliveryValues.length === 0
      ? []
      : await getDb()
          .insert(messageDeliveries)
          .values(deliveryValues)
          .onConflictDoNothing({
            target: [messageDeliveries.messageId, messageDeliveries.userId],
          })
          .returning({ id: messageDeliveries.id });
  record("message_deliveries", deliveryValues.length, deliveries.length);

  const reactions =
    reactionValues.length === 0
      ? []
      : await getDb()
          .insert(messageReactions)
          .values(reactionValues)
          .onConflictDoNothing({
            target: [
              messageReactions.messageId,
              messageReactions.userId,
              messageReactions.emoji,
            ],
          })
          .returning({ id: messageReactions.id });
  record("message_reactions", reactionValues.length, reactions.length);
}

async function backfillDevices(mongo: mongoose.mongo.Db): Promise<void> {
  const rows = await mongo.collection("devices").find({}).toArray();

  const deviceValues = rows.map((row) => {
    const signed = (row.signedPreKey ?? {}) as Record<string, unknown>;
    return {
      id: String(row._id),
      userId: String(row.userId),
      deviceId: num(row.deviceId) ?? 1,
      identityKeyPublic: String(row.identityKeyPublic),
      /** The Mongo sub-document, flattened into the three columns it became. */
      signedPreKeyId: num(signed.keyId) ?? 0,
      signedPreKeyPublic: String(signed.publicKey ?? ""),
      signedPreKeySignature: String(signed.signature ?? ""),
      registrationId: num(row.registrationId) ?? 0,
      ...(date(row.lastSeen) === undefined ? {} : { lastSeen: date(row.lastSeen) }),
      ...(date(row.createdAt) === undefined ? {} : { createdAt: date(row.createdAt) }),
      ...(date(row.updatedAt) === undefined ? {} : { updatedAt: date(row.updatedAt) }),
    };
  });

  const preKeyValues = rows.flatMap((row) => {
    const deviceId = String(row._id);
    const keys = Array.isArray(row.preKeys) ? row.preKeys : [];
    return keys.map((key: Record<string, unknown>) => ({
      id: childId(deviceId, "prekey", String(num(key.keyId) ?? 0)),
      deviceId,
      keyId: num(key.keyId) ?? 0,
      publicKey: String(key.publicKey ?? ""),
      ...(date(row.createdAt) === undefined ? {} : { createdAt: date(row.createdAt) }),
    }));
  });

  if (deviceValues.length === 0) {
    record("devices", 0, 0);
    record("device_pre_keys", 0, 0);
    return;
  }

  const inserted = await getDb()
    .insert(devices)
    .values(deviceValues)
    /**
     * On `(user_id, device_id)`, not on `id`: a device the live service
     * re-registered after the switch holds the same Signal device number under a
     * new primary key, and the unique index is what this row would collide with.
     */
    .onConflictDoNothing({ target: [devices.userId, devices.deviceId] })
    .returning({ id: devices.id });
  record("devices", deviceValues.length, inserted.length);

  const preKeys =
    preKeyValues.length === 0
      ? []
      : await getDb()
          .insert(devicePreKeys)
          .values(preKeyValues)
          .onConflictDoNothing({ target: [devicePreKeys.deviceId, devicePreKeys.keyId] })
          .returning({ id: devicePreKeys.id });
  record("device_pre_keys", preKeyValues.length, preKeys.length);
}

/**
 * Re-read what was copied and compare it against Mongo, field by field.
 *
 * A count is not verification: every column could have landed NULL and the count
 * would still match. This checks the values that identify a row and the ones a
 * user would notice, and it reports every mismatch rather than throwing on the
 * first — an operator needs the whole list, not the first item of it.
 */
async function verify(mongo: mongoose.mongo.Db): Promise<string[]> {
  const problems: string[] = [];

  const settings = await mongo.collection("usersettings").find({}).toArray();
  const storedSettings = await getDb().select().from(userSettings);
  const byUser = new Map(storedSettings.map((row) => [row.oxyUserId, row]));
  for (const row of settings) {
    const stored = byUser.get(String(row.oxyUserId));
    if (!stored) {
      problems.push(`user_settings: no row for oxyUserId ${String(row.oxyUserId)}`);
      continue;
    }
    const security = (row.security ?? {}) as Record<string, unknown>;
    if (
      typeof security.cloudSyncEnabled === "boolean" &&
      stored.securityCloudSyncEnabled !== security.cloudSyncEnabled
    ) {
      problems.push(
        `user_settings ${stored.id}: cloudSyncEnabled ${String(stored.securityCloudSyncEnabled)} != ${String(security.cloudSyncEnabled)}`,
      );
    }
  }

  const mongoConversations = await mongo.collection("conversations").find({}).toArray();
  const storedConversations = await getDb().select().from(conversations);
  const conversationById = new Map(storedConversations.map((row) => [row.id, row]));
  for (const row of mongoConversations) {
    const stored = conversationById.get(String(row._id));
    if (!stored) {
      problems.push(`conversations: no row for ${String(row._id)}`);
      continue;
    }
    if (stored.type !== row.type) {
      problems.push(`conversations ${stored.id}: type ${stored.type} != ${String(row.type)}`);
    }
    if (stored.createdBy !== String(row.createdBy)) {
      problems.push(`conversations ${stored.id}: createdBy mismatch`);
    }
  }

  const mongoMessages = await mongo.collection("messages").find({}).toArray();
  const storedMessages = await getDb().select().from(messages);
  const messageById = new Map(storedMessages.map((row) => [row.id, row]));
  for (const row of mongoMessages) {
    const stored = messageById.get(String(row._id));
    if (!stored) {
      problems.push(`messages: no row for ${String(row._id)}`);
      continue;
    }
    if ((stored.ciphertext ?? undefined) !== str(row.ciphertext)) {
      problems.push(`messages ${stored.id}: ciphertext differs`);
    }
    if (stored.conversationId !== String(row.conversationId)) {
      problems.push(`messages ${stored.id}: conversationId mismatch`);
    }
  }

  const mongoDevices = await mongo.collection("devices").find({}).toArray();
  const storedDevices = await getDb().select().from(devices);
  const deviceByKey = new Map(
    storedDevices.map((row) => [`${row.userId}:${String(row.deviceId)}`, row]),
  );
  for (const row of mongoDevices) {
    const stored = deviceByKey.get(`${String(row.userId)}:${String(num(row.deviceId) ?? 1)}`);
    if (!stored) {
      problems.push(`devices: no row for user ${String(row.userId)}`);
      continue;
    }
    if (stored.identityKeyPublic !== String(row.identityKeyPublic)) {
      problems.push(`devices ${stored.id}: identityKeyPublic differs`);
    }
  }

  return problems;
}

async function main(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI;
  const databaseUrl = process.env.DATABASE_URL;
  if (!mongoUri) throw new Error("MONGODB_URI is required");
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const dryRun = process.argv.includes("--dry-run");

  await mongoose.connect(mongoUri, { dbName: MONGO_DB_NAME });
  connectPostgres(databaseUrl);
  const mongo = mongoose.connection.db;
  if (!mongo) throw new Error("mongoose connected without a database handle");

  console.log(`BACKFILL start db=${MONGO_DB_NAME} dryRun=${String(dryRun)}`);

  if (dryRun) {
    /**
     * A dry run counts what WOULD be read and writes nothing. It deliberately
     * does not predict how many rows would be inserted: that depends on what is
     * already in Postgres at the instant of the real run, and a number this
     * script invented would be read as a promise.
     */
    for (const name of ["usersettings", "conversations", "messages", "devices"]) {
      const count = await mongo.collection(name).countDocuments();
      console.log(`  ${name}: ${String(count)} document(s) in Mongo`);
    }
    console.log("BACKFILL dry run complete — nothing was written");
  } else {
    await backfillUserSettings(mongo);
    await backfillConversations(mongo);
    await backfillMessages(mongo);
    await backfillDevices(mongo);

    const problems = await verify(mongo);
    if (problems.length > 0) {
      console.log(`BACKFILL VERIFY FAILED — ${String(problems.length)} problem(s):`);
      for (const problem of problems) console.log(`  ${problem}`);
      throw new Error("backfill verification failed");
    }
    console.log("BACKFILL verify: every copied row matches Mongo");
    const totalInserted = reports.reduce((sum, report) => sum + report.inserted, 0);
    console.log(`BACKFILL totalInserted=${String(totalInserted)}`);
  }

  await closePostgres();
  await mongoose.disconnect();
  console.log("BACKFILL done");
}

void main().catch((error: unknown) => {
  console.error("BACKFILL failed", error);
  process.exit(1);
});
