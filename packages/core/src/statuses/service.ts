/**
 * STATUS UPDATES, CLIENT SIDE.
 *
 * The device does all the deciding. It resolves the audience from the
 * conversations it is in — the server is never asked who your contacts are —
 * encrypts the update once under a random per-status key, uploads any media
 * as its own encrypted blob, and seals that key to each recipient DEVICE with
 * HPKE against the transfer key that device published. The server receives a
 * body it cannot open and `N` sealed keys it cannot use.
 *
 * Nothing here is persisted. A status is a fact with a deadline, and a dot of
 * it restored from disk on a cold start would be this device claiming
 * something it has not checked. The server holds them for their 24 hours, so
 * a restart re-reads; media keys live only in the decrypted payload in memory,
 * which is also why they are gone the moment the status is.
 *
 * Two things are verified before anything is shown, and both are refusals the
 * server cannot talk the device out of:
 *
 * 1. The author's signature over `(id, author, digest, deadline)`, against the
 *    published key of the instance named — and only if that instance passes
 *    the same chain check the elector uses. A status the server made up is
 *    dropped here.
 * 2. The digest of the ciphertext, before decrypting it.
 */
import {
  createStatusResponseSchema,
  listStatusViewsResponseSchema,
  listStatusesResponseSchema,
  statusPayloadSchema,
  statusSignatureMessage,
  STATUS_KEY_SEAL_INFO,
  STATUS_LIFETIME_MS,
  STATUS_PAYLOAD_VERSION,
  type Status,
  type StatusMedia,
} from "@allo/shared-types";
import type { Context } from "../context";
import { openWith, sealTo } from "../crypto/transfer";
import { signUtf8, verifyEd25519 } from "../crypto/signing";
import { InvalidStateError, NotFoundError } from "../errors";
import type { StatusAudience, StatusDraft, StatusView, StatusViewerView } from "../types";
import { base64Decode, base64Encode, randomBytes, sha256Hex, utf8Decode, utf8Encode } from "../util/bytes";
import { uuidV7 } from "../util/ids";
import { describeError } from "../util/logger";
import { decryptBytes, encryptBytes, uploadEncryptedBlob } from "../media/service";

interface Held {
  view: StatusView;
  /** The media descriptor from inside the envelope, for a fetch on demand. */
  media: StatusMedia | null;
}

const EMPTY: readonly StatusView[] = Object.freeze([]);

export class StatusService {
  private held = new Map<string, Held>();
  private cache: readonly StatusView[] = EMPTY;
  private stale = true;

  constructor(private readonly ctx: Context) {}

  /** Everything this device can read, newest first. Stable between changes. */
  list(): readonly StatusView[] {
    return this.cache;
  }

  /** Re-read the server's listing and decrypt what this device holds a key for. */
  async refresh(): Promise<void> {
    const { ctx } = this;
    const answer = await ctx.http.request({
      method: "GET",
      path: "/v1/statuses",
      schema: listStatusesResponseSchema,
      signer: ctx.signer,
    });

    const next = new Map<string, Held>();
    for (const status of answer.statuses) {
      const already = this.held.get(status.id);
      if (already) {
        next.set(status.id, already);
        continue;
      }
      try {
        const held = await this.open(status);
        if (held) next.set(status.id, held);
      } catch (error) {
        // One status nobody can open must not stop the rest being drawn.
        ctx.log.debug?.("status could not be opened", { error: describeError(error) });
      }
    }
    this.held = next;
    this.invalidate();
  }

  /** The socket said somebody posted. */
  onPosted(): void {
    this.stale = true;
    void this.refresh().catch((error) => this.ctx.log.debug?.("status refresh failed", { error: describeError(error) }));
  }

  /**
   * Post one.
   *
   * The audience is resolved HERE, from the conversations this device is in.
   * `all` means every account it shares one with; `only` and `except` narrow
   * that. An account with no reachable device is simply not sealed to, and the
   * server names anybody it refused so the app can say so.
   */
  async post(draft: StatusDraft): Promise<string> {
    const { ctx } = this;
    if (draft.kind === "text" && !draft.caption) throw new InvalidStateError("a text status needs words");
    if (draft.kind !== "text" && !draft.media) throw new InvalidStateError("a picture status needs a picture");

    const key = randomBytes(32);
    const media = draft.media ? await this.uploadMedia(draft.media) : null;
    const envelope = utf8Encode(
      JSON.stringify(
        statusPayloadSchema.parse({
          v: STATUS_PAYLOAD_VERSION,
          kind: draft.kind,
          ...(draft.caption ? { caption: draft.caption } : {}),
          ...(media ? { media } : {}),
        }),
      ),
    );
    const sealedEnvelope = encryptBytes(key, envelope);
    const digest = sha256Hex(sealedEnvelope.ciphertext);

    const id = uuidV7(ctx.now());
    const expiresAt = new Date(ctx.now() + STATUS_LIFETIME_MS - 1000).toISOString();
    const recipients = await this.sealTo(await this.audienceOf(draft.audience), key);
    if (recipients.length === 0) throw new InvalidStateError("nobody to post to");

    const signature = signUtf8(
      ctx.signer.key,
      statusSignatureMessage({ statusId: id, authorAccountId: ctx.accountId, sha256: digest, expiresAt }),
    );

    const answer = await ctx.http.request({
      method: "POST",
      path: "/v1/statuses",
      body: {
        id,
        idempotencyKey: id,
        payload: base64Encode(sealedEnvelope.ciphertext),
        nonce: base64Encode(sealedEnvelope.nonce),
        sha256: digest,
        blobIds: media ? [media.blobId] : [],
        recipients,
        expiresAt,
        signature,
      },
      schema: createStatusResponseSchema,
      signer: ctx.signer,
    });

    // The author's own copy: decrypted here rather than re-read, because the
    // key is in hand and a round trip would only prove the server kept it.
    this.held.set(answer.status.id, {
      view: this.viewOf(answer.status, { kind: draft.kind, caption: draft.caption, media }, true),
      media,
    });
    this.invalidate();
    return answer.status.id;
  }

  /** Somebody looked at it. Whether their name travels is their own setting, decided by the server. */
  async view(statusId: string): Promise<void> {
    const { ctx } = this;
    const held = this.held.get(statusId);
    if (!held || held.view.mine) return;
    await ctx.http.request({ method: "POST", path: `/v1/statuses/${statusId}/views`, signer: ctx.signer });
    if (held.view.seen) return;
    this.held.set(statusId, { ...held, view: { ...held.view, seen: true } });
    this.invalidate();
  }

  /** Who saw one of yours. The author's question; the server refuses it from anybody else. */
  async viewers(statusId: string): Promise<StatusViewerView> {
    const answer = await this.ctx.http.request({
      method: "GET",
      path: `/v1/statuses/${statusId}/views`,
      schema: listStatusViewsResponseSchema,
      signer: this.ctx.signer,
    });
    return { accounts: answer.views.map((view) => view.accountId), total: answer.total };
  }

  /** Take one of yours down before its deadline. */
  async remove(statusId: string): Promise<void> {
    await this.ctx.http.request({ method: "DELETE", path: `/v1/statuses/${statusId}`, signer: this.ctx.signer });
    this.held.delete(statusId);
    this.invalidate();
  }

  /** The picture or video, decrypted. Fetched on demand: a list of statuses downloads nothing. */
  async media(statusId: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const held = this.held.get(statusId);
    if (!held?.media) throw new NotFoundError("no media for this status");
    const ciphertext = await this.ctx.http.request<Uint8Array>({
      method: "GET",
      path: `/v1/blobs/${held.media.blobId}`,
      binary: true,
      signer: this.ctx.signer,
      signal: options.signal,
    });
    if (sha256Hex(ciphertext) !== held.media.sha256) throw new InvalidStateError("status media failed its digest");
    return decryptBytes(base64Decode(held.media.key), base64Decode(held.media.nonce), ciphertext);
  }

  /** Called once the client is active, and whenever the socket reconnects. */
  start(): void {
    if (!this.stale) return;
    this.stale = false;
    void this.refresh().catch((error) => this.ctx.log.debug?.("status refresh failed", { error: describeError(error) }));
  }

  stop(): void {
    this.held.clear();
    this.cache = EMPTY;
    this.stale = true;
  }

  // ---- the parts ------------------------------------------------------------

  /** Every account this device shares a conversation with, narrowed by the audience. */
  private async audienceOf(audience: StatusAudience): Promise<string[]> {
    const { ctx } = this;
    const everyone = new Set<string>();
    for (const conversation of ctx.conversations.list()) {
      for (const accountId of conversation.memberAccountIds) {
        if (accountId !== ctx.accountId) everyone.add(accountId);
      }
    }
    if (audience.mode === "only") return audience.accountIds.filter((id) => everyone.has(id));
    if (audience.mode === "except") return [...everyone].filter((id) => !audience.accountIds.includes(id));
    return [...everyone];
  }

  /**
   * The key, sealed to every trusted device of every account in the audience —
   * and to this account's OWN other devices, so a status shows on the phone
   * that did not post it.
   */
  private async sealTo(accountIds: readonly string[], key: Uint8Array): Promise<{ instanceId: string; sealedKey: string }[]> {
    const { ctx } = this;
    const recipients: { instanceId: string; sealedKey: string }[] = [];
    for (const accountId of [...new Set([...accountIds, ctx.accountId])]) {
      const { trusted } = await ctx.instance.trustedInstancesOf(accountId);
      for (const instance of trusted) {
        if (instance.id === ctx.instanceId || !instance.transferPublicKey) continue;
        recipients.push({
          instanceId: instance.id,
          sealedKey: base64Encode(await sealTo(base64Decode(instance.transferPublicKey), key, STATUS_KEY_SEAL_INFO)),
        });
      }
    }
    return recipients;
  }

  private async uploadMedia(input: NonNullable<StatusDraft["media"]>): Promise<StatusMedia> {
    const key = randomBytes(32);
    const { ciphertext, nonce } = encryptBytes(key, input.bytes);
    const blobId = await uploadEncryptedBlob(this.ctx, ciphertext);
    return {
      blobId,
      key: base64Encode(key),
      nonce: base64Encode(nonce),
      sha256: sha256Hex(ciphertext),
      mime: input.mime,
      size: input.bytes.length,
      ...(input.width === undefined ? {} : { width: input.width }),
      ...(input.height === undefined ? {} : { height: input.height }),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    };
  }

  /** Verify, then decrypt. A status that fails either is not shown at all. */
  private async open(status: Status): Promise<Held | null> {
    const { ctx } = this;
    const mine = status.authorAccountId === ctx.accountId;
    if (!status.sealedKey) return null; // not sealed to this device: nothing to open

    const { trusted } = await ctx.instance.trustedInstancesOf(status.authorAccountId);
    const author = trusted.find((instance) => instance.id === status.authorInstanceId);
    if (!author) return null; // an instance whose chain does not check out wrote it, or the server invented one

    const signed = statusSignatureMessage({
      statusId: status.id,
      authorAccountId: status.authorAccountId,
      sha256: status.sha256,
      expiresAt: status.expiresAt,
    });
    if (!verifyEd25519(author.signingPublicKey, signed, status.signature)) return null;

    const ciphertext = base64Decode(status.payload);
    if (sha256Hex(ciphertext) !== status.sha256) return null;

    const key = await openWith(ctx.instance.transferSecretKey, base64Decode(status.sealedKey), STATUS_KEY_SEAL_INFO);
    const plaintext = decryptBytes(key, base64Decode(status.nonce), ciphertext);
    const parsed = statusPayloadSchema.safeParse(JSON.parse(utf8Decode(plaintext)));
    // A version this build does not know shows nothing rather than guessing.
    if (!parsed.success) return null;

    return {
      view: this.viewOf(status, parsed.data, mine),
      media: parsed.data.media ?? null,
    };
  }

  private viewOf(
    status: Status,
    payload: { kind: StatusView["kind"]; caption?: string; media?: StatusMedia | null },
    mine: boolean,
  ): StatusView {
    return Object.freeze({
      id: status.id,
      authorAccountId: status.authorAccountId,
      kind: payload.kind,
      caption: payload.caption,
      hasMedia: Boolean(payload.media),
      createdAt: status.createdAt,
      expiresAt: status.expiresAt,
      mine,
      seen: mine,
    });
  }

  private invalidate(): void {
    const now = this.ctx.now();
    // A status past its deadline is gone here the moment it is, whatever the
    // server still has: the deadline is the promise, not the row.
    const live = [...this.held.values()].filter((held) => new Date(held.view.expiresAt).getTime() > now);
    this.cache = Object.freeze(
      live.map((held) => held.view).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
    );
    this.ctx.emitter.emit("statuses");
  }
}
