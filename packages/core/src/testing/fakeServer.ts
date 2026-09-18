/**
 * An in-memory implementation of the v1 contract, for tests: the same rules
 * the backend enforces (bootstrap enrollment, approval signatures, key
 * package claims, dm_key idempotency, per-conversation seq, epoch CAS,
 * fan-out to leaves except the sender, welcome to recipients only,
 * per-instance delivery stream with cursors, blobs, socket nudges, history
 * offers between same-account instances, one backup per account). Every
 * request body is validated with the shared-types zod schemas, so a drift
 * between SDK and contract fails a test here.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  BLOB_SHA256_HEADER,
  DEFAULT_MAX_BLOB_BYTES,
  EMPTY_BODY_SHA256_HEX,
  INITIAL_CURSOR,
  INSTANCE_HEADER,
  MAX_CLOCK_SKEW_MS,
  SERVER_SENDER_ID,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  ackSyncRequestSchema,
  approveInstanceRequestSchema,
  archiveManifestMessage,
  createHistoryOfferRequestSchema,
  HISTORY_OFFER_TTL_MS,
  putBackupRequestSchema,
  setTransferKeyRequestSchema,
  base64UrlEncode,
  claimKeyPackagesRequestSchema,
  createConversationRequestSchema,
  decodeCursor,
  dmKeyFor,
  encodeCursor,
  enrollmentApprovalMessage,
  listEventsQuerySchema,
  registerInstanceRequestSchema,
  setPushTokenRequestSchema,
  signedRequestMessage,
  socketAuthSchema,
  submitEventRequestSchema,
  syncQuerySchema,
  uploadKeyPackagesRequestSchema,
  type AccountBackup,
  type ClientInstance,
  type ControlEvent,
  type HistoryOffer,
  type ConversationEvent,
  type ConversationSummary,
  type PublicInstance,
  type SubmitEventRequest,
} from "@allo/shared-types";
import type { z } from "zod";
import type { SocketAuthPayload, SocketFactory } from "../types";
import { base64Decode, base64Encode, hexEncode, randomBytes, sha256Hex, utf8Decode, utf8Encode } from "../util/bytes";
import { uuidV7 } from "../util/ids";
import { FakeSession } from "./memoryAdapters";
import { FakeSocket, type SocketHost } from "./fakeSocket";

export interface FakeInstance extends ClientInstance {
  /** The challenge while PENDING; moves to `enrollmentChallenge` once approved. */
  challenge: string | null;
  pushToken: string | null;
  pushProvider: "fcm" | "apns" | null;
}

export interface FakeConversation {
  id: string;
  kind: "dm" | "group";
  appId: string;
  dmKey: string | null;
  mlsGroupId: string;
  epoch: number;
  lastSeq: number;
  members: Map<string, { role: "owner" | "admin" | "member"; state: "joined" | "left" | "removed"; joinedAt: string }>;
  leaves: Map<string, { accountId: string; state: "pending_welcome" | "active" | "removed"; addedEpoch: number }>;
  createdByAccountId: string;
  createdByInstanceId: string;
  createdAt: string;
  events: ConversationEvent[];
}

export interface FakeBlob {
  bytes: Uint8Array;
  sha256: string;
  uploaderInstanceId: string;
  accountId: string;
  /** `null` while an offer or a backup references the blob; otherwise when the collector may reap it. */
  expiresAt: string | null;
}

interface Delivery {
  id: number;
  instanceId: string;
  conversationId: string;
  event: ConversationEvent;
  acked: boolean;
}

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  instanceId: string | null;
}

export interface FaultRule {
  match: (method: string, path: string) => boolean;
  times: number;
  status: number;
  code: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class FakeAlloServer implements SocketHost {
  readonly baseUrl = "http://allo.test";
  readonly instances = new Map<string, FakeInstance>();
  readonly keyPackages = new Map<string, Array<{ ciphersuite: number; ref: string; data: string }>>();
  readonly conversations = new Map<string, FakeConversation>();
  readonly blobs = new Map<string, FakeBlob>();
  readonly historyOffers = new Map<string, HistoryOffer>();
  readonly backups = new Map<string, AccountBackup>();
  readonly deliveries: Delivery[] = [];
  readonly requestLog: RequestLogEntry[] = [];
  readonly faults: FaultRule[] = [];
  readonly offline = new Set<string>();
  private readonly sockets = new Map<string, Set<FakeSocket>>();
  private readonly idempotency = new Map<string, { bodySha: string; status: number; body: unknown }>();
  private deliverySeq = 0;
  now: () => number = () => Date.now();
  readonly fetch: typeof fetch;
  readonly socketFactory: SocketFactory;

  constructor() {
    this.fetch = ((input: string | URL | Request, init?: RequestInit) => this.handle(input, init)) as typeof fetch;
    this.socketFactory = (_url, auth) => new FakeSocket(this, auth);
  }

  // ---- test controls -------------------------------------------------------

  sessionFor(accountId: string): FakeSession {
    return FakeSession.for(accountId);
  }

  setOffline(instanceId: string, offline: boolean): void {
    if (offline) {
      this.offline.add(instanceId);
      for (const s of this.sockets.get(instanceId) ?? []) s.dropFromServer();
    } else this.offline.delete(instanceId);
  }

  /** Injects an instance record verbatim (for forged-chain tests). */
  injectInstance(instance: Partial<FakeInstance> & Pick<FakeInstance, "accountId" | "signingPublicKey">): FakeInstance {
    const now = this.iso();
    const record: FakeInstance = {
      id: instance.id ?? uuidV7(this.now()),
      accountId: instance.accountId,
      appId: instance.appId ?? "allo",
      platform: instance.platform ?? "web",
      displayName: instance.displayName ?? "injected",
      signingPublicKey: instance.signingPublicKey,
      transferPublicKey: instance.transferPublicKey ?? null,
      status: instance.status ?? "active",
      enrolledAt: instance.enrolledAt ?? now,
      revokedAt: instance.revokedAt ?? null,
      lastSeenAt: null,
      approvedByInstanceId: instance.approvedByInstanceId ?? null,
      approvalSignature: instance.approvalSignature ?? null,
      createdAt: instance.createdAt ?? now,
      enrollmentChallenge: instance.enrollmentChallenge ?? null,
      challenge: instance.challenge ?? null,
      pushToken: null,
      pushProvider: null,
    };
    this.instances.set(record.id, record);
    return record;
  }

  eventsOf(conversationId: string): ConversationEvent[] {
    return this.conversations.get(conversationId)?.events ?? [];
  }

  instancesOf(accountId: string): FakeInstance[] {
    return [...this.instances.values()].filter((i) => i.accountId === accountId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  connectedInstances(): string[] {
    return [...this.sockets.entries()].filter(([, s]) => s.size > 0).map(([id]) => id);
  }

  // ---- sockets -------------------------------------------------------------

  acceptSocket(auth: SocketAuthPayload): { instanceId: string; accountId: string } | { error: string } {
    const accountId = FakeSession.accountFromToken(auth.token ?? "");
    if (!accountId) return { error: "unauthorized" };
    const parsed = socketAuthSchema.safeParse({ instanceId: auth.instanceId, timestamp: auth.timestamp, signature: auth.signature });
    if (!parsed.success) return { error: "validation_failed" };
    const inst = this.instances.get(parsed.data.instanceId);
    if (!inst || inst.accountId !== accountId) return { error: "unauthorized" };
    if (inst.status !== "active") return { error: `instance_${inst.status}` };
    if (this.offline.has(inst.id)) return { error: "network" };
    const message = signedRequestMessage({ method: "GET", pathWithQuery: "/socket", timestampMs: parsed.data.timestamp, bodySha256Hex: EMPTY_BODY_SHA256_HEX });
    if (!ed25519.verify(base64Decode(parsed.data.signature), utf8Encode(message), base64Decode(inst.signingPublicKey))) return { error: "unauthorized" };
    return { instanceId: inst.id, accountId };
  }

  attach(socket: FakeSocket, instanceId: string): void {
    let set = this.sockets.get(instanceId);
    if (!set) {
      set = new Set();
      this.sockets.set(instanceId, set);
    }
    set.add(socket);
  }

  detach(socket: FakeSocket): void {
    if (socket.instanceId) this.sockets.get(socket.instanceId)?.delete(socket);
  }

  onClientEvent(socket: FakeSocket, event: string, payload: unknown): void {
    if (event !== "typing" || !socket.instanceId) return;
    const p = payload as { conversationId?: string; ciphertext?: string };
    const conv = p.conversationId ? this.conversations.get(p.conversationId) : undefined;
    if (!conv || typeof p.ciphertext !== "string") return;
    if (conv.leaves.get(socket.instanceId)?.state !== "active") return;
    for (const [instanceId, leaf] of conv.leaves) {
      if (leaf.state === "active" && instanceId !== socket.instanceId) this.emitTo(instanceId, "typing", { conversationId: conv.id, ciphertext: p.ciphertext });
    }
  }

  emitTo(instanceId: string, event: string, payload: unknown): void {
    for (const s of this.sockets.get(instanceId) ?? []) s.receive(event, payload);
  }

  emitToAccount(accountId: string, event: string, payload: unknown): void {
    for (const i of this.instancesOf(accountId)) this.emitTo(i.id, event, payload);
  }

  // ---- http ----------------------------------------------------------------

  private async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    const body = await bodyBytes(init?.body);
    const pathWithQuery = url.pathname + url.search;
    const instanceHeader = headers.get(INSTANCE_HEADER);
    if (instanceHeader && this.offline.has(instanceHeader)) throw new TypeError("fetch failed (fake network offline)");
    const fault = this.faults.find((f) => f.times > 0 && f.match(method, url.pathname));
    if (fault) {
      fault.times--;
      this.requestLog.push({ method, path: url.pathname, status: fault.status, instanceId: instanceHeader });
      return json(fault.status, { error: { code: fault.code, message: "injected fault" } });
    }
    try {
      const result = await this.route(method, url, pathWithQuery, headers, body);
      this.requestLog.push({ method, path: url.pathname, status: result.status, instanceId: instanceHeader });
      return result;
    } catch (error) {
      if (error instanceof HttpError) {
        this.requestLog.push({ method, path: url.pathname, status: error.status, instanceId: instanceHeader });
        return json(error.status, { error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } });
      }
      this.requestLog.push({ method, path: url.pathname, status: 500, instanceId: instanceHeader });
      return json(500, { error: { code: "internal", message: String(error) } });
    }
  }

  private oxyAccount(headers: Headers): string {
    const auth = headers.get("authorization") ?? "";
    const accountId = auth.startsWith("Bearer ") ? FakeSession.accountFromToken(auth.slice(7)) : null;
    if (!accountId) throw new HttpError(401, "unauthorized", "no session");
    return accountId;
  }

  private signedInstance(method: string, pathWithQuery: string, headers: Headers, body: Uint8Array, accountId: string): FakeInstance {
    const instanceId = headers.get(INSTANCE_HEADER);
    const ts = headers.get(TIMESTAMP_HEADER);
    const sig = headers.get(SIGNATURE_HEADER);
    if (!instanceId || !ts || !sig) throw new HttpError(401, "unauthorized", "instance headers missing");
    const timestampMs = Number(ts);
    if (!Number.isInteger(timestampMs) || Math.abs(timestampMs - this.now()) > MAX_CLOCK_SKEW_MS) throw new HttpError(401, "unauthorized", "timestamp skew");
    const inst = this.instances.get(instanceId);
    if (!inst) throw new HttpError(401, "unauthorized", "unknown instance");
    if (inst.status === "pending") throw new HttpError(403, "instance_not_active", "instance pending");
    if (inst.status === "revoked") throw new HttpError(403, "instance_revoked", "instance revoked");
    if (inst.accountId !== accountId) throw new HttpError(403, "forbidden", "instance of another account");
    const message = signedRequestMessage({ method, pathWithQuery, timestampMs, bodySha256Hex: sha256Hex(body) });
    if (!ed25519.verify(base64Decode(sig), utf8Encode(message), base64Decode(inst.signingPublicKey))) throw new HttpError(401, "unauthorized", "bad signature");
    inst.lastSeenAt = this.iso();
    return inst;
  }

  private parse<T>(schema: z.ZodType<T>, body: Uint8Array): T {
    let raw: unknown;
    try {
      raw = JSON.parse(utf8Decode(body));
    } catch {
      throw new HttpError(400, "validation_failed", "body is not JSON");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "validation_failed", "body did not match its schema", parsed.error.issues);
    return parsed.data;
  }

  private async route(method: string, url: URL, pathWithQuery: string, headers: Headers, body: Uint8Array): Promise<Response> {
    const path = url.pathname;
    const accountId = this.oxyAccount(headers);
    const signed = () => this.signedInstance(method, pathWithQuery, headers, body, accountId);
    let m: RegExpMatchArray | null;

    if (method === "POST" && path === "/v1/instances") return this.register(accountId, body);
    if (method === "GET" && path === "/v1/instances") return json(200, { instances: this.instancesOf(accountId).map(toClient) });
    if (method === "GET" && (m = path.match(/^\/v1\/accounts\/([^/]+)\/instances$/))) {
      // An account the server has never seen is 404; one with no ACTIVE instance is an empty list.
      const all = this.instancesOf(m[1]);
      if (all.length === 0) throw new HttpError(404, "not_found", "account");
      return json(200, { instances: all.filter((i) => i.status === "active").map(toPublic) });
    }
    if (method === "GET" && path === "/v1/instances/pending") {
      signed();
      const pending = this.instancesOf(accountId)
        .filter((i) => i.status === "pending")
        .map((i) => ({ instance: toClient(i), challenge: i.challenge }));
      return json(200, { pending });
    }
    if (method === "PUT" && path === "/v1/instances/me/transfer-key") {
      const me = signed();
      const req = this.parse(setTransferKeyRequestSchema, body);
      me.transferPublicKey = req.transferPublicKey;
      return json(200, { instance: toClient(me) });
    }
    if (method === "GET" && path === "/v1/instances/me/history-offers") {
      const me = signed();
      this.expireOffers();
      const offers = [...this.historyOffers.values()].filter((o) => o.recipientInstanceId === me.id && o.status === "pending");
      return json(200, { offers });
    }
    if (method === "POST" && (m = path.match(/^\/v1\/instances\/me\/history-offers\/([^/]+)\/consume$/))) {
      const me = signed();
      this.expireOffers();
      const offer = this.historyOffers.get(m[1]);
      if (!offer || offer.recipientInstanceId !== me.id) throw new HttpError(404, "not_found", "history offer");
      if (offer.status !== "pending") throw new HttpError(403, "forbidden", `offer is ${offer.status}`);
      offer.status = "consumed";
      this.releaseBlobs(offer.manifest.chunkBlobIds);
      return json(200, { offer });
    }
    if (method === "POST" && (m = path.match(/^\/v1\/instances\/([^/]+)\/history-offers$/))) {
      return this.createHistoryOffer(signed(), m[1], body);
    }
    if (path === "/v1/accounts/me/backup") {
      const me = signed();
      if (method === "GET") return json(200, { backup: this.backups.get(accountId) ?? null });
      if (method === "PUT") return this.putBackup(me, body);
      if (method === "DELETE") {
        const existing = this.backups.get(accountId);
        if (!existing) throw new HttpError(404, "backup_not_found", "no backup");
        this.backups.delete(accountId);
        this.releaseBlobs(existing.manifest.chunkBlobIds);
        return new Response(null, { status: 204 });
      }
    }
    if (method === "PUT" && path === "/v1/instances/me/push") {
      const me = signed();
      const req = this.parse(setPushTokenRequestSchema, body);
      me.pushToken = req.token;
      me.pushProvider = req.provider;
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE" && path === "/v1/instances/me/push") {
      const me = signed();
      me.pushToken = null;
      me.pushProvider = null;
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && (m = path.match(/^\/v1\/instances\/([^/]+)\/(approve|reject|revoke)$/))) {
      const me = signed();
      const target = this.instances.get(m[1]);
      if (!target || target.accountId !== accountId) throw new HttpError(404, "not_found", "instance");
      if (m[2] === "approve") return this.approve(me, target, body);
      if (m[2] === "reject") {
        if (target.status !== "pending") throw new HttpError(forbiddenOr(target), "forbidden", "not pending");
        this.instances.delete(target.id);
        return json(200, { instance: toClient({ ...target, status: "revoked", revokedAt: this.iso() }) });
      }
      return this.revoke(target);
    }
    if (method === "PUT" && path === "/v1/key-packages") {
      const me = signed();
      const req = this.parse(uploadKeyPackagesRequestSchema, body);
      const list = this.keyPackages.get(me.id) ?? [];
      const allRefs = new Set([...this.keyPackages.values()].flat().map((k) => k.ref));
      for (const kp of req.keyPackages) {
        if (allRefs.has(kp.ref)) throw new HttpError(409, "idempotency_conflict", "duplicate ref");
        list.push(kp);
      }
      this.keyPackages.set(me.id, list);
      return json(200, { available: list.length });
    }
    if (method === "POST" && path === "/v1/key-packages/claim") {
      const me = signed();
      const req = this.parse(claimKeyPackagesRequestSchema, body);
      const keyPackages: Array<{ instanceId: string; ciphersuite: number; ref: string; data: string }> = [];
      const missing: string[] = [];
      for (const id of req.instanceIds) {
        const inst = this.instances.get(id);
        const list = this.keyPackages.get(id) ?? [];
        const kp = inst?.status === "active" ? list.shift() : undefined;
        if (!kp) missing.push(id);
        else {
          keyPackages.push({ instanceId: id, ...kp });
          if (list.length < 5) this.emitTo(id, "keypackages.low", { available: list.length });
        }
      }
      void me;
      return json(200, { keyPackages, missing });
    }
    if (method === "POST" && path === "/v1/conversations") return this.createConversation(signed(), body);
    if (method === "GET" && path === "/v1/conversations") {
      const me = signed();
      const list = [...this.conversations.values()].filter((c) => c.members.has(accountId)).map((c) => this.summary(c, me.id));
      return json(200, { conversations: list });
    }
    if ((m = path.match(/^\/v1\/conversations\/([^/]+)$/)) && method === "GET") {
      const me = signed();
      const conv = this.memberConversation(m[1], accountId);
      return json(200, { conversation: this.summary(conv, me.id) });
    }
    if ((m = path.match(/^\/v1\/conversations\/([^/]+)\/leave$/)) && method === "POST") {
      const me = signed();
      const conv = this.memberConversation(m[1], accountId);
      const member = conv.members.get(accountId)!;
      member.state = "left";
      const recipients = [...conv.leaves.entries()].filter(([, l]) => l.state === "active" && l.accountId !== accountId).map(([id]) => id);
      this.appendControl(conv, { t: "member_left", accountId }, recipients);
      void me;
      return new Response(null, { status: 204 });
    }
    if ((m = path.match(/^\/v1\/conversations\/([^/]+)\/events$/)) && method === "POST") {
      const me = signed();
      const conv = this.memberConversation(m[1], accountId);
      const req = this.parse(submitEventRequestSchema, body);
      return this.withIdempotency(me.id, req.idempotencyKey, body, () => ({ status: 200, body: { event: this.submitEvent(conv, me, req) } }));
    }
    if ((m = path.match(/^\/v1\/conversations\/([^/]+)\/events$/)) && method === "GET") {
      signed();
      const conv = this.memberConversation(m[1], accountId);
      const q = listEventsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!q.success) throw new HttpError(400, "validation_failed", "query", q.error.issues);
      const events = conv.events.filter((e) => e.seq > q.data.after);
      return json(200, { events: events.slice(0, q.data.limit), hasMore: events.length > q.data.limit });
    }
    if (method === "GET" && path === "/v1/sync") {
      const me = signed();
      const q = syncQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!q.success) throw new HttpError(400, "validation_failed", "query", q.error.issues);
      let after = 0n;
      try {
        after = decodeCursor(q.data.cursor ?? INITIAL_CURSOR);
      } catch {
        throw new HttpError(400, "validation_failed", "cursor");
      }
      const mine = this.deliveries.filter((d) => d.instanceId === me.id && BigInt(d.id) > after);
      const page = mine.slice(0, q.data.limit);
      return json(200, {
        deliveries: page.map((d) => ({ cursor: encodeCursor(d.id), conversationId: d.conversationId, event: d.event })),
        nextCursor: page.length ? encodeCursor(page[page.length - 1].id) : (q.data.cursor ?? INITIAL_CURSOR),
        hasMore: mine.length > page.length,
      });
    }
    if (method === "POST" && path === "/v1/sync/ack") {
      const me = signed();
      const req = this.parse(ackSyncRequestSchema, body);
      const upTo = decodeCursor(req.cursor);
      for (const d of this.deliveries) if (d.instanceId === me.id && BigInt(d.id) <= upTo) d.acked = true;
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/v1/blobs") {
      const me = signed();
      const digest = headers.get(BLOB_SHA256_HEADER);
      if (!digest || digest !== sha256Hex(body)) throw new HttpError(400, "validation_failed", "digest");
      if (body.byteLength > DEFAULT_MAX_BLOB_BYTES) throw new HttpError(413, "payload_too_large", "blob");
      const blobId = hexEncode(randomBytes(32));
      this.blobs.set(blobId, { bytes: body, sha256: digest, uploaderInstanceId: me.id, accountId: me.accountId, expiresAt: this.isoAt(this.now() + 24 * 3600 * 1000) });
      return json(201, { blobId, size: body.byteLength });
    }
    if (method === "GET" && (m = path.match(/^\/v1\/blobs\/([^/]+)$/))) {
      signed();
      const blob = this.blobs.get(m[1]);
      if (!blob) throw new HttpError(404, "not_found", "blob");
      return new Response(blob.bytes.slice().buffer as ArrayBuffer, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    throw new HttpError(404, "not_found", `no route ${method} ${path}`);
  }

  // ---- instances -----------------------------------------------------------

  private register(accountId: string, body: Uint8Array): Response {
    const req = this.parse(registerInstanceRequestSchema, body);
    // Unique (account_id, signing_public_key): the backend answers 409 and the client adopts the listed instance.
    if (this.instancesOf(accountId).some((i) => i.signingPublicKey === req.signingPublicKey)) {
      throw new HttpError(409, "idempotency_conflict", "signing key already enrolled on this account");
    }
    const bootstrap = !this.instancesOf(accountId).some((i) => i.status === "active");
    const now = this.iso();
    const inst: FakeInstance = {
      id: uuidV7(this.now()),
      accountId,
      appId: req.appId,
      platform: req.platform,
      displayName: req.displayName,
      signingPublicKey: req.signingPublicKey,
      transferPublicKey: req.transferPublicKey,
      status: bootstrap ? "active" : "pending",
      enrolledAt: bootstrap ? now : null,
      revokedAt: null,
      lastSeenAt: null,
      approvedByInstanceId: null,
      approvalSignature: null,
      createdAt: now,
      enrollmentChallenge: null,
      challenge: bootstrap ? null : base64UrlEncode(randomBytes(32)),
      pushToken: null,
      pushProvider: null,
    };
    this.instances.set(inst.id, inst);
    return json(201, { instance: toClient(inst), enrollment: inst.status === "active" ? "active" : "pending", ...(inst.challenge ? { challenge: inst.challenge } : {}) });
  }

  private approve(approver: FakeInstance, target: FakeInstance, body: Uint8Array): Response {
    const req = this.parse(approveInstanceRequestSchema, body);
    if (target.status !== "pending" || !target.challenge) throw new HttpError(403, "forbidden", "not pending");
    const message = enrollmentApprovalMessage({ accountId: target.accountId, newInstanceId: target.id, newSigningPublicKey: target.signingPublicKey, challenge: target.challenge });
    if (!ed25519.verify(base64Decode(req.approvalSignature), utf8Encode(message), base64Decode(approver.signingPublicKey))) {
      throw new HttpError(401, "unauthorized", "approval signature does not verify");
    }
    target.status = "active";
    target.enrolledAt = this.iso();
    target.approvedByInstanceId = approver.id;
    target.approvalSignature = req.approvalSignature;
    target.enrollmentChallenge = target.challenge; // published once signed
    target.challenge = null;
    this.emitTo(target.id, "instance.approved", { instanceId: target.id });
    return json(200, { instance: toClient(target) });
  }

  private revoke(target: FakeInstance): Response {
    if (target.status === "revoked") return json(200, { instance: toClient(target) });
    target.status = "revoked";
    target.revokedAt = this.iso();
    target.challenge = null;
    this.keyPackages.delete(target.id);
    for (const conv of this.conversations.values()) {
      const leaf = conv.leaves.get(target.id);
      if (!leaf || leaf.state !== "active") continue;
      leaf.state = "removed";
      const recipients = [...conv.leaves.entries()].filter(([id, l]) => l.state === "active" && id !== target.id).map(([id]) => id);
      this.appendControl(conv, { t: "instance_revoked", instanceId: target.id, accountId: target.accountId }, recipients);
    }
    this.emitToAccount(target.accountId, "instance.revoked", { instanceId: target.id });
    for (const s of this.sockets.get(target.id) ?? []) s.dropFromServer();
    return json(200, { instance: toClient(target) });
  }

  // ---- history offers and backups -----------------------------------------

  /** Chunk blobs an offer or a backup names must exist and belong to the producer's account; they stop expiring. */
  private retainChunks(chunkBlobIds: string[], accountId: string): void {
    for (const id of chunkBlobIds) {
      const blob = this.blobs.get(id);
      if (!blob || blob.accountId !== accountId) throw new HttpError(404, "not_found", `chunk blob ${id}`);
    }
    for (const id of chunkBlobIds) this.blobs.get(id)!.expiresAt = null;
  }

  /** A chunk goes back on the collector's clock only once no pending offer and no backup names it. */
  private releaseBlobs(chunkBlobIds: string[]): void {
    const referenced = new Set<string>();
    for (const o of this.historyOffers.values()) if (o.status === "pending") for (const id of o.manifest.chunkBlobIds) referenced.add(id);
    for (const b of this.backups.values()) for (const id of b.manifest.chunkBlobIds) referenced.add(id);
    for (const id of chunkBlobIds) {
      const blob = this.blobs.get(id);
      if (blob && !referenced.has(id)) blob.expiresAt = this.isoAt(this.now() + 24 * 3600 * 1000);
    }
  }

  private expireOffers(): void {
    const now = this.iso();
    for (const o of this.historyOffers.values()) {
      if (o.status === "pending" && o.expiresAt <= now) {
        o.status = "expired";
        this.releaseBlobs(o.manifest.chunkBlobIds);
      }
    }
  }

  private createHistoryOffer(donor: FakeInstance, recipientPath: string, body: Uint8Array): Response {
    const req = this.parse(createHistoryOfferRequestSchema, body);
    if (req.recipientInstanceId !== recipientPath) throw new HttpError(400, "validation_failed", "recipient in path and body differ");
    if (req.recipientInstanceId === donor.id) throw new HttpError(400, "validation_failed", "an instance cannot offer history to itself");
    const recipient = this.instances.get(req.recipientInstanceId);
    // Another account's instance is not distinguishable from a missing one.
    if (!recipient || recipient.accountId !== donor.accountId) throw new HttpError(404, "not_found", "recipient instance");
    if (recipient.status !== "active") throw new HttpError(403, "forbidden", `recipient is ${recipient.status}`);
    if (!recipient.transferPublicKey) throw new HttpError(409, "transfer_key_missing", "recipient has no transfer key");
    if (!ed25519.verify(base64Decode(req.manifestSignature), utf8Encode(archiveManifestMessage(req.manifest)), base64Decode(donor.signingPublicKey))) {
      throw new HttpError(401, "unauthorized", "manifest signature does not verify");
    }
    for (const id of req.manifest.chunkBlobIds) {
      const blob = this.blobs.get(id);
      if (!blob || blob.accountId !== donor.accountId) throw new HttpError(404, "not_found", `chunk blob ${id}`);
    }
    this.expireOffers();
    for (const o of this.historyOffers.values()) {
      if (o.status === "pending" && o.donorInstanceId === donor.id && o.recipientInstanceId === recipient.id) {
        o.status = "expired";
        this.releaseBlobs(o.manifest.chunkBlobIds);
      }
    }
    this.retainChunks(req.manifest.chunkBlobIds, donor.accountId);
    const offer: HistoryOffer = {
      id: uuidV7(this.now()),
      accountId: donor.accountId,
      donorInstanceId: donor.id,
      recipientInstanceId: recipient.id,
      manifest: req.manifest,
      sealedKey: req.sealedKey,
      manifestSignature: req.manifestSignature,
      status: "pending",
      createdAt: this.iso(),
      expiresAt: this.isoAt(this.now() + HISTORY_OFFER_TTL_MS),
    };
    this.historyOffers.set(offer.id, offer);
    this.emitTo(recipient.id, "history.offer", { offerId: offer.id });
    return json(201, { offer });
  }

  private putBackup(me: FakeInstance, body: Uint8Array): Response {
    const req = this.parse(putBackupRequestSchema, body);
    if (!ed25519.verify(base64Decode(req.manifestSignature), utf8Encode(archiveManifestMessage(req.manifest)), base64Decode(me.signingPublicKey))) {
      throw new HttpError(401, "unauthorized", "manifest signature does not verify");
    }
    this.retainChunks(req.manifest.chunkBlobIds, me.accountId);
    const previous = this.backups.get(me.accountId);
    const backup: AccountBackup = {
      accountId: me.accountId,
      instanceId: me.id,
      manifest: req.manifest,
      keyCheck: req.keyCheck,
      manifestSignature: req.manifestSignature,
      updatedAt: this.iso(),
    };
    this.backups.set(me.accountId, backup);
    if (previous) this.releaseBlobs(previous.manifest.chunkBlobIds);
    return json(200, { backup });
  }

  // ---- conversations -------------------------------------------------------

  private memberConversation(id: string, accountId: string): FakeConversation {
    const conv = this.conversations.get(id);
    if (!conv || !conv.members.has(accountId)) throw new HttpError(404, "not_found", "conversation");
    return conv;
  }

  private summary(conv: FakeConversation, instanceId: string): ConversationSummary {
    return {
      id: conv.id,
      kind: conv.kind,
      appId: conv.appId,
      mlsGroupId: conv.mlsGroupId,
      epoch: conv.epoch,
      lastSeq: conv.lastSeq,
      members: [...conv.members.entries()].map(([accountId, m]) => ({ accountId, role: m.role, state: m.state, joinedAt: m.joinedAt })),
      leaves: [...conv.leaves.entries()].map(([id, l]) => ({ instanceId: id, accountId: l.accountId, state: l.state, addedEpoch: l.addedEpoch })),
      myLeafState: conv.leaves.get(instanceId)?.state ?? null,
      createdByAccountId: conv.createdByAccountId,
      createdAt: conv.createdAt,
    };
  }

  private createConversation(me: FakeInstance, body: Uint8Array): Response {
    const req = this.parse(createConversationRequestSchema, body);
    return this.withIdempotency(me.id, req.idempotencyKey, body, () => {
      if (req.kind === "dm") {
        const other = req.memberAccountIds[0];
        if (other === me.accountId) throw new HttpError(400, "validation_failed", "self dm");
        const key = dmKeyFor(me.appId, me.accountId, other);
        const existing = [...this.conversations.values()].find((c) => c.dmKey === key);
        if (existing) return { status: 200, body: { conversation: this.summary(existing, me.id), created: false } };
      }
      if ([...this.conversations.values()].some((c) => c.mlsGroupId === req.mlsGroupId)) throw new HttpError(409, "idempotency_conflict", "group id in use");
      const now = this.iso();
      const conv: FakeConversation = {
        id: uuidV7(this.now()),
        kind: req.kind,
        appId: me.appId,
        dmKey: req.kind === "dm" ? dmKeyFor(me.appId, me.accountId, req.memberAccountIds[0]) : null,
        mlsGroupId: req.mlsGroupId,
        epoch: 0,
        lastSeq: 0,
        members: new Map([[me.accountId, { role: "owner", state: "joined", joinedAt: now }]]),
        leaves: new Map([[me.id, { accountId: me.accountId, state: "active", addedEpoch: 0 }]]),
        createdByAccountId: me.accountId,
        createdByInstanceId: me.id,
        createdAt: now,
        events: [],
      };
      for (const a of req.memberAccountIds) conv.members.set(a, { role: "member", state: "joined", joinedAt: now });
      this.conversations.set(conv.id, conv);
      this.appendControl(conv, { t: "conversation_created" }, []);
      if (req.initialCommit) this.submitEvent(conv, me, req.initialCommit);
      return { status: 201, body: { conversation: this.summary(conv, me.id), created: true } };
    });
  }

  private withIdempotency(instanceId: string, key: string, body: Uint8Array, run: () => { status: number; body: unknown }): Response {
    const k = `${instanceId}:${key}`;
    const bodySha = sha256Hex(body);
    const prior = this.idempotency.get(k);
    if (prior) {
      if (prior.bodySha !== bodySha) throw new HttpError(409, "idempotency_conflict", "key reused with a different body");
      return json(200, prior.body);
    }
    const result = run();
    this.idempotency.set(k, { bodySha, status: result.status, body: result.body });
    return json(result.status, result.body);
  }

  // ---- events --------------------------------------------------------------

  private submitEvent(conv: FakeConversation, sender: FakeInstance, req: SubmitEventRequest): { id: string; seq: number; createdAt: string } {
    const leaf = conv.leaves.get(sender.id);
    if (!leaf || leaf.state !== "active") throw new HttpError(403, "forbidden", "sender holds no active leaf");
    if (req.epoch !== conv.epoch) throw new HttpError(409, "epoch_conflict", "stale epoch", { currentEpoch: conv.epoch });
    const activeOthers = [...conv.leaves.entries()].filter(([id, l]) => l.state === "active" && id !== sender.id).map(([id]) => id);
    const event = this.append(conv, { kind: req.kind, epoch: req.epoch, senderAccountId: sender.accountId, senderInstanceId: sender.id, payload: req.payload, blobIds: req.blobIds ?? [] });
    if (req.kind !== "mls_commit") {
      this.deliver(conv, event, activeOthers);
      return { id: event.id, seq: event.seq, createdAt: event.createdAt };
    }
    const commit = req.commit!;
    for (const added of commit.addedLeaves) {
      const inst = this.instances.get(added.instanceId);
      if (!inst || inst.status !== "active" || inst.accountId !== added.accountId) throw new HttpError(403, "forbidden", "added instance is not an active instance of that account");
      if (commit.welcome && !commit.welcome.recipients.includes(added.instanceId)) throw new HttpError(400, "validation_failed", "welcome recipients must be the added leaves");
    }
    if (commit.welcome) {
      for (const r of commit.welcome.recipients) if (!commit.addedLeaves.some((a) => a.instanceId === r)) throw new HttpError(400, "validation_failed", "welcome recipient is not an added leaf");
    }
    conv.epoch = commit.newEpoch;
    this.deliver(conv, event, activeOthers);
    for (const added of commit.addedLeaves) {
      conv.leaves.set(added.instanceId, { accountId: added.accountId, state: "active", addedEpoch: commit.newEpoch });
      if (!conv.members.has(added.accountId)) conv.members.set(added.accountId, { role: "member", state: "joined", joinedAt: this.iso() });
      else conv.members.get(added.accountId)!.state = "joined";
    }
    for (const removed of commit.removedLeaves) {
      const l = conv.leaves.get(removed);
      if (l) l.state = "removed";
    }
    for (const [accountId, member] of conv.members) {
      const hasLeaf = [...conv.leaves.values()].some((l) => l.accountId === accountId && l.state === "active");
      if (!hasLeaf && member.state === "joined") member.state = "removed";
    }
    if (commit.welcome) {
      const welcome = this.append(conv, { kind: "mls_welcome", epoch: commit.newEpoch, senderAccountId: sender.accountId, senderInstanceId: sender.id, payload: commit.welcome.payload, blobIds: [] });
      this.deliver(conv, welcome, commit.welcome.recipients);
    }
    return { id: event.id, seq: event.seq, createdAt: event.createdAt };
  }

  private appendControl(conv: FakeConversation, control: ControlEvent, recipients: string[]): void {
    const event = this.append(conv, {
      kind: "control",
      epoch: conv.epoch,
      senderAccountId: SERVER_SENDER_ID,
      senderInstanceId: null,
      payload: base64Encode(utf8Encode(JSON.stringify(control))),
      blobIds: [],
    });
    this.deliver(conv, event, recipients);
  }

  private append(conv: FakeConversation, fields: Omit<ConversationEvent, "id" | "conversationId" | "seq" | "createdAt">): ConversationEvent {
    conv.lastSeq += 1;
    const event: ConversationEvent = { id: uuidV7(this.now()), conversationId: conv.id, seq: conv.lastSeq, createdAt: this.iso(), ...fields };
    conv.events.push(event);
    return event;
  }

  private deliver(conv: FakeConversation, event: ConversationEvent, recipients: string[]): void {
    for (const instanceId of new Set(recipients)) {
      this.deliveries.push({ id: ++this.deliverySeq, instanceId, conversationId: conv.id, event, acked: false });
      this.emitTo(instanceId, "sync.nudge", { conversationId: conv.id });
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private isoAt(ms: number): string {
    return new Date(ms).toISOString();
  }
}

export function createFakeAlloServer(): FakeAlloServer {
  return new FakeAlloServer();
}

function forbiddenOr(_t: FakeInstance): number {
  return 403;
}

function toClient(i: FakeInstance): ClientInstance {
  const { challenge: _c, pushToken: _p, pushProvider: _q, ...rest } = i;
  void _c;
  void _p;
  void _q;
  return rest;
}

function toPublic(i: FakeInstance): PublicInstance {
  return {
    id: i.id,
    accountId: i.accountId,
    appId: i.appId,
    platform: i.platform,
    signingPublicKey: i.signingPublicKey,
    transferPublicKey: i.transferPublicKey,
    approvedByInstanceId: i.approvedByInstanceId,
    approvalSignature: i.approvalSignature,
    enrollmentChallenge: i.enrollmentChallenge,
    status: i.status,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body === null || body === undefined) return new Uint8Array();
  if (typeof body === "string") return utf8Encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new Error("unsupported body type in fake server");
}
