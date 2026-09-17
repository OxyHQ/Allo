/**
 * The instance lifecycle: one Ed25519 signing key per installation, kept in
 * the host's `SecretStore`; registration; the enrollment state machine
 * `unregistered → pending-approval | active → revoked`; approving and
 * revoking other instances of the account; and the key-package stock the
 * server hands out so others can add this instance while it is offline.
 */
import {
  claimKeyPackagesResponseSchema,
  instanceResponseSchema,
  listAccountInstancesResponseSchema,
  listInstancesResponseSchema,
  listPendingEnrollmentsResponseSchema,
  registerInstanceResponseSchema,
  uploadKeyPackagesResponseSchema,
  type ClaimedKeyPackage,
  type ClientInstance,
  type PendingEnrollment,
  type PublicInstance,
} from "@allo/shared-types";
import { CIPHERSUITE_ID, type CryptoEngine, type Identity, type KeyPackageBundle } from "../crypto/engine";
import { generateSigningKey, publicKeyBase64, signEnrollmentApproval, signingKeyFromSecret, verifyInstanceChain, type SigningKeyPair } from "../crypto/signing";
import { InstanceNotActiveError, InvalidStateError, NotFoundError, TransportError } from "../errors";
import type { Emitter } from "../events/emitter";
import { keyPackageRecordSchema, type InstanceRecord, type KeyPackageRecord } from "../storage/records";
import type { AlloStore, InstanceStore } from "../storage/store";
import type { HttpClient, Signer } from "../transport/http";
import type { InstanceState, InstanceView, PendingEnrollmentView, SecretStore } from "../types";
import { base64Decode, base64Encode, bytesEqual, hexEncode, sha256Bytes, utf8Encode } from "../util/bytes";
import { base64UrlEncode } from "@allo/shared-types";
import type { Logger } from "../util/logger";
import { describeError } from "../util/logger";
import type { Model } from "../storage/model";

export function instanceKeyName(accountId: string, appId: string): string {
  return `allo.instance-key.${accountId}.${appId}`;
}

/** A short human-checkable digest of an enrollment challenge: `ab12 cd34 ef56 7890`. */
export function challengeFingerprint(challenge: string): string {
  const hex = hexEncode(sha256Bytes(utf8Encode(challenge))).slice(0, 16);
  return hex.match(/.{4}/g)!.join(" ");
}

export interface InstanceManagerDeps {
  http: HttpClient;
  rootStore: AlloStore;
  secrets: SecretStore;
  engine: CryptoEngine;
  emitter: Emitter;
  log: Logger;
  now: () => number;
  accountId: string;
  appId: string;
  platform: InstanceRecord["platform"];
  displayName: string;
  keyPackageTarget: number;
  /** Called once when this instance turns out to be revoked, so the client can stop its loops. */
  onRevoked?: () => void;
}

export class InstanceManager {
  private record: InstanceRecord | undefined;
  private key: SigningKeyPair | undefined;
  private store: InstanceStore | undefined;
  private model: Model | undefined;
  private own: ClientInstance[] = [];
  private pendingList: PendingEnrollment[] = [];
  private serverAvailable: number | null = null;
  private listView: InstanceView[] | null = null;
  private pendingView: PendingEnrollmentView[] | null = null;
  private currentCache: InstanceView | null | undefined = undefined;
  private stock = new Map<string, KeyPackageRecord>();

  constructor(private readonly deps: InstanceManagerDeps) {}

  // ---- state ---------------------------------------------------------------

  get state(): InstanceState {
    if (!this.record) return "unregistered";
    switch (this.record.status) {
      case "pending":
        return "pending-approval";
      case "active":
        return "active";
      case "revoked":
        return "revoked";
    }
  }

  get isActive(): boolean {
    return this.state === "active";
  }

  get current(): InstanceRecord | undefined {
    return this.record;
  }

  get signer(): Signer {
    if (!this.record || !this.key) throw new InvalidStateError("instance is not registered");
    return { instanceId: this.record.id, key: this.key };
  }

  get identity(): Identity {
    const { instanceId, key } = this.signer;
    return this.deps.engine.createIdentity({ accountId: this.deps.accountId, instanceId, signingKey: key });
  }

  get instanceStore(): InstanceStore {
    if (!this.store) throw new InvalidStateError("instance is not registered");
    return this.store;
  }

  bindModel(model: Model): void {
    this.model = model;
  }

  assertActive(): void {
    if (!this.isActive) throw new InstanceNotActiveError(this.state);
  }

  // ---- registration --------------------------------------------------------

  /** Loads the persisted instance or registers a new one. Idempotent. */
  async ensureRegistered(): Promise<InstanceRecord> {
    const { rootStore, secrets, accountId, appId } = this.deps;
    const keyName = instanceKeyName(accountId, appId);
    let secret = await secrets.get(keyName);
    const existing = await rootStore.getSelf();
    if (existing && secret && secret.length === 32) {
      const key = signingKeyFromSecret(secret);
      if (publicKeyBase64(key) === existing.signingPublicKey) {
        this.record = existing;
        this.key = key;
        this.store = rootStore.forInstance(existing.id);
        await this.loadStock();
        this.emitInstance();
        return existing;
      }
      this.deps.log.warn?.("instance record does not match the stored key; re-registering");
    }
    if (!secret || secret.length !== 32) {
      const fresh = generateSigningKey();
      await secrets.set(keyName, fresh.secretKey);
      const check = await secrets.get(keyName);
      if (!check || !bytesEqual(check, fresh.secretKey)) throw new InvalidStateError("secret store did not persist the instance key");
      secret = fresh.secretKey;
    }
    const key = signingKeyFromSecret(secret);
    const publicKey = publicKeyBase64(key);
    let instance: ClientInstance;
    let challenge: string | null = null;
    try {
      const res = await this.deps.http.request({
        method: "POST",
        path: "/v1/instances",
        body: { appId, platform: this.deps.platform, displayName: this.deps.displayName, signingPublicKey: publicKey },
        schema: registerInstanceResponseSchema,
      });
      instance = res.instance;
      challenge = res.challenge ?? null;
    } catch (error) {
      // The key is already enrolled on the account (storage wiped, secret kept): adopt that instance.
      if (!(error instanceof TransportError && error.status === 409 && error.serverCode === "idempotency_conflict")) throw error;
      const listed = await this.deps.http.request({ method: "GET", path: "/v1/instances", schema: listInstancesResponseSchema });
      const mine = listed.instances.find((i) => i.signingPublicKey === publicKey && i.status !== "revoked");
      if (!mine) throw new InvalidStateError("the signing key is enrolled but no live instance carries it; clear the secret store and start again");
      instance = mine;
      this.deps.log.info?.("adopted an already-enrolled instance", { status: mine.status });
    }
    const record: InstanceRecord = {
      id: instance.id,
      accountId: instance.accountId,
      appId: instance.appId,
      platform: instance.platform,
      displayName: instance.displayName,
      signingPublicKey: instance.signingPublicKey,
      status: instance.status,
      challenge,
      approvedByInstanceId: instance.approvedByInstanceId,
      approvalSignature: instance.approvalSignature,
      createdAt: instance.createdAt,
    };
    await rootStore.setSelf(record);
    this.record = record;
    this.key = key;
    this.store = rootStore.forInstance(record.id);
    await this.loadStock();
    this.emitInstance();
    return record;
  }

  /** Re-reads the account's instances; picks up approval and revocation of this one. */
  async refresh(): Promise<void> {
    if (!this.record) return;
    const res = await this.deps.http.request({ method: "GET", path: "/v1/instances", schema: listInstancesResponseSchema });
    this.own = res.instances;
    this.listView = null;
    const me = res.instances.find((i) => i.id === this.record?.id);
    if (me && me.status !== this.record.status) {
      const next: InstanceRecord = {
        ...this.record,
        status: me.status,
        approvedByInstanceId: me.approvedByInstanceId,
        approvalSignature: me.approvalSignature,
      };
      await this.deps.rootStore.setSelf(next);
      this.record = next;
      this.emitInstance();
      if (next.status === "revoked") this.deps.onRevoked?.();
    } else if (!me && this.record.status !== "revoked") {
      this.deps.log.warn?.("this instance is no longer listed by the server");
    }
    // The listing carries fields (enrolledAt, lastSeenAt…) the current view shows. The cached snapshot is
    // replaced ONLY when the view actually changed, and that replacement always comes with an emission.
    if (this.currentCache !== undefined) {
      const next = this.computeCurrentView();
      if (JSON.stringify(next) !== JSON.stringify(this.currentCache)) {
        this.currentCache = next;
        this.listView = null;
        this.deps.emitter.emit("instance");
      }
    }
    this.deps.emitter.emit("instances");
  }

  markRevoked(): void {
    if (!this.record || this.record.status === "revoked") return;
    this.record = { ...this.record, status: "revoked" };
    void this.deps.rootStore.setSelf(this.record).catch(() => undefined);
    this.emitInstance();
    this.deps.onRevoked?.();
  }

  async refreshPending(): Promise<void> {
    if (!this.isActive) return;
    const res = await this.deps.http.request({ method: "GET", path: "/v1/instances/pending", schema: listPendingEnrollmentsResponseSchema, signer: this.signer });
    this.pendingList = res.pending;
    this.pendingView = null;
    this.deps.emitter.emit("instances");
  }

  /**
   * Approves a pending instance of this account. `expectedChallenge`, when
   * given, must equal the challenge the server issued: the UI shows its
   * fingerprint and the approval signs exactly that, nothing else.
   */
  async approve(instanceId: string, expectedChallenge?: string): Promise<void> {
    this.assertActive();
    if (!this.pendingList.some((p) => p.instance.id === instanceId)) await this.refreshPending();
    const pending = this.pendingList.find((p) => p.instance.id === instanceId);
    if (!pending) throw new NotFoundError(`pending enrollment ${instanceId}`);
    if (expectedChallenge !== undefined && expectedChallenge !== pending.challenge) {
      throw new InvalidStateError("the challenge shown is not the challenge on record");
    }
    const { key } = this.signer;
    const approvalSignature = signEnrollmentApproval(key, {
      accountId: this.deps.accountId,
      newInstanceId: pending.instance.id,
      newSigningPublicKey: pending.instance.signingPublicKey,
      challenge: pending.challenge,
    });
    await this.deps.http.request({
      method: "POST",
      path: `/v1/instances/${instanceId}/approve`,
      body: { approvalSignature },
      schema: instanceResponseSchema,
      signer: this.signer,
    });
    this.pendingList = this.pendingList.filter((p) => p.instance.id !== instanceId);
    this.pendingView = null;
    await this.refresh();
  }

  async reject(instanceId: string): Promise<void> {
    this.assertActive();
    await this.deps.http.request({ method: "POST", path: `/v1/instances/${instanceId}/reject`, schema: instanceResponseSchema, signer: this.signer });
    this.pendingList = this.pendingList.filter((p) => p.instance.id !== instanceId);
    this.pendingView = null;
    this.deps.emitter.emit("instances");
  }

  async revoke(instanceId: string): Promise<void> {
    this.assertActive();
    await this.deps.http.request({ method: "POST", path: `/v1/instances/${instanceId}/revoke`, schema: instanceResponseSchema, signer: this.signer });
    if (instanceId === this.record?.id) this.markRevoked();
    else await this.refresh();
  }

  // ---- push ----------------------------------------------------------------

  async setPushToken(provider: "fcm" | "apns", token: string): Promise<void> {
    this.assertActive();
    await this.deps.http.request({ method: "PUT", path: "/v1/instances/me/push", body: { provider, token }, signer: this.signer });
  }

  async clearPushToken(): Promise<void> {
    this.assertActive();
    await this.deps.http.request({ method: "DELETE", path: "/v1/instances/me/push", signer: this.signer });
  }

  // ---- trust ---------------------------------------------------------------

  /** Own instances (cached listing) that pass the chain check. */
  trustedOwnInstances(): { trusted: ClientInstance[]; refused: Map<string, string> } {
    const verdict = verifyInstanceChain(this.own);
    return { trusted: this.own.filter((i) => verdict.trusted.has(i.id)), refused: verdict.refused };
  }

  /** Another account's active instances that pass the chain check. */
  async trustedInstancesOf(accountId: string): Promise<{ trusted: PublicInstance[]; refused: Map<string, string> }> {
    if (accountId === this.deps.accountId) {
      await this.refresh();
      const own = this.trustedOwnInstances();
      return { trusted: own.trusted.map(toPublic), refused: own.refused };
    }
    let res;
    try {
      res = await this.deps.http.request({ method: "GET", path: `/v1/accounts/${accountId}/instances`, schema: listAccountInstancesResponseSchema });
    } catch (error) {
      // 404: the server has never seen that account (it has no Allo instance at all). Nothing to add, and the caller should say so.
      if (error instanceof TransportError && error.status === 404) throw new NotFoundError(`account ${accountId} has no Allo instance`);
      throw error;
    }
    const verdict = verifyInstanceChain(res.instances);
    return { trusted: res.instances.filter((i) => verdict.trusted.has(i.id)), refused: verdict.refused };
  }

  ownInstances(): ClientInstance[] {
    return this.own;
  }

  // ---- key package stock ---------------------------------------------------

  private async loadStock(): Promise<void> {
    this.stock.clear();
    for (const { value } of await this.instanceStore.listJson("keyPackage", keyPackageRecordSchema)) this.stock.set(value.ref, value);
  }

  /** Uploads until the server holds `keyPackageTarget` unconsumed packages of ours. */
  async topUpKeyPackages(available?: number): Promise<void> {
    if (!this.isActive) return;
    if (available !== undefined) this.serverAvailable = available;
    const have = this.serverAvailable ?? 0;
    const need = this.deps.keyPackageTarget - have;
    if (need <= 0) return;
    const bundles = await this.deps.engine.generateKeyPackages(this.identity, Math.min(need, 50));
    const batch = this.instanceStore.batch();
    const records: KeyPackageRecord[] = bundles.map((b) => ({
      ref: base64Encode(b.ref),
      publicWire: base64Encode(b.publicWire),
      initPrivateKey: base64Encode(b.privatePackage.initPrivateKey),
      hpkePrivateKey: base64Encode(b.privatePackage.hpkePrivateKey),
      signaturePrivateKey: base64Encode(b.privatePackage.signaturePrivateKey),
      createdAt: new Date(this.deps.now()).toISOString(),
      uploaded: true,
    }));
    // Private parts first: a package the server hands out before its private half is safe is useless.
    for (const r of records) batch.putJson("keyPackage", base64UrlEncode(base64Decode(r.ref)), r);
    await this.instanceStore.commit(batch);
    for (const r of records) this.stock.set(r.ref, r);
    const res = await this.deps.http.request({
      method: "PUT",
      path: "/v1/key-packages",
      body: { keyPackages: records.map((r) => ({ ciphersuite: CIPHERSUITE_ID, ref: r.ref, data: r.publicWire })) },
      schema: uploadKeyPackagesResponseSchema,
      signer: this.signer,
    });
    this.serverAvailable = res.available;
  }

  /** The private half of a key package a Welcome names, removed from the stock. */
  async takeKeyPackage(ref: Uint8Array): Promise<KeyPackageBundle | undefined> {
    const record = this.stock.get(base64Encode(ref));
    if (!record) return undefined;
    this.stock.delete(record.ref);
    await this.instanceStore.delete("keyPackage", base64UrlEncode(ref));
    const publicWire = base64Decode(record.publicWire);
    return {
      ref,
      publicWire,
      keyPackage: this.deps.engine.decodeKeyPackage(publicWire),
      privatePackage: {
        initPrivateKey: base64Decode(record.initPrivateKey),
        hpkePrivateKey: base64Decode(record.hpkePrivateKey),
        signaturePrivateKey: base64Decode(record.signaturePrivateKey),
      },
    };
  }

  hasKeyPackage(ref: Uint8Array): boolean {
    return this.stock.has(base64Encode(ref));
  }

  get stockSize(): number {
    return this.stock.size;
  }

  async claimKeyPackages(instanceIds: string[]): Promise<{ keyPackages: ClaimedKeyPackage[]; missing: string[] }> {
    if (instanceIds.length === 0) return { keyPackages: [], missing: [] };
    return this.deps.http.request({
      method: "POST",
      path: "/v1/key-packages/claim",
      body: { instanceIds },
      schema: claimKeyPackagesResponseSchema,
      signer: this.signer,
    });
  }

  // ---- views ---------------------------------------------------------------

  list(): InstanceView[] {
    if (!this.listView) this.listView = this.own.map((i) => this.toView(i));
    return this.listView;
  }

  pending(): PendingEnrollmentView[] {
    if (!this.pendingView) {
      this.pendingView = this.pendingList.map((p) => ({ instance: this.toView(p.instance), challenge: p.challenge, fingerprint: challengeFingerprint(p.challenge) }));
    }
    return this.pendingView;
  }

  /** Referentially stable until the `instance` topic emits. */
  currentView(): InstanceView | null {
    if (this.currentCache !== undefined) return this.currentCache;
    this.currentCache = this.computeCurrentView();
    return this.currentCache;
  }

  private computeCurrentView(): InstanceView | null {
    if (!this.record) return null;
    const listed = this.own.find((i) => i.id === this.record?.id);
    // The record is updated first (approval, revocation); a listing fetched earlier must not outvote it.
    if (listed) return { ...this.toView(listed), status: this.record.status };
    return {
      id: this.record.id,
      accountId: this.record.accountId,
      appId: this.record.appId,
      platform: this.record.platform,
      displayName: this.record.displayName,
      signingPublicKey: this.record.signingPublicKey,
      status: this.record.status,
      isThis: true,
      approvedByInstanceId: this.record.approvedByInstanceId,
      enrolledAt: null,
      revokedAt: null,
      lastSeenAt: null,
      createdAt: this.record.createdAt,
    };
  }

  private toView(i: ClientInstance): InstanceView {
    return {
      id: i.id,
      accountId: i.accountId,
      appId: i.appId,
      platform: i.platform,
      displayName: i.displayName,
      signingPublicKey: i.signingPublicKey,
      status: i.status,
      isThis: i.id === this.record?.id,
      approvedByInstanceId: i.approvedByInstanceId,
      enrolledAt: i.enrolledAt,
      revokedAt: i.revokedAt,
      lastSeenAt: i.lastSeenAt,
      createdAt: i.createdAt,
    };
  }

  private emitInstance(): void {
    this.listView = null;
    this.currentCache = undefined;
    this.deps.emitter.emit("instance");
  }

  describe(error: unknown): string {
    return describeError(error);
  }
}

function toPublic(i: ClientInstance): PublicInstance {
  return {
    id: i.id,
    accountId: i.accountId,
    appId: i.appId,
    platform: i.platform,
    signingPublicKey: i.signingPublicKey,
    approvedByInstanceId: i.approvedByInstanceId,
    approvalSignature: i.approvalSignature,
    enrollmentChallenge: i.enrollmentChallenge,
    status: i.status,
  };
}
