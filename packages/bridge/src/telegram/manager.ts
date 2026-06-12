import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, type NewMessageEvent } from "telegram/events";
import { EditedMessage, type EditedMessageEvent } from "telegram/events/EditedMessage";
import { DeletedMessage, type DeletedMessageEvent } from "telegram/events/DeletedMessage";
import { LogLevel } from "telegram/extensions/Logger";
import { getPeerId, getDisplayName } from "telegram/Utils";
import type { BridgeExternalSelf, BridgeLinkStepResult, BridgeMediaRef } from "@allo/shared-types";
import {
  getTelegramApiCredentials,
  computeReconnectBackoffMs,
  LOGIN_ATTEMPT_TTL_MS,
  RECONNECT_BACKOFF_CAP_MS,
  FLOOD_WAIT_LOOP_RETRY_CAP_MS,
} from "../config";
import { logger } from "../logger";
import { Deferred } from "../deferred";
import * as sessionStore from "../sessionStore";
import type { ExternalSelf } from "../models/BridgeSession";
import * as alloClient from "../alloClient";
import {
  buildMessageEvent,
  buildEditEvent,
  buildDeleteEvent,
  buildSendResultEvent,
  buildSessionStatusEvent,
  toBridgeExternalSelf,
  type NormalizableMessage,
} from "./normalize";
import { detectFloodWait } from "./floodWait";

/**
 * TelegramManager — owns one gramjs `TelegramClient` per linked Allo user and the
 * full lifecycle around it: login (QR + phone/code/2FA), lazy connect/reconnect
 * with backoff, inbound event handling (new/edit/delete → normalized BridgeEvent
 * → signed POST to Allo), and outbound sends.
 *
 * Telegram credentials (`TELEGRAM_API_ID`/`TELEGRAM_API_HASH`) are REQUIRED for
 * any login; without them every session op fails with `telegram_not_configured`,
 * but the manager (and the whole connector) still BOOTS — health stays green.
 *
 * Hygiene: never logs message bodies, session strings, codes, or passwords.
 */

/** gramjs reconnect attempts within the client before it gives up a connect. */
const CLIENT_CONNECTION_RETRIES = 5;

/** Wire protocol version literal for the link-step contract. */
const LINK_PROTOCOL_V = 1 as const;

/** Error thrown when Telegram credentials are not configured. */
export class TelegramNotConfiguredError extends Error {
  constructor() {
    super("telegram_not_configured");
    this.name = "TelegramNotConfiguredError";
  }
}

/**
 * Error thrown by the send path when Telegram returns a FLOOD_WAIT. Carries the
 * wait hint (seconds) so the command handler can decide whether the failure is
 * RETRYABLE (let Allo's outbox back off and resend) or terminal (the wait exceeds
 * the retryable cap, so report a failed send_result).
 */
export class SendFloodWaitError extends Error {
  constructor(public readonly seconds: number) {
    super(`flood_wait_${seconds}`);
    this.name = "SendFloodWaitError";
  }
}

/**
 * The terminal outcome of a background login flow (QR or phone), surfaced to the
 * HTTP handler that is waiting on the next step. `active` carries the user's
 * external identity; `needs_password` means the 2FA step is required next;
 * `error` carries a non-secret reason.
 */
type LoginOutcome =
  | { kind: "active"; externalSelf: BridgeExternalSelf }
  | { kind: "needs_password" }
  | { kind: "error"; error: string };

/**
 * State for an in-progress phone login. gramjs's `client.start` is callback-
 * driven: it calls `phoneCode`/`password` callbacks and BLOCKS until they
 * resolve. We bridge that to a request/response API by parking deferred promises
 * the HTTP handlers resolve when the user submits a code/password.
 *
 * `outcome` is the single source of truth a submit handler awaits — it is settled
 * exactly once (active / needs_password / error) by the background flow, via the
 * idempotent {@link Deferred}, so there is no macrotask-timing race.
 */
interface PhoneLoginAttempt {
  client: TelegramClient;
  /** Resolve to deliver the submitted code into gramjs's `phoneCode` callback. */
  resolveCode?: (code: string) => void;
  /** Resolve to deliver the submitted 2FA password into the `password` callback. */
  resolvePassword?: (password: string) => void;
  /** Settled once gramjs asks for the 2FA password (so submitCode can report it). */
  passwordRequested: Deferred<void>;
  /** Settled once the flow reaches a terminal-for-this-step outcome. */
  outcome: Deferred<LoginOutcome>;
  createdAt: number;
}

/** State for an in-progress QR login (background `signInUserWithQrCode`). */
interface QrLoginAttempt {
  client: TelegramClient;
  /** Settled with the first `tg://login` URL, or rejected if the flow fails early. */
  firstUrl: Deferred<string>;
  createdAt: number;
}

/** A live, connected client plus its handler refs (for clean teardown). */
interface ActiveClient {
  client: TelegramClient;
  externalSelfId: string;
}

export class TelegramManager {
  private readonly clients = new Map<string, ActiveClient>();
  private readonly phoneLogins = new Map<string, PhoneLoginAttempt>();
  private readonly qrLogins = new Map<string, QrLoginAttempt>();
  /** Owners with a connect in flight, to avoid duplicate concurrent connects. */
  private readonly connecting = new Set<string>();

  /** True when `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` are both configured. */
  isConfigured(): boolean {
    return getTelegramApiCredentials() !== null;
  }

  /** Resolve credentials or throw `TelegramNotConfiguredError`. */
  private requireCredentials(): { apiId: number; apiHash: string } {
    const creds = getTelegramApiCredentials();
    if (!creds) throw new TelegramNotConfiguredError();
    return creds;
  }

  /** Build a fresh, silenced gramjs client over the given (possibly empty) session. */
  private buildClient(sessionString: string): TelegramClient {
    const { apiId, apiHash } = this.requireCredentials();
    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
      connectionRetries: CLIENT_CONNECTION_RETRIES,
    });
    // Silence gramjs's own verbose logging — it logs raw update payloads at debug
    // level, which would leak message content into our logs.
    client.setLogLevel(LogLevel.NONE);
    return client;
  }

  /**
   * Begin linking via QR. Starts `signInUserWithQrCode` in the BACKGROUND (it
   * blocks until the user scans or the token expires) and returns a `pending`
   * link step carrying the `tg://login?token=...` URL captured from the first
   * qrCode callback. On success the session is persisted, the client is wired for
   * inbound events, and a `session_status: active` event (with externalSelf) is
   * pushed to Allo.
   */
  async startQrLogin(ownerUserId: string): Promise<BridgeLinkStepResult> {
    this.requireCredentials();
    await this.abandonLogin(ownerUserId);
    await sessionStore.markPending(ownerUserId);

    const client = this.buildClient("");
    await client.connect();

    // The qrCode callback fires (possibly multiple times as the token refreshes);
    // the Deferred settles on the FIRST token so the HTTP handler can return it,
    // and is idempotent: a later failure rejects it only if it hasn't resolved,
    // and teardown can `cancel()` it without risk of a double-settle.
    const firstUrl = new Deferred<string>();
    this.qrLogins.set(ownerUserId, { client, firstUrl, createdAt: Date.now() });

    const creds = this.requireCredentials();
    void client
      .signInUserWithQrCode(
        { apiId: creds.apiId, apiHash: creds.apiHash },
        {
          qrCode: async (code: { token: Buffer; expires: number }) => {
            const token = code.token.toString("base64url");
            firstUrl.resolve(`tg://login?token=${token}`);
          },
          onError: async (err: Error): Promise<boolean> => {
            logger.error(`QR login error for owner ${ownerUserId}`, err);
            // Returning true stops gramjs retrying the QR flow.
            return true;
          },
        }
      )
      .then(async (user: Api.TypeUser) => {
        await this.onLoginSuccess(ownerUserId, client, user);
      })
      .catch(async (err: unknown) => {
        logger.error(`QR login failed for owner ${ownerUserId}`, err as Error);
        // If we never produced a QR URL, reject the awaiting handler instead of
        // letting it hang forever (idempotent no-op if the URL was already sent).
        firstUrl.reject(err instanceof Error ? err : new Error("qr_login_failed"));
        await this.failLogin(ownerUserId);
      })
      .finally(() => {
        // Only drop the attempt if THIS attempt is still the registered one (a
        // re-link could have replaced it); never tear down a newer attempt.
        if (this.qrLogins.get(ownerUserId)?.firstUrl === firstUrl) {
          this.qrLogins.delete(ownerUserId);
        }
      });

    const loginUrl = await firstUrl.promise;
    return { v: LINK_PROTOCOL_V, status: "pending", loginUrl };
  }

  /**
   * Begin linking via phone number. Starts `client.start` in the background; it
   * blocks on the `phoneCode`/`password` callbacks, which we resolve when the
   * user submits via `submitCode`/`submitPassword`. Returns `needs_code` once
   * Telegram has been asked to send the code.
   */
  async startPhoneLogin(ownerUserId: string, phoneNumber: string): Promise<BridgeLinkStepResult> {
    this.requireCredentials();
    await this.abandonLogin(ownerUserId);
    await sessionStore.markPending(ownerUserId);

    const client = this.buildClient("");
    const attempt: PhoneLoginAttempt = {
      client,
      passwordRequested: new Deferred<void>(),
      outcome: new Deferred<LoginOutcome>(),
      createdAt: Date.now(),
    };
    this.phoneLogins.set(ownerUserId, attempt);

    // Settles once gramjs has requested the code (so the HTTP handler returns).
    const codeRequested = new Deferred<void>();

    void client
      .start({
        phoneNumber: async () => phoneNumber,
        phoneCode: async () =>
          new Promise<string>((resolve) => {
            attempt.resolveCode = resolve;
            // gramjs has sent the code and is now awaiting it.
            codeRequested.resolve();
          }),
        password: async () =>
          new Promise<string>((resolve) => {
            attempt.resolvePassword = resolve;
            // gramjs is now asking for the 2FA password; let submitCode report it.
            attempt.passwordRequested.resolve();
          }),
        onError: async (err: Error): Promise<boolean> => {
          logger.error(`Phone login error for owner ${ownerUserId}`, err);
          // Returning true stops gramjs's retry loop and surfaces the failure to
          // our `.catch` below, which marks the login failed. A wrong code/2FA is
          // terminal here — the user restarts the link rather than gramjs
          // re-invoking our (now-empty) code/password callbacks.
          return true;
        },
      })
      .then(async () => {
        // getMe() resolves to Api.User, which is a member of Api.TypeUser.
        const me = await client.getMe();
        const self = await this.onLoginSuccess(ownerUserId, client, me);
        attempt.outcome.resolve({ kind: "active", externalSelf: self });
      })
      .catch(async (err: unknown) => {
        logger.error(`Phone login failed for owner ${ownerUserId}`, err as Error);
        await this.failLogin(ownerUserId);
        attempt.outcome.resolve({ kind: "error", error: "login_failed" });
      })
      .finally(() => {
        // Settle anything still pending (idempotent) so no awaiter can hang, then
        // drop the attempt — but only if it's still the registered one.
        codeRequested.cancel(new Error("phone_login_ended"));
        attempt.passwordRequested.cancel(new Error("phone_login_ended"));
        attempt.outcome.resolve({ kind: "error", error: "login_failed" });
        if (this.phoneLogins.get(ownerUserId) === attempt) {
          this.phoneLogins.delete(ownerUserId);
        }
      });

    await codeRequested.promise;
    return { v: LINK_PROTOCOL_V, status: "needs_code" };
  }

  /** Submit a login code for a pending phone login. */
  async submitCode(ownerUserId: string, code: string): Promise<BridgeLinkStepResult> {
    const attempt = this.phoneLogins.get(ownerUserId);
    if (!attempt || !attempt.resolveCode) {
      return { v: LINK_PROTOCOL_V, status: "pending" };
    }
    const deliver = attempt.resolveCode;
    attempt.resolveCode = undefined;
    deliver(code);

    // After the code, gramjs either finishes (active) or asks for the 2FA
    // password. Race the terminal outcome against the password-requested signal —
    // both are idempotent Deferreds, so whichever happens first wins deterministically
    // (no macrotask-timing guesswork).
    const result = await Promise.race([
      attempt.outcome.promise.then((o): LoginOutcome => o),
      attempt.passwordRequested.promise.then(
        (): LoginOutcome => ({ kind: "needs_password" })
      ),
    ]).catch((): LoginOutcome => ({ kind: "error", error: "login_failed" }));

    return this.outcomeToStep(result);
  }

  /** Submit a 2FA password for a pending phone login. */
  async submitPassword(ownerUserId: string, password: string): Promise<BridgeLinkStepResult> {
    const attempt = this.phoneLogins.get(ownerUserId);
    if (!attempt || !attempt.resolvePassword) {
      return { v: LINK_PROTOCOL_V, status: "pending" };
    }
    const deliver = attempt.resolvePassword;
    attempt.resolvePassword = undefined;
    deliver(password);

    const result = await attempt.outcome.promise.catch(
      (): LoginOutcome => ({ kind: "error", error: "login_failed" })
    );
    return this.outcomeToStep(result);
  }

  /** Map an internal login outcome to the canonical wire link-step result. */
  private outcomeToStep(outcome: LoginOutcome): BridgeLinkStepResult {
    switch (outcome.kind) {
      case "active":
        return { v: LINK_PROTOCOL_V, status: "active", externalSelf: outcome.externalSelf };
      case "needs_password":
        return { v: LINK_PROTOCOL_V, status: "needs_password" };
      default:
        return { v: LINK_PROTOCOL_V, status: "error", error: outcome.error };
    }
  }

  /**
   * Persist a freshly authorized session, register the client for inbound events,
   * and notify Allo that the account is active (with the user's external identity
   * so the backend can persist `LinkedAccount.externalSelf`). Returns the wire
   * `BridgeExternalSelf`. Shared by QR and phone flows.
   */
  private async onLoginSuccess(
    ownerUserId: string,
    client: TelegramClient,
    user: Api.TypeUser
  ): Promise<BridgeExternalSelf> {
    const sessionString = (client.session as StringSession).save();
    const self = this.extractSelf(user);
    await sessionStore.saveActive(ownerUserId, sessionString, self);
    this.registerClient(ownerUserId, client, self.id);
    const wireSelf = toBridgeExternalSelf(self);
    await alloClient.postEvent(buildSessionStatusEvent(ownerUserId, "active", wireSelf));
    logger.info(`Telegram session activated for owner ${ownerUserId}`);
    return wireSelf;
  }

  /** Mark a failed login locally and notify Allo. */
  private async failLogin(ownerUserId: string): Promise<void> {
    await sessionStore.setStatus(ownerUserId, "error");
    await alloClient.postEvent(buildSessionStatusEvent(ownerUserId, "error"));
  }

  /** Map a Telegram user object to our stored `externalSelf`. */
  private extractSelf(user: Api.TypeUser): ExternalSelf {
    if (user instanceof Api.User) {
      return {
        id: user.id.toString(),
        username: user.username,
        firstName: user.firstName,
        phone: user.phone,
      };
    }
    // Api.UserEmpty (no profile fields) — only an id is available.
    return { id: (user as Api.UserEmpty).id.toString() };
  }

  /**
   * Lazily connect a stored session and register it for inbound events. Returns
   * the connected client, or null when there is no active stored session (or
   * Telegram is not configured). Reconnects with backoff on transient failures.
   */
  async ensureConnected(ownerUserId: string): Promise<TelegramClient | null> {
    const existing = this.clients.get(ownerUserId);
    if (existing) return existing.client;
    if (!this.isConfigured()) return null;
    if (this.connecting.has(ownerUserId)) return null;

    const loaded = await sessionStore.load(ownerUserId);
    if (!loaded || loaded.status !== "active" || !loaded.sessionString) {
      return null;
    }

    this.connecting.add(ownerUserId);
    try {
      const client = await this.connectWithBackoff(ownerUserId, loaded.sessionString);
      if (!client) return null;
      const self = loaded.externalSelf?.id ?? "";
      this.registerClient(ownerUserId, client, self);
      return client;
    } finally {
      this.connecting.delete(ownerUserId);
    }
  }

  /** Connect a session string, retrying transient failures with backoff. */
  private async connectWithBackoff(
    ownerUserId: string,
    sessionString: string
  ): Promise<TelegramClient | null> {
    let attempts = 0;
    // Bound the total attempts so a permanently-broken session doesn't loop;
    // after the cap the session is marked expired and the owner must re-link.
    const maxAttempts = 4;
    while (attempts < maxAttempts) {
      const client = this.buildClient(sessionString);
      try {
        await client.connect();
        const authorized = await client.isUserAuthorized();
        if (!authorized) {
          await this.markExpired(ownerUserId);
          await client.destroy().catch(() => undefined);
          return null;
        }
        return client;
      } catch (error) {
        attempts += 1;
        await client.destroy().catch(() => undefined);

        // A FLOOD_WAIT during connect is rate-limiting, NOT a broken session: do
        // not mark it expired. Back off for the hinted seconds (capped so a flood
        // can't wedge the connect loop), then retry. It still counts as an
        // attempt so a persistent flood eventually gives up.
        const flood = detectFloodWait(error);
        if (flood) {
          logger.warn(
            `Connect for owner ${ownerUserId} hit FLOOD_WAIT (${flood.seconds}s); waiting then retrying`
          );
          if (attempts >= maxAttempts) {
            logger.error(`Giving up connecting owner ${ownerUserId} after ${attempts} flood-limited attempts`);
            return null;
          }
          await this.sleep(this.floodWaitMs(flood.seconds));
          continue;
        }

        logger.warn(
          `Connect attempt ${attempts} failed for owner ${ownerUserId}; backing off`
        );
        if (attempts >= maxAttempts) {
          logger.error(`Giving up connecting owner ${ownerUserId} after ${attempts} attempts`, error as Error);
          await this.markExpired(ownerUserId);
          return null;
        }
        await this.sleep(computeReconnectBackoffMs(attempts));
      }
    }
    return null;
  }

  /** Convert a FLOOD_WAIT `seconds` hint to a bounded ms delay for loop retries. */
  private floodWaitMs(seconds: number): number {
    const ms = Math.max(0, seconds) * 1000;
    return Math.min(ms, FLOOD_WAIT_LOOP_RETRY_CAP_MS);
  }

  /** Mark a session expired locally and notify Allo. */
  private async markExpired(ownerUserId: string): Promise<void> {
    await sessionStore.setStatus(ownerUserId, "expired");
    await alloClient.postEvent(buildSessionStatusEvent(ownerUserId, "expired"));
  }

  /** Register a connected client and attach inbound new/edit/delete handlers. */
  private registerClient(ownerUserId: string, client: TelegramClient, externalSelfId: string): void {
    this.clients.set(ownerUserId, { client, externalSelfId });

    client.addEventHandler((event: NewMessageEvent) => {
      void this.handleNewMessage(ownerUserId, event);
    }, new NewMessage({}));

    client.addEventHandler((event: EditedMessageEvent) => {
      void this.handleEditedMessage(ownerUserId, event);
    }, new EditedMessage({}));

    client.addEventHandler((event: DeletedMessageEvent) => {
      void this.handleDeletedMessage(ownerUserId, event);
    }, new DeletedMessage({}));
  }

  /**
   * Run an inbound-event handler body, absorbing errors so a single bad event can
   * NEVER crash the client's event loop. If the body throws a FLOOD_WAIT (e.g. an
   * enrichment RPC was rate-limited), wait the hinted (capped) seconds and retry
   * ONCE rather than dropping the event; any non-flood error (or a second flood)
   * is logged and swallowed. `label` is for logging only (never message content).
   */
  private async runEventBodyWithFloodRetry(
    ownerUserId: string,
    label: string,
    body: () => Promise<void>
  ): Promise<void> {
    try {
      await body();
    } catch (error) {
      const flood = detectFloodWait(error);
      if (!flood) {
        logger.error(`Failed to handle Telegram ${label} for owner ${ownerUserId}`, error as Error);
        return;
      }
      logger.warn(
        `Telegram ${label} for owner ${ownerUserId} hit FLOOD_WAIT (${flood.seconds}s); scheduling one retry`
      );
      await this.sleep(this.floodWaitMs(flood.seconds));
      try {
        await body();
      } catch (retryError) {
        logger.error(
          `Telegram ${label} for owner ${ownerUserId} failed again after FLOOD_WAIT; dropping`,
          retryError as Error
        );
      }
    }
  }

  /**
   * Handle an inbound new message: skip our OWN outgoing echoes (`message.out` —
   * those are confirmed via send_result correlation, not re-ingested), resolve
   * ids + sender, re-host any media, normalize, and POST to Allo.
   */
  private async handleNewMessage(ownerUserId: string, event: NewMessageEvent): Promise<void> {
    await this.runEventBodyWithFloodRetry(ownerUserId, "message", async () => {
      const message = event.message;
      if (message.out) return; // own outgoing — confirmed via send_result instead

      const normalizable = await this.toNormalizable(ownerUserId, message);
      if (!normalizable) return;
      const bridgeEvent = buildMessageEvent(ownerUserId, normalizable);
      if (!bridgeEvent) return;
      await alloClient.postEvent(bridgeEvent);
    });
  }

  /** Handle an inbound edit: re-host media if present, normalize, POST to Allo. */
  private async handleEditedMessage(ownerUserId: string, event: EditedMessageEvent): Promise<void> {
    await this.runEventBodyWithFloodRetry(ownerUserId, "edit", async () => {
      const message = event.message;
      if (message.out) return;
      const normalizable = await this.toNormalizable(ownerUserId, message);
      if (!normalizable) return;
      await alloClient.postEvent(buildEditEvent(ownerUserId, normalizable));
    });
  }

  /**
   * Handle inbound delete(s). Telegram's delete update carries message ids and
   * SOMETIMES the peer; when the peer is absent the chat is unknown, so we cannot
   * scope the delete and skip it (Allo dedups deletes by chat+message id).
   */
  private async handleDeletedMessage(ownerUserId: string, event: DeletedMessageEvent): Promise<void> {
    try {
      if (!event.peer) return;
      const externalChatId = getPeerId(event.peer);
      for (const deletedId of event.deletedIds) {
        await alloClient.postEvent(buildDeleteEvent(ownerUserId, externalChatId, deletedId));
      }
    } catch (error) {
      logger.error(`Failed to handle Telegram delete for owner ${ownerUserId}`, error as Error);
    }
  }

  /**
   * Resolve a gramjs message into the pure-normalizable shape, including media
   * re-hosting and sender enrichment. Returns null when the message should be
   * dropped (no usable content/sender/chat).
   */
  private async toNormalizable(
    ownerUserId: string,
    message: Api.Message
  ): Promise<NormalizableMessage | null> {
    const externalChatId = this.resolveChatId(message);
    if (!externalChatId) return null;
    const externalSenderId = this.resolveSenderId(message);
    if (!externalSenderId) return null;

    const media = await this.rehostMedia(ownerUserId, message);
    const sender = await this.resolveSenderProfile(ownerUserId, message);

    return {
      id: message.id,
      externalChatId,
      externalSenderId,
      text: message.text,
      dateSeconds: message.date,
      media,
      senderDisplayName: sender.displayName,
      senderUsername: sender.username,
    };
  }

  /** Resolve the external chat id (peer id) as a string, or null. */
  private resolveChatId(message: Api.Message): string | null {
    try {
      return getPeerId(message.peerId);
    } catch {
      return null;
    }
  }

  /** Resolve the external sender id as a string, or null. */
  private resolveSenderId(message: Api.Message): string | null {
    const senderId = message.senderId;
    if (!senderId) return null;
    return senderId.toString();
  }

  /** Best-effort sender display name + username (failures are non-fatal). */
  private async resolveSenderProfile(
    ownerUserId: string,
    message: Api.Message
  ): Promise<{ displayName?: string; username?: string }> {
    const active = this.clients.get(ownerUserId);
    if (!active || !message.senderId) return {};
    try {
      const entity = await active.client.getEntity(message.senderId);
      const username = entity instanceof Api.User ? entity.username : undefined;
      return { displayName: getDisplayName(entity), username };
    } catch {
      // Enrichment is optional; Allo upserts the contact with whatever we have.
      return {};
    }
  }

  /**
   * If the message carries media, download it and re-host on Allo, returning a
   * single-element `BridgeMediaRef[]`. Returns undefined when there is no media
   * or the download/upload failed (the message still flows as text-only).
   */
  private async rehostMedia(
    ownerUserId: string,
    message: Api.Message
  ): Promise<BridgeMediaRef[] | undefined> {
    const mediaType = this.classifyMedia(message);
    if (!mediaType) return undefined;

    const active = this.clients.get(ownerUserId);
    if (!active) return undefined;

    try {
      const downloaded = await message.downloadMedia({});
      if (!downloaded || typeof downloaded === "string") return undefined;
      const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded);
      const file = message.file;
      const ref = await alloClient.uploadMedia({
        buffer,
        fileName: this.deriveFileName(message, mediaType),
        mimeType: file?.mimeType ?? this.defaultMime(mediaType),
        type: mediaType,
        width: this.toNumber(file?.width),
        height: this.toNumber(file?.height),
        duration: this.toNumber(file?.duration),
      });
      return ref ? [ref] : undefined;
    } catch (error) {
      logger.error(`Failed to re-host Telegram media for owner ${ownerUserId}`, error as Error);
      return undefined;
    }
  }

  /** Map gramjs media getters to a `BridgeMediaRef` type, or null for none/unsupported. */
  private classifyMedia(message: Api.Message): BridgeMediaRef["type"] | null {
    if (message.photo) return "image";
    if (message.gif) return "gif";
    if (message.video || message.videoNote) return "video";
    if (message.voice || message.audio) return "audio";
    if (message.document) return "file";
    return null;
  }

  /** A safe download filename derived from the message id + media type. */
  private deriveFileName(message: Api.Message, type: BridgeMediaRef["type"]): string {
    const fromFile = message.file?.name;
    if (typeof fromFile === "string" && fromFile.length > 0) return fromFile;
    const extByType: Record<BridgeMediaRef["type"], string> = {
      image: "jpg",
      video: "mp4",
      audio: "ogg",
      gif: "mp4",
      file: "bin",
    };
    return `tg-${message.id}.${extByType[type]}`;
  }

  /** Default MIME for a media type when gramjs doesn't report one. */
  private defaultMime(type: BridgeMediaRef["type"]): string {
    const map: Record<BridgeMediaRef["type"], string> = {
      image: "image/jpeg",
      video: "video/mp4",
      audio: "audio/ogg",
      gif: "video/mp4",
      file: "application/octet-stream",
    };
    return map[type];
  }

  /** Coerce gramjs's loosely-typed numeric getters to a finite number or undefined. */
  private toNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return undefined;
  }

  /**
   * Send an outbound message to an external chat on behalf of an owner. Resolves
   * the connected client and the target entity, sends, and returns the resulting
   * Telegram message id for `send_result` correlation.
   *
   * Throws on failure so the caller fires a failed `send_result`. A Telegram
   * FLOOD_WAIT is translated into a typed {@link SendFloodWaitError} (carrying the
   * wait hint) so the command handler can treat it as retryable vs terminal; any
   * other failure throws a plain Error.
   */
  async sendMessage(params: {
    ownerUserId: string;
    externalChatId: string;
    text?: string;
    media?: BridgeMediaRef[];
  }): Promise<{ externalMessageId: string }> {
    const client = await this.ensureConnected(params.ownerUserId);
    if (!client) {
      throw new Error("no_active_session");
    }
    try {
      const entity = await client.getEntity(params.externalChatId);
      const file = await this.resolveOutboundFile(params.media);
      const sent = await client.sendMessage(entity, {
        message: params.text ?? "",
        file,
      });
      return { externalMessageId: String(sent.id) };
    } catch (error) {
      const flood = detectFloodWait(error);
      if (flood) {
        throw new SendFloodWaitError(flood.seconds);
      }
      throw error;
    }
  }

  /**
   * Fetch outbound media (commanded by Allo as a URL) so gramjs can attach it.
   * Returns the first media's bytes as a Buffer, or undefined for a text-only
   * send. Only the first media is sent (the seam sends one media per message).
   */
  private async resolveOutboundFile(media?: BridgeMediaRef[]): Promise<Buffer | undefined> {
    if (!media || media.length === 0) return undefined;
    const first = media[0];
    try {
      const response = await fetch(first.url);
      if (!response.ok) {
        logger.warn(`Failed to fetch outbound media (${response.status}); sending text only`);
        return undefined;
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      logger.error("Failed to fetch outbound media; sending text only", error as Error);
      return undefined;
    }
  }

  /**
   * Log out at Telegram and purge the stored session. Best-effort at the
   * Telegram side (a network failure still purges locally so the credential is
   * not retained). Notifies Allo with `revoked`.
   */
  async logout(ownerUserId: string): Promise<void> {
    const active = this.clients.get(ownerUserId);
    if (active) {
      try {
        await active.client.invoke(new Api.auth.LogOut());
      } catch (error) {
        logger.warn(`Telegram logout RPC failed for owner ${ownerUserId}; purging locally`);
        void error;
      }
      await active.client.destroy().catch(() => undefined);
      this.clients.delete(ownerUserId);
    }
    await sessionStore.revoke(ownerUserId);
    await alloClient.postEvent(buildSessionStatusEvent(ownerUserId, "revoked"));
  }

  /** Build a `send_result` event (delegates to the pure normalizer). */
  buildSendResult(params: Parameters<typeof buildSendResultEvent>[0]) {
    return buildSendResultEvent(params);
  }

  /** Reason used when a login attempt is torn down before it could complete. */
  private static readonly LOGIN_ABANDONED = "login_abandoned";

  /**
   * Cancel a phone-login attempt's parked Deferreds so no awaiting handler hangs
   * after teardown (review finding 11: never settle after teardown — `cancel()` is
   * idempotent and a no-op if already settled). Then destroy its client.
   */
  private async teardownPhoneAttempt(attempt: PhoneLoginAttempt): Promise<void> {
    const reason = new Error(TelegramManager.LOGIN_ABANDONED);
    attempt.passwordRequested.cancel(reason);
    attempt.outcome.cancel(reason);
    await attempt.client.destroy().catch(() => undefined);
  }

  /**
   * Cancel a QR-login attempt's parked Deferred (idempotent) and destroy its
   * client.
   */
  private async teardownQrAttempt(attempt: QrLoginAttempt): Promise<void> {
    attempt.firstUrl.cancel(new Error(TelegramManager.LOGIN_ABANDONED));
    await attempt.client.destroy().catch(() => undefined);
  }

  /**
   * Abandon any in-flight login for an owner (used before starting a new one).
   * Disconnects the partial client so we don't leak connections, and cancels any
   * parked Deferreds so a stale awaiter can't be settled after teardown.
   */
  private async abandonLogin(ownerUserId: string): Promise<void> {
    const phone = this.phoneLogins.get(ownerUserId);
    if (phone) {
      this.phoneLogins.delete(ownerUserId);
      await this.teardownPhoneAttempt(phone);
    }
    const qr = this.qrLogins.get(ownerUserId);
    if (qr) {
      this.qrLogins.delete(ownerUserId);
      await this.teardownQrAttempt(qr);
    }
  }

  /** Disconnect every client and clear all state (graceful shutdown). */
  async shutdown(): Promise<void> {
    const teardowns: Promise<void>[] = [];
    for (const active of this.clients.values()) {
      teardowns.push(active.client.destroy().catch(() => undefined));
    }
    this.clients.clear();
    for (const attempt of this.phoneLogins.values()) {
      teardowns.push(this.teardownPhoneAttempt(attempt));
    }
    this.phoneLogins.clear();
    for (const attempt of this.qrLogins.values()) {
      teardowns.push(this.teardownQrAttempt(attempt));
    }
    this.qrLogins.clear();
    await Promise.allSettled(teardowns);
  }

  /** Prune login attempts older than the TTL (called periodically). */
  pruneStaleLogins(now: number = Date.now()): void {
    for (const [owner, attempt] of this.phoneLogins) {
      if (now - attempt.createdAt > LOGIN_ATTEMPT_TTL_MS) {
        this.phoneLogins.delete(owner);
        void this.teardownPhoneAttempt(attempt);
      }
    }
    for (const [owner, attempt] of this.qrLogins) {
      if (now - attempt.createdAt > LOGIN_ATTEMPT_TTL_MS) {
        this.qrLogins.delete(owner);
        void this.teardownQrAttempt(attempt);
      }
    }
  }

  /** Promisified sleep, capped so a bug can't request an unbounded wait. */
  private sleep(ms: number): Promise<void> {
    const bounded = Math.min(ms, RECONNECT_BACKOFF_CAP_MS);
    return new Promise((resolve) => setTimeout(resolve, bounded));
  }
}
