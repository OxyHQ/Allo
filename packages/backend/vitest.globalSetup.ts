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
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.ALLO_TEST_MONGODB_URI = replicaSet.getUri();
}

export async function teardown(): Promise<void> {
  await replicaSet?.stop();
  replicaSet = null;
}
