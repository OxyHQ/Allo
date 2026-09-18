/**
 * History transfer between instances of ONE account.
 *
 * Donor side (`offerTo`): export the local history, encrypt it in chunks
 * under a fresh archive key, upload the chunks as blobs, seal the key to the
 * recipient's transfer key, sign the manifest, post the offer. Automatic: the
 * elector — the instance that adds a newly approved same-account instance to
 * the account's groups — offers it history once (`autoOffer`, persisted per
 * recipient).
 *
 * Recipient side (`accept`): the server's word counts for nothing. The donor
 * must be an ACTIVE instance of THIS account that passes the approval chain,
 * the manifest signature must verify under the donor's key, the sealed key
 * must open with our transfer key, the chunks must authenticate and the
 * plaintext digest must match — and only then is anything imported.
 * Automatic: on a `history.offer` nudge or after a sync, a pending offer from
 * a verified same-account donor is accepted; anything else is left alone.
 */
import {
  HISTORY_KEY_SEAL_INFO,
  archiveManifestMessage,
  decodeArchive,
  encodeArchive,
  historyOfferResponseSchema,
  listHistoryOffersResponseSchema,
  uploadBlobResponseSchema,
  BLOB_SHA256_HEADER,
  type ArchiveManifest,
  type ClientInstance,
  type HistoryOffer,
} from "@allo/shared-types";
import type { Context } from "../context";
import { decryptArchive, encryptArchive, generateArchiveKey } from "../crypto/archive";
import { signUtf8, verifyEd25519 } from "../crypto/signing";
import { openWith, sealTo } from "../crypto/transfer";
import { DecryptError, InvalidStateError, NotFoundError, UntrustedInstanceError } from "../errors";
import { historyOfferedRecordSchema, type HistoryOfferedRecord } from "../storage/records";
import type { HistoryOfferView, HistoryProgress } from "../types";
import { Mutex } from "../util/async";
import { base64Decode, base64Encode, sha256Hex } from "../util/bytes";
import { describeError } from "../util/logger";
import { exportArchive, importArchive } from "./archive";

const IDLE: HistoryProgress = { phase: "idle", done: 0, total: 0 };
/** After a failed automatic offer, wait this long before the next reconcile tries again. */
const AUTO_OFFER_RETRY_MS = 5 * 60_000;

export class HistoryService {
  /** Serialises every archive job (offer, accept, backup refresh, restore): one progress, one export at a time. */
  readonly jobs = new Mutex();
  private progressValue: HistoryProgress = IDLE;
  private offers: HistoryOffer[] = [];
  private offersView: HistoryOfferView[] | null = null;
  private readonly offered = new Map<string, HistoryOfferedRecord>();
  private readonly offering = new Set<string>();
  private readonly offerFailedAt = new Map<string, number>();
  private readonly autoRefused = new Set<string>();
  private checking: Promise<void> | null = null;
  private lastOffersCheck = 0;
  offersStale = true;

  constructor(private readonly ctx: Context) {}

  async load(): Promise<void> {
    for (const { value } of await this.ctx.store.listJson("historyOffered", historyOfferedRecordSchema)) this.offered.set(value.instanceId, value);
  }

  // ---- views ---------------------------------------------------------------

  /** Referentially stable until the `history` topic emits. */
  progress(): HistoryProgress {
    return this.progressValue;
  }

  pendingOffers(): HistoryOfferView[] {
    if (!this.offersView) {
      this.offersView = this.offers.map((o) => {
        const donor = this.ctx.instance.ownInstance(o.donorInstanceId);
        return {
          id: o.id,
          donorInstanceId: o.donorInstanceId,
          donorDisplayName: donor?.displayName ?? null,
          conversationCount: o.manifest.conversationCount,
          eventCount: o.manifest.eventCount,
          createdAt: o.createdAt,
          expiresAt: o.expiresAt,
          trusted: this.donorVerdict(o) === null,
        };
      });
    }
    return this.offersView;
  }

  private setProgress(next: HistoryProgress): void {
    this.progressValue = next;
    this.ctx.emitter.emit("history");
  }

  // ---- offers list ---------------------------------------------------------

  async refreshOffers(): Promise<void> {
    const { ctx } = this;
    if (!ctx.instance.isActive) return;
    const res = await ctx.http.request({ method: "GET", path: "/v1/instances/me/history-offers", schema: listHistoryOffersResponseSchema, signer: ctx.signer });
    this.offers = res.offers.filter((o) => o.status === "pending");
    this.offersView = null;
    this.lastOffersCheck = ctx.now();
    this.offersStale = false;
    ctx.emitter.emit("history");
  }

  onOfferNudge(): void {
    this.offersStale = true;
    void this.checkOffers().catch(() => undefined);
  }

  /** After each sync: re-list when stale or old enough, then auto-accept what a verified same-account donor offered. */
  checkOffers(): Promise<void> {
    if (this.checking) {
      this.offersStale = true;
      return this.checking;
    }
    this.checking = (async () => {
      const { ctx } = this;
      try {
        if (!ctx.instance.isActive) return;
        if (this.offersStale || ctx.now() - this.lastOffersCheck > ctx.options.syncIntervalMs) await this.refreshOffers();
        await this.autoAccept();
      } catch (error) {
        ctx.log.debug?.("history offer check failed", { error: describeError(error) });
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  private async autoAccept(): Promise<void> {
    const { ctx } = this;
    for (const offer of [...this.offers]) {
      if (this.autoRefused.has(offer.id)) continue;
      if (this.donorVerdict(offer) !== null) {
        // Refresh the listing once: the donor may simply be newer than our cache.
        await ctx.instance.refresh().catch(() => undefined);
        this.offersView = null;
      }
      const why = this.donorVerdict(offer);
      if (why !== null) {
        ctx.log.warn?.("history offer left alone: donor not verified", { offerId: offer.id, donorInstanceId: offer.donorInstanceId, reason: why });
        this.autoRefused.add(offer.id);
        continue;
      }
      try {
        await this.accept(offer.id);
      } catch (error) {
        ctx.log.warn?.("automatic history accept failed", { offerId: offer.id, error: describeError(error) });
        this.autoRefused.add(offer.id);
      }
    }
  }

  // ---- trust ---------------------------------------------------------------

  /**
   * `null` when the donor is a verified, active instance of this account
   * and the manifest is its; otherwise why not. Reads the cached listing.
   */
  private donorVerdict(offer: HistoryOffer): string | null {
    const { ctx } = this;
    if (offer.accountId !== ctx.accountId) return "offer is for another account";
    if (offer.recipientInstanceId !== ctx.instanceId) return "offer is for another instance";
    if (offer.donorInstanceId === ctx.instanceId) return "offer from this instance";
    if (offer.manifest.kind !== "transfer") return "manifest is not a transfer manifest";
    const donor = ctx.instance.ownInstance(offer.donorInstanceId);
    if (!donor) return "donor is not an instance of this account";
    if (donor.accountId !== ctx.accountId) return "donor belongs to another account";
    if (donor.status !== "active") return `donor is ${donor.status}`;
    const { trusted, refused } = ctx.instance.trustedOwnInstances();
    if (!trusted.some((i) => i.id === donor.id)) return refused.get(donor.id) ?? "donor does not pass the approval chain";
    if (!verifyEd25519(donor.signingPublicKey, archiveManifestMessage(offer.manifest), offer.manifestSignature)) return "manifest signature does not verify";
    return null;
  }

  private requireTrustedDonor(offer: HistoryOffer): ClientInstance {
    const why = this.donorVerdict(offer);
    if (why !== null) throw new UntrustedInstanceError(offer.donorInstanceId, why);
    return this.ctx.instance.ownInstance(offer.donorInstanceId)!;
  }

  // ---- donor side ----------------------------------------------------------

  exportArchive() {
    return exportArchive(this.ctx);
  }

  /** Exports, encrypts, uploads, seals and posts an offer to another active, verified instance of this account. */
  async offerTo(instanceId: string): Promise<HistoryOffer> {
    const { ctx } = this;
    ctx.instance.assertActive();
    if (instanceId === ctx.instanceId) throw new InvalidStateError("an instance cannot offer history to itself");
    if (!ctx.instance.ownInstance(instanceId)) await ctx.instance.refresh();
    const recipient = ctx.instance.ownInstance(instanceId);
    if (!recipient || recipient.accountId !== ctx.accountId) throw new UntrustedInstanceError(instanceId, "not an instance of this account");
    const { trusted, refused } = ctx.instance.trustedOwnInstances();
    if (recipient.status !== "active" || !trusted.some((i) => i.id === recipient.id)) {
      throw new UntrustedInstanceError(instanceId, refused.get(instanceId) ?? `recipient is ${recipient.status}`);
    }
    if (!recipient.transferPublicKey) throw new InvalidStateError("the recipient has no transfer key yet; it cannot receive history");
    const recipientKey = base64Decode(recipient.transferPublicKey);
    return this.jobs.run(async () => {
      try {
        this.setProgress({ phase: "exporting", done: 0, total: 0, toInstanceId: instanceId });
        const archive = exportArchive(ctx);
        const plaintext = encodeArchive(archive);
        const key = generateArchiveKey();
        const chunks = encryptArchive(key, plaintext);
        const chunkBlobIds = await this.uploadChunks(chunks, (done, total) => this.setProgress({ phase: "uploading", done, total, toInstanceId: instanceId }));
        const manifest: ArchiveManifest = {
          v: 1,
          kind: "transfer",
          createdAt: ctx.nowIso(),
          conversationCount: archive.conversations.length,
          eventCount: archive.events.length,
          chunkBlobIds,
          plaintextSha256: sha256Hex(plaintext),
        };
        const sealedKey = base64Encode(await sealTo(recipientKey, key, HISTORY_KEY_SEAL_INFO));
        const manifestSignature = signUtf8(ctx.signer.key, archiveManifestMessage(manifest));
        const res = await ctx.http.request({
          method: "POST",
          path: `/v1/instances/${instanceId}/history-offers`,
          body: { recipientInstanceId: instanceId, manifest, sealedKey, manifestSignature },
          schema: historyOfferResponseSchema,
          signer: ctx.signer,
        });
        ctx.log.info?.("history offered", { recipientInstanceId: instanceId, conversations: manifest.conversationCount, events: manifest.eventCount, chunks: chunkBlobIds.length });
        return res.offer;
      } finally {
        this.setProgress(IDLE);
      }
    });
  }

  async uploadChunks(chunks: Uint8Array[], onProgress: (done: number, total: number) => void): Promise<string[]> {
    const { ctx } = this;
    const ids: string[] = [];
    onProgress(0, chunks.length);
    for (const chunk of chunks) {
      const res = await ctx.http.request({
        method: "POST",
        path: "/v1/blobs",
        rawBody: chunk,
        headers: { [BLOB_SHA256_HEADER]: sha256Hex(chunk) },
        schema: uploadBlobResponseSchema,
        signer: ctx.signer,
      });
      ids.push(res.blobId);
      onProgress(ids.length, chunks.length);
    }
    return ids;
  }

  async downloadChunks(blobIds: string[], onProgress: (done: number, total: number) => void): Promise<Uint8Array[]> {
    const { ctx } = this;
    const chunks: Uint8Array[] = [];
    onProgress(0, blobIds.length);
    for (const id of blobIds) {
      chunks.push(await ctx.http.request<Uint8Array>({ method: "GET", path: `/v1/blobs/${id}`, binary: true, signer: ctx.signer }));
      onProgress(chunks.length, blobIds.length);
    }
    return chunks;
  }

  /**
   * The elector calls this with own instances it has added (or is adding) to
   * a group. Each gets ONE offer, ever; a failed attempt is retried on a later
   * reconcile after a pause. Never throws.
   */
  async autoOffer(instanceIds: string[]): Promise<void> {
    const { ctx } = this;
    for (const id of instanceIds) {
      if (id === ctx.instanceId || this.offered.has(id) || this.offering.has(id)) continue;
      const failedAt = this.offerFailedAt.get(id);
      if (failedAt !== undefined && ctx.now() - failedAt < AUTO_OFFER_RETRY_MS) continue;
      this.offering.add(id);
      try {
        const offer = await this.offerTo(id);
        const record: HistoryOfferedRecord = { instanceId: id, offerId: offer.id, offeredAt: ctx.nowIso() };
        await ctx.store.putJson("historyOffered", id, record);
        this.offered.set(id, record);
        this.offerFailedAt.delete(id);
      } catch (error) {
        this.offerFailedAt.set(id, ctx.now());
        ctx.log.warn?.("automatic history offer failed", { recipientInstanceId: id, error: describeError(error) });
      } finally {
        this.offering.delete(id);
      }
    }
  }

  /** Instances this one has offered history to (persisted). */
  offeredTo(): string[] {
    return [...this.offered.keys()];
  }

  // ---- recipient side ------------------------------------------------------

  /** Verifies the donor and the manifest, opens the key, downloads, decrypts, imports, consumes. */
  async accept(offerId: string): Promise<void> {
    const { ctx } = this;
    ctx.instance.assertActive();
    let offer = this.offers.find((o) => o.id === offerId);
    if (!offer) {
      await this.refreshOffers();
      offer = this.offers.find((o) => o.id === offerId);
    }
    if (!offer) throw new NotFoundError(`history offer ${offerId}`);
    if (!ctx.instance.ownInstance(offer.donorInstanceId)) await ctx.instance.refresh();
    const donor = this.requireTrustedDonor(offer);
    // Everything above is decided before a single byte of the archive is fetched.
    const key = await openWith(ctx.instance.transferSecretKey, base64Decode(offer.sealedKey), HISTORY_KEY_SEAL_INFO);
    if (key.length !== 32) throw new DecryptError("sealed key did not open to a 32-byte archive key");
    const from = donor.id;
    await this.jobs.run(async () => {
      try {
        const chunks = await this.downloadChunks(offer!.manifest.chunkBlobIds, (done, total) => this.setProgress({ phase: "downloading", done, total, fromInstanceId: from }));
        const plaintext = decryptArchive(key, chunks);
        if (sha256Hex(plaintext) !== offer!.manifest.plaintextSha256) throw new DecryptError("archive digest does not match the signed manifest");
        const archive = decodeArchive(plaintext);
        const result = await importArchive(ctx, archive, (done, total) => this.setProgress({ phase: "importing", done, total, fromInstanceId: from }));
        ctx.log.info?.("history imported", { donorInstanceId: from, conversations: result.conversations, events: result.events });
      } finally {
        this.setProgress(IDLE);
      }
    });
    try {
      await ctx.http.request({ method: "POST", path: `/v1/instances/me/history-offers/${offerId}/consume`, schema: historyOfferResponseSchema, signer: ctx.signer });
    } catch (error) {
      ctx.log.debug?.("history offer consume failed", { offerId, error: describeError(error) });
    }
    this.offers = this.offers.filter((o) => o.id !== offerId);
    this.offersView = null;
    ctx.emitter.emit("history");
  }

  stop(): void {
    /* no timers of its own; jobs in flight finish on their own */
  }
}
