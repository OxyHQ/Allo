import { MongoMemoryReplSet } from "mongodb-memory-server";

/**
 * One MongoDB replica set for the whole suite.
 *
 * A replica SET rather than a standalone, because the properties this
 * integration rests on only exist there: multi-document transactions (a report
 * and its outbox row commit together, or neither does) and the unique indexes
 * that make a retry idempotent.
 *
 * This exists because a mocked model hid a 100%-reproducible bug. The outbox
 * write named `createdAt`/`updatedAt` in `$setOnInsert` while the schema
 * declared `{ timestamps: true }`; a mocked `updateOne` accepts any update
 * document, so every test passed while the real write failed for every report
 * ever submitted. A mock can be made to agree with any claim, which is exactly
 * why the claims that matter must not be tested against one.
 */
let replicaSet: MongoMemoryReplSet | null = null;

export async function setup(): Promise<void> {
  /**
   * An externally provided replica set wins, and the README has always said so —
   * it just was not true: this file overwrote `ALLO_TEST_MONGODB_URI`
   * unconditionally, so the documented escape hatch did nothing.
   *
   * It matters on machines where `mongodb-memory-server` cannot fetch a binary
   * at all. On arm64 Linux the download 403s — there is no
   * `mongodb-linux-aarch64-debian12-<version>.tgz` published — and because this
   * runs in `globalSetup`, the failure takes down the WHOLE suite, including
   * tests that never touch a database. Honouring a URI that is already set gives
   * those machines a way to run the suite against a local `mongod`.
   *
   * `MONGOMS_SYSTEM_BINARY=/usr/bin/mongod` is the other way, and it keeps the
   * in-memory replica set; this one points at a server that is already running.
   */
  const provided = process.env.ALLO_TEST_MONGODB_URI;
  if (provided && provided.trim().length > 0) return;

  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.ALLO_TEST_MONGODB_URI = replicaSet.getUri();
}

export async function teardown(): Promise<void> {
  await replicaSet?.stop();
  replicaSet = null;
}
