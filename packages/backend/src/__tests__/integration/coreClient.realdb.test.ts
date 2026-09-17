/**
 * The real SDK against the real backend.
 *
 * `createApp` with the production `requireInstance`, the production Socket.IO
 * server and a real Postgres; three `@allo/core` clients over real HTTP and
 * real sockets on an ephemeral port. The only double is Oxy: a bearer of the
 * form `test:<accountId>` names the account, on HTTP and on the handshake.
 *
 * What this proves that the unit suites cannot: the SDK's request signing,
 * its MLS commits, welcomes, epoch handling and media encryption all round-trip
 * through THIS server's rules — and the server never holds a byte of
 * plaintext, asserted by searching every stored payload and blob.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createAlloClient, testing, type AlloClient, type MediaRef, type OxySessionAdapter, type TimelineItemView } from "@allo/core";
import type { Platform } from "@allo/shared-types";
import { createApp } from "../../app";
import { checkPostgresHealth, closePostgres, connectPostgres, getDb, type AlloDatabase } from "../../db";
import * as schema from "../../db/schema";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import { requireInstance } from "../../middleware/instanceAuth";
import { requireOxySession } from "../../middleware/oxySession";
import { clearRealtime, setRealtime } from "../../runtime/realtime";
import { createSocketServer, type SocketRuntime } from "../../runtime/socket";
import { logger } from "../../utils/logger";

const { MemorySecrets, MemoryStorage } = testing;

const TOKEN_PREFIX = "test:";

/** Oxy's HTTP half: `Authorization: Bearer test:<accountId>` → `req.userId`. */
const bearerAuth: RequestHandler = (req, _res, next) => {
  const header = req.get("authorization") ?? "";
  if (header.startsWith(`Bearer ${TOKEN_PREFIX}`)) {
    const accountId = header.slice(`Bearer ${TOKEN_PREFIX}`.length);
    Reflect.set(req, "userId", accountId);
    Reflect.set(req, "user", { id: accountId });
  }
  next();
};

/** Oxy's socket half: the same bearer in `handshake.auth.token`. */
const socketOxy = {
  authSocket: () => async (socket: unknown, next: (err?: Error) => void) => {
    const s = socket as { handshake: { auth: Record<string, unknown> }; data: Record<string, unknown> };
    const token = s.handshake.auth.token;
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return next(new Error("Authentication required"));
    s.data.userId = token.slice(TOKEN_PREFIX.length);
    next();
  },
};

function sessionFor(accountId: string): OxySessionAdapter {
  return {
    getAccessToken: async () => `${TOKEN_PREFIX}${accountId}`,
    getAccountId: () => accountId,
    subscribe: () => () => undefined,
  };
}

let handle: TestDatabaseHandle;
let db: AlloDatabase;
let server: http.Server;
let sockets: SocketRuntime;
let baseUrl: string;

beforeAll(async () => {
  handle = await setUpTestDatabase();
  db = connectPostgres(handle.databaseUrl);
  const pass: RequestHandler = (_req, _res, next) => next();
  const app = createApp({
    auth: bearerAuth,
    v1Auth: [bearerAuth, requireOxySession],
    instanceAuth: requireInstance({ getDb }),
    rateLimit: pass,
    cors: pass,
    webhooks: express.Router(),
    api: { profile: express.Router(), reports: express.Router(), directory: express.Router() },
    checkPostgres: checkPostgresHealth,
    blobMaxBytes: 1024 * 1024,
  });
  server = http.createServer(app);
  sockets = createSocketServer(server, { oxy: socketOxy, instanceAuth: { getDb } });
  setRealtime(sockets.realtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  clearRealtime(sockets.realtime);
  await new Promise<void>((resolve) => sockets.io.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
  await handle?.drop();
});

interface TestClient {
  client: AlloClient;
  accountId: string;
  name: string;
}

let sequence = 0;
async function makeClient(accountId: string, name: string, platform: Platform, start = true): Promise<TestClient> {
  sequence += 1;
  const client = createAlloClient({
    baseUrl,
    appId: "allo",
    platform,
    displayName: `${name} #${sequence}`,
    session: sessionFor(accountId),
    storage: new MemoryStorage(),
    secrets: new MemorySecrets(),
    syncIntervalMs: 60_000,
    keyPackageTarget: 6,
    logger: process.env.ALLO_DEBUG
      ? {
          debug: (m, meta) => console.log(`[${name}] ${m}`, meta ?? ""),
          info: (m, meta) => console.log(`[${name}] ${m}`, meta ?? ""),
          warn: (m, meta) => console.log(`[${name}] WARN ${m}`, meta ?? ""),
          error: (m, meta) => console.log(`[${name}] ERROR ${m}`, meta ?? ""),
        }
      : undefined,
  });
  if (start) await client.start();
  return { client, accountId, name };
}

async function stopAll(...clients: TestClient[]): Promise<void> {
  for (const c of clients) await c.client.stop();
}

const texts = (items: TimelineItemView[]): string[] =>
  items.filter((i) => i.content.kind === "text").map((i) => (i.content as { body: string }).body);

/** Poll a sync or async predicate; throws with the name of what never came true. */
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms: ${fn.toString().slice(0, 160)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForText(c: TestClient, conversationId: string, text: string): Promise<TimelineItemView> {
  await waitFor(() => texts(c.client.messages.timeline(conversationId)).includes(text));
  return c.client.messages.timeline(conversationId).find((i) => i.content.kind === "text" && i.content.body === text)!;
}

const waitJoined = (c: TestClient, conversationId: string) =>
  waitFor(() => c.client.conversations.get(conversationId)?.joined === true, 20_000);

async function keyPackagesOf(instanceId: string): Promise<number> {
  const rows = await db.select().from(schema.keyPackages).where(eq(schema.keyPackages.instanceId, instanceId));
  return rows.length;
}

/** Every stored payload, decoded, so a plaintext search covers the whole log. */
async function allPayloads(): Promise<Buffer[]> {
  const rows = await db.select({ payload: schema.conversationEvents.payload }).from(schema.conversationEvents);
  return rows.map((row) => Buffer.from(row.payload));
}

const sent: string[] = [];
function unique(text: string): string {
  const t = `${text} [${Date.now().toString(36)}-${sequence}]`;
  sent.push(t);
  return t;
}

let uniqueAccount = 0;
const account = (name: string) => `acc-${name}-${String(++uniqueAccount).padStart(4, "0")}`;

describe("@allo/core against the real backend", () => {
  it("DM: Alice(web) and Bob(ios) exchange text both ways over real HTTP and sockets", async () => {
    const aliceId = account("alice");
    const bobId = account("bob");
    const alice = await makeClient(aliceId, "Alice", "web");
    const bob = await makeClient(bobId, "Bob", "ios");
    expect(alice.client.instance.state()).toBe("active");
    expect(bob.client.instance.state()).toBe("active");
    await waitFor(() => alice.client.sync.state() === "live" && bob.client.sync.state() === "live");

    const conv = await alice.client.conversations.createDirect(bobId);
    expect(conv.kind).toBe("dm");
    await waitJoined(bob, conv.id);

    const hiBob = unique("hi bob");
    await alice.client.messages.send(conv.id, hiBob);
    const onBob = await waitForText(bob, conv.id, hiBob);
    expect(onBob.senderAccountId).toBe(aliceId);
    expect(onBob.isOwn).toBe(false);

    const hiAlice = unique("hi alice");
    await bob.client.messages.send(conv.id, hiAlice, { replyTo: onBob.id });
    const reply = await waitForText(alice, conv.id, hiAlice);
    expect(reply.replyTo).toBe(onBob.id);

    // The server's view: two leaves, both active, one DM row.
    const [row] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id));
    expect(row.kind).toBe("dm");
    const leaves = await db.select().from(schema.conversationLeaves).where(eq(schema.conversationLeaves.conversationId, conv.id));
    expect(leaves.map((l) => l.state)).toEqual(["active", "active"]);

    await stopAll(alice, bob);
  }, 60_000);

  it("second device: Bob(desktop) pending → approved by Bob(ios) → added → decrypts Alice's next message, and its own reaches everyone", async () => {
    const aliceId = account("alice");
    const bobId = account("bob");
    const alice = await makeClient(aliceId, "Alice", "web");
    const bobIos = await makeClient(bobId, "Bob iOS", "ios");
    const conv = await alice.client.conversations.createDirect(bobId);
    await waitJoined(bobIos, conv.id);
    const before = unique("before desktop");
    await alice.client.messages.send(conv.id, before);
    await waitForText(bobIos, conv.id, before);

    const bobDesktop = await makeClient(bobId, "Bob desktop", "desktop");
    expect(bobDesktop.client.instance.state()).toBe("pending-approval");
    await bobIos.client.instance.refreshPending();
    const pending = bobIos.client.instance.pending();
    expect(pending.map((p) => p.instance.id)).toEqual([bobDesktop.client.instanceId]);
    await expect(bobIos.client.instance.approve(pending[0].instance.id, "not-the-challenge")).rejects.toThrow(/challenge/);
    await bobIos.client.instance.approve(pending[0].instance.id, pending[0].challenge);

    // The approval reaches the desktop over its socket (`instance.approved`); the
    // challenge stays on the row and is now published on the public projection.
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    const [desktopRow] = await db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, bobDesktop.client.instanceId!));
    expect(desktopRow.status).toBe("active");
    expect(desktopRow.enrollmentChallenge).toBe(pending[0].challenge);
    expect(desktopRow.approvedByInstanceId).toBe(bobIos.client.instanceId);

    await waitFor(async () => (await keyPackagesOf(bobDesktop.client.instanceId!)) > 0);
    await bobIos.client.sync.now();
    await waitJoined(bobDesktop, conv.id);
    // History before the join is not readable: the desktop never sees `before`.
    expect(texts(bobDesktop.client.messages.timeline(conv.id))).not.toContain(before);

    const after = unique("after desktop");
    await alice.client.messages.send(conv.id, after);
    await waitForText(bobIos, conv.id, after);
    await waitForText(bobDesktop, conv.id, after);

    const fromDesktop = unique("from desktop");
    await bobDesktop.client.messages.send(conv.id, fromDesktop);
    await waitForText(bobIos, conv.id, fromDesktop);
    await waitForText(alice, conv.id, fromDesktop);
    expect(bobIos.client.messages.timeline(conv.id).find((i) => i.content.kind === "text" && i.content.body === fromDesktop)?.isOwn).toBe(true);
    await waitFor(() => alice.client.conversations.get(conv.id)?.epoch === bobDesktop.client.conversations.get(conv.id)?.epoch);

    const leaves = await db.select().from(schema.conversationLeaves).where(eq(schema.conversationLeaves.conversationId, conv.id));
    expect(leaves.filter((l) => l.state === "active")).toHaveLength(3);

    await stopAll(alice, bobIos, bobDesktop);
  }, 90_000);

  it("revocation: Bob(desktop) revokes Bob(ios); the remaining leaf removes it and its later sync cannot read what follows", async () => {
    const aliceId = account("alice");
    const bobId = account("bob");
    const alice = await makeClient(aliceId, "Alice", "web");
    const bobIos = await makeClient(bobId, "Bob iOS", "ios");
    const conv = await alice.client.conversations.createDirect(bobId);
    await waitJoined(bobIos, conv.id);
    const bobDesktop = await makeClient(bobId, "Bob desktop", "desktop");
    await bobIos.client.instance.refreshPending();
    await bobIos.client.instance.approve(bobDesktop.client.instanceId!);
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    await waitFor(async () => (await keyPackagesOf(bobDesktop.client.instanceId!)) > 0);
    await bobIos.client.sync.now();
    await waitJoined(bobDesktop, conv.id);
    await waitFor(() => alice.client.conversations.get(conv.id)!.epoch === bobDesktop.client.conversations.get(conv.id)!.epoch);
    const epochBefore = alice.client.conversations.get(conv.id)!.epoch;

    await bobDesktop.client.instance.revoke(bobIos.client.instanceId!);
    await waitFor(() => bobIos.client.instance.state() === "revoked");
    // Server side: revoked, sockets cut, leaf marked removed pending a commit,
    // then the desktop's Remove commit sets the epoch.
    await waitFor(async () => !(await sockets.realtime.isInstanceConnected(bobIos.client.instanceId!)));
    await waitFor(() => alice.client.conversations.get(conv.id)!.epoch === epochBefore + 1, 20_000);
    const [iosLeaf] = await db
      .select()
      .from(schema.conversationLeaves)
      .where(and(eq(schema.conversationLeaves.conversationId, conv.id), eq(schema.conversationLeaves.instanceId, bobIos.client.instanceId!)));
    expect(iosLeaf.state).toBe("removed");
    expect(iosLeaf.removedEpoch).toBe(epochBefore + 1);

    const afterRevoke = unique("after revoke");
    await alice.client.messages.send(conv.id, afterRevoke);
    await waitForText(bobDesktop, conv.id, afterRevoke);

    // The revoked instance: the SDK has stopped its loops (a later `sync.now()`
    // is a no-op, not a throw), the server refuses its signature outright, and
    // nothing it holds can show the message.
    await bobIos.client.sync.now().catch(() => undefined);
    expect(texts(bobIos.client.messages.timeline(conv.id))).not.toContain(afterRevoke);
    expect(bobIos.client.instance.state()).toBe("revoked");
    const [iosRow] = await db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, bobIos.client.instanceId!));
    expect(iosRow.status).toBe("revoked");
    expect(await sockets.realtime.isInstanceConnected(bobIos.client.instanceId!)).toBe(false);
    // And the server wrote no delivery for it.
    const deliveries = await db
      .select()
      .from(schema.instanceDeliveries)
      .where(eq(schema.instanceDeliveries.instanceId, bobIos.client.instanceId!));
    const afterRevokeEvents = await db
      .select()
      .from(schema.conversationEvents)
      .where(and(eq(schema.conversationEvents.conversationId, conv.id), eq(schema.conversationEvents.kind, "app_message")));
    const last = afterRevokeEvents[afterRevokeEvents.length - 1];
    expect(deliveries.map((d) => d.eventId)).not.toContain(last.id);

    await stopAll(alice, bobIos, bobDesktop);
  }, 90_000);

  it("epoch conflict: Alice and Bob(desktop) add Carol concurrently → one 409, Carol added once, everyone agrees", async () => {
    const aliceId = account("alice");
    const bobId = account("bob");
    const carolId = account("carol");
    const alice = await makeClient(aliceId, "Alice", "web");
    const bob = await makeClient(bobId, "Bob desktop", "desktop");
    const carol = await makeClient(carolId, "Carol", "android");
    const group = await alice.client.conversations.createGroup([bobId]);
    await waitJoined(bob, group.id);
    await waitFor(async () => (await keyPackagesOf(carol.client.instanceId!)) >= 2);

    const infoCalls = vi.mocked(logger.info).mock.calls.length;
    await Promise.all([alice.client.conversations.addMember(group.id, carolId), bob.client.conversations.addMember(group.id, carolId)]);
    for (const c of [alice, bob]) {
      await c.client.sync.flush();
      await c.client.sync.now();
    }
    await waitJoined(carol, group.id);
    for (const c of [alice, bob, carol]) {
      await c.client.sync.flush();
      await c.client.sync.now();
    }

    // The 409 is visible in the request log (route template + status only).
    const conflicts = vi
      .mocked(logger.info)
      .mock.calls.slice(infoCalls)
      .filter(([message, meta]) => message === "HTTP request completed" && (meta as { status: number; route: string }).status === 409);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect((conflicts[0][1] as { route: string }).route).toBe("/v1/conversations/:id/events");

    const carolLeaves = await db
      .select()
      .from(schema.conversationLeaves)
      .where(and(eq(schema.conversationLeaves.conversationId, group.id), eq(schema.conversationLeaves.accountId, carolId)));
    expect(carolLeaves).toHaveLength(1);
    expect(carolLeaves[0].state).toBe("active");
    const commits = await db
      .select()
      .from(schema.conversationEvents)
      .where(and(eq(schema.conversationEvents.conversationId, group.id), eq(schema.conversationEvents.kind, "mls_commit")));
    expect(commits).toHaveLength(2);
    const epochs = [alice, bob, carol].map((c) => c.client.conversations.get(group.id)!.epoch);
    expect(new Set(epochs).size).toBe(1);
    const [row] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, group.id));
    expect(row.currentEpoch).toBe(epochs[0]);

    const three = unique("three of us");
    await alice.client.messages.send(group.id, three);
    await waitForText(bob, group.id, three);
    await waitForText(carol, group.id, three);
    await stopAll(alice, bob, carol);
  }, 90_000);

  it("media: an uploaded file's plaintext is nowhere on the server; the recipient decrypts it", async () => {
    const aliceId = account("alice");
    const bobId = account("bob");
    const alice = await makeClient(aliceId, "Alice", "web");
    const bob = await makeClient(bobId, "Bob", "ios");
    const conv = await alice.client.conversations.createDirect(bobId);
    await waitJoined(bob, conv.id);
    const bytes = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff);
    await alice.client.media.upload(conv.id, bytes, { kind: "file", filename: "data.bin", mime: "application/octet-stream", caption: unique("cap") });
    await waitFor(() => bob.client.messages.timeline(conv.id).some((i) => i.content.kind === "media"));
    const item = bob.client.messages.timeline(conv.id).find((i) => i.content.kind === "media")!;
    const media = (item.content as { media: { ref: MediaRef; size: number } }).media;
    expect(media.size).toBe(5000);
    const got = await bob.client.media.download(media.ref);
    expect(Buffer.compare(Buffer.from(got), Buffer.from(bytes))).toBe(0);

    // The blob row holds ciphertext, is retained (referenced by the event), and
    // no blob anywhere contains a window of the plaintext.
    const [blob] = await db.select().from(schema.blobs).where(eq(schema.blobs.id, media.ref.blobId));
    expect(blob.expiresAt).toBeNull();
    expect(blob.size).toBeGreaterThanOrEqual(5000);
    const stored = await db.select().from(schema.blobBytes);
    expect(stored.length).toBeGreaterThanOrEqual(1);
    const window = Buffer.from(bytes.subarray(0, 64));
    for (const row of stored) expect(Buffer.from(row.data).includes(window)).toBe(false);
    for (const payload of await allPayloads()) expect(payload.includes(window)).toBe(false);
    await stopAll(alice, bob);
  }, 60_000);

  it("no payload on the server contains the plaintext of any message sent above", async () => {
    expect(sent.length).toBeGreaterThanOrEqual(8);
    const payloads = await allPayloads();
    expect(payloads.length).toBeGreaterThanOrEqual(sent.length);
    for (const text of sent) {
      const needle = Buffer.from(text, "utf8");
      for (const payload of payloads) expect(payload.includes(needle), `payload contains "${text}"`).toBe(false);
    }
    // Control: the search would find a payload that DID carry plaintext.
    const [probe] = sent;
    expect(Buffer.concat([Buffer.from("x"), Buffer.from(probe, "utf8")]).includes(Buffer.from(probe, "utf8"))).toBe(true);
  });
});
