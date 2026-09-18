/**
 * The platform suites' shared fixture: a throwaway migrated database, the
 * REAL `createApp` assembly with a fake Oxy auth, a recording `Realtime`, and
 * instances that hold real Ed25519 keys and sign real requests.
 *
 * Nothing about the signature path is mocked. `requireInstance` runs against
 * the database, `signedRequestMessage` comes from `@allo/shared-types`, and the
 * bytes hashed here are the bytes supertest sends — the request body is
 * serialised ONCE, by the helper, and handed to supertest as a string.
 */

import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import express, { type RequestHandler } from "express";
import request, { type Test } from "supertest";
import type { ZodType } from "zod";
import {
  BLOB_SHA256_HEADER,
  INSTANCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  enrollmentApprovalMessage,
  registerInstanceResponseSchema,
  signedRequestMessage,
  type Platform,
  type RegisterInstanceResponse,
  type SyncNudgeEvent,
} from "@allo/shared-types";
import { createApp, type CreateAppDependencies } from "../../app";
import { checkPostgresHealth, closePostgres, connectPostgres, getDb, type AlloDatabase } from "../../db";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import { requireInstance, sha256Hex } from "../../middleware/instanceAuth";
import { clearRealtime, setRealtime, type Realtime } from "../../runtime/realtime";

export const USER_HEADER = "x-test-user";

/** Oxy auth stand-in: the account is whatever `x-test-user` says; none is 401. */
export const fakeOxyAuth: RequestHandler = (req, res, next) => {
  const userId = req.get(USER_HEADER);
  if (!userId) {
    res.status(401).json({ error: { code: "unauthorized", message: "no session" } });
    return;
  }
  Reflect.set(req, "userId", userId);
  Reflect.set(req, "user", { id: userId });
  next();
};

const passThrough: RequestHandler = (_req, _res, next) => next();

export interface RecordedRealtime extends Realtime {
  nudges: { instanceIds: string[]; event: SyncNudgeEvent }[];
  approved: string[];
  revoked: { accountId: string; instanceId: string }[];
  low: { instanceId: string; available: number }[];
  historyOffers: { instanceId: string; offerId: string }[];
  typings: { instanceIds: string[]; conversationId: string }[];
  disconnected: string[];
  /** Instances `isInstanceConnected` answers true for. */
  connected: Set<string>;
  reset(): void;
}

export function recordedRealtime(): RecordedRealtime {
  const r: RecordedRealtime = {
    nudges: [],
    approved: [],
    revoked: [],
    low: [],
    historyOffers: [],
    typings: [],
    disconnected: [],
    connected: new Set(),
    nudge(instanceIds, event) {
      r.nudges.push({ instanceIds: [...instanceIds], event });
    },
    instanceApproved(instanceId) {
      r.approved.push(instanceId);
    },
    instanceRevoked(accountId, event) {
      r.revoked.push({ accountId, instanceId: event.instanceId });
    },
    keyPackagesLow(instanceId, event) {
      r.low.push({ instanceId, available: event.available });
    },
    historyOffer(instanceId, event) {
      r.historyOffers.push({ instanceId, offerId: event.offerId });
    },
    typing(instanceIds, event) {
      r.typings.push({ instanceIds: [...instanceIds], conversationId: event.conversationId });
    },
    presence() {},
    async isInstanceConnected(instanceId) {
      return r.connected.has(instanceId);
    },
    async disconnectInstance(instanceId) {
      r.disconnected.push(instanceId);
    },
    reset() {
      r.nudges = [];
      r.approved = [];
      r.revoked = [];
      r.low = [];
      r.historyOffers = [];
      r.typings = [];
      r.disconnected = [];
      r.connected.clear();
    },
  };
  return r;
}

export interface PlatformHarness {
  app: express.Express;
  db: AlloDatabase;
  realtime: RecordedRealtime;
  handle: TestDatabaseHandle;
  drop(): Promise<void>;
}

export const TEST_BLOB_MAX_BYTES = 64 * 1024;

export async function createPlatformHarness(overrides: Partial<CreateAppDependencies> = {}): Promise<PlatformHarness> {
  const handle = await setUpTestDatabase();
  const db = connectPostgres(handle.databaseUrl);
  const realtime = recordedRealtime();
  setRealtime(realtime);
  const app = createApp({
    auth: fakeOxyAuth,
    instanceAuth: requireInstance({ getDb }),
    rateLimit: passThrough,
    cors: passThrough,
    webhooks: express.Router(),
    api: { profile: express.Router(), reports: express.Router(), directory: express.Router() },
    checkPostgres: checkPostgresHealth,
    blobMaxBytes: TEST_BLOB_MAX_BYTES,
    ...overrides,
  });
  return {
    app,
    db,
    realtime,
    handle,
    async drop() {
      clearRealtime(realtime);
      await closePostgres();
      await handle.drop();
    },
  };
}

// --- instances with real keys --------------------------------------------------

export interface Ed25519Key {
  privateKey: KeyObject;
  /** Raw 32 bytes, base64: the wire form. */
  publicKeyBase64: string;
}

export function generateEd25519(): Ed25519Key {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { privateKey, publicKeyBase64: Buffer.from(raw).toString("base64") };
}

export function signMessage(key: Ed25519Key, message: string): string {
  return sign(null, Buffer.from(message, "utf8"), key.privateKey).toString("base64");
}

export interface X25519Key {
  privateKey: KeyObject;
  /** Raw 32 bytes, base64: the wire form of `transferPublicKey`. */
  publicKeyBase64: string;
}

/** A real X25519 pair: the transfer key an instance registers. The SPKI prefix is 12 bytes, as for Ed25519. */
export function generateX25519(): X25519Key {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { privateKey, publicKeyBase64: Buffer.from(raw).toString("base64") };
}

type Method = "get" | "post" | "put" | "delete";

export class TestInstance {
  constructor(
    readonly app: express.Express,
    readonly accountId: string,
    readonly key: Ed25519Key,
    readonly transferKey: X25519Key,
    public id: string,
    public registration: RegisterInstanceResponse,
  ) {}

  /** `POST /v1/instances` with fresh keys; the response is parsed with the contract schema. */
  static async register(
    app: express.Express,
    accountId: string,
    options: { platform?: Platform; displayName?: string; appId?: string; key?: Ed25519Key; transferKey?: X25519Key } = {},
  ): Promise<TestInstance> {
    const key = options.key ?? generateEd25519();
    const transferKey = options.transferKey ?? generateX25519();
    const response = await request(app)
      .post("/v1/instances")
      .set(USER_HEADER, accountId)
      .send({
        appId: options.appId ?? "allo",
        platform: options.platform ?? "web",
        displayName: options.displayName ?? "test device",
        signingPublicKey: key.publicKeyBase64,
        transferPublicKey: transferKey.publicKeyBase64,
      });
    if (response.status !== 201) {
      throw new Error(`register failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    const parsed = registerInstanceResponseSchema.parse(response.body);
    return new TestInstance(app, accountId, key, transferKey, parsed.instance.id, parsed);
  }

  /** The three headers for `method path` with `body` (already serialised). */
  headers(method: string, pathWithQuery: string, body: Buffer | string = "", timestampMs = Date.now()): Record<string, string> {
    const message = signedRequestMessage({
      method,
      pathWithQuery,
      timestampMs,
      bodySha256Hex: sha256Hex(body),
    });
    return {
      [USER_HEADER]: this.accountId,
      [INSTANCE_HEADER]: this.id,
      [TIMESTAMP_HEADER]: String(timestampMs),
      [SIGNATURE_HEADER]: signMessage(this.key, message),
    };
  }

  /** A signed JSON request. `body` is serialised here so the hash covers exactly the bytes sent. */
  signed(method: Method, pathWithQuery: string, body?: unknown, options: { timestampMs?: number; headers?: Record<string, string> } = {}): Test {
    const raw = body === undefined ? "" : JSON.stringify(body);
    let test = request(this.app)[method](pathWithQuery).set(this.headers(method.toUpperCase(), pathWithQuery, raw, options.timestampMs));
    if (options.headers) test = test.set(options.headers);
    if (body !== undefined) test = test.set("content-type", "application/json").send(raw);
    return test;
  }

  /** A signed blob upload. */
  uploadBlob(bytes: Buffer, declaredSha256 = sha256Hex(bytes)): Test {
    return request(this.app)
      .post("/v1/blobs")
      .set(this.headers("POST", "/v1/blobs", bytes))
      .set(BLOB_SHA256_HEADER, declaredSha256)
      .set("content-type", "application/octet-stream")
      .send(bytes);
  }

  approvalSignatureFor(target: TestInstance): string {
    const challenge = target.registration.challenge;
    if (!challenge) throw new Error("target has no challenge");
    return signMessage(
      this.key,
      enrollmentApprovalMessage({
        accountId: this.accountId,
        newInstanceId: target.id,
        newSigningPublicKey: target.key.publicKeyBase64,
        challenge,
      }),
    );
  }

  /** Approve `target` from this (active) instance. */
  async approve(target: TestInstance): Promise<void> {
    const response = await this.signed("post", `/v1/instances/${target.id}/approve`, {
      approvalSignature: this.approvalSignatureFor(target),
    });
    if (response.status !== 200) throw new Error(`approve failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  /** Upload `count` throwaway key packages. */
  async stockKeyPackages(count: number): Promise<void> {
    const response = await this.signed("put", "/v1/key-packages", {
      keyPackages: Array.from({ length: count }, () => keyPackageUpload()),
    });
    if (response.status !== 200) throw new Error(`upload failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
}

let refCounter = 0;
export function keyPackageUpload() {
  refCounter += 1;
  return {
    ciphersuite: 1,
    ref: Buffer.from(`ref-${process.pid}-${Date.now()}-${refCounter}`).toString("base64"),
    data: Buffer.from(`kp-${refCounter}`).toString("base64"),
  };
}

export function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

let groupCounter = 0;
export function mlsGroupId(): string {
  groupCounter += 1;
  return Buffer.from(`group-${process.pid}-${Date.now()}-${groupCounter}`).toString("base64");
}

let accountCounter = 0;
export function accountId(prefix = "acct"): string {
  accountCounter += 1;
  // `idSchema` wants 8..64 chars of its alphabet; a short prefix is padded past that.
  return `${prefix}-${String(process.pid % 10_000).padStart(4, "0")}-${String(accountCounter).padStart(4, "0")}`;
}

/** Parse `body` with `schema`, failing with the issues rather than a generic mismatch. */
export function expectParses<S extends ZodType>(schema: S, body: unknown): ReturnType<S["parse"]> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(
      `response does not satisfy its schema:\n${result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}\n${JSON.stringify(body).slice(0, 500)}`,
    );
  }
  return result.data as ReturnType<S["parse"]>;
}

/** Two accounts, one active instance each with key packages, and a DM created by `a` adding `b`. */
export async function dmBetween(app: express.Express, options: { stock?: number } = {}) {
  const a = await TestInstance.register(app, accountId("a"));
  const b = await TestInstance.register(app, accountId("b"));
  await b.stockKeyPackages(options.stock ?? 3);
  const created = await a.signed("post", "/v1/conversations", {
    kind: "dm",
    mlsGroupId: mlsGroupId(),
    memberAccountIds: [b.accountId],
    idempotencyKey: `create-${Date.now()}-${Math.random()}`,
    initialCommit: {
      idempotencyKey: `commit0-${Date.now()}-${Math.random()}`,
      kind: "mls_commit",
      epoch: 0,
      payload: base64("commit-0"),
      commit: {
        newEpoch: 1,
        addedLeaves: [{ instanceId: b.id, accountId: b.accountId }],
        removedLeaves: [],
        welcome: { payload: base64("welcome-0"), recipients: [b.id] },
      },
    },
  });
  if (created.status !== 201) throw new Error(`dm create failed: ${created.status} ${JSON.stringify(created.body)}`);
  return { a, b, conversationId: created.body.conversation.id as string, created };
}
