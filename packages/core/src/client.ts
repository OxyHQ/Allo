/**
 * `createAlloClient`: wires the modules and owns the lifecycle.
 *
 *   start()  load the account's encrypted store, ensure an instance exists
 *            (register on first run), connect the socket, and — once the
 *            instance is active — top up key packages, pull the server's
 *            conversation list and sync.
 *   stop()   disconnect and stop every loop and timer.
 *   reset()  revoke this instance, then wipe its namespace and its secrets
 *            (signing, storage, transfer and backup keys). For sign-out, and
 *            it reports whether the revoke landed: a wipe that could not tell
 *            the server leaves an instance behind that no device can prove it
 *            owns. Call it while the session is alive.
 *   reclaimAccount()
 *            the way back when the account's only active devices are gone:
 *            revoke them with the Oxy session and register this one afresh.
 */
import { AtRestCipher } from "./crypto/atRest";
import { CryptoEngine } from "./crypto/engine";
import { Context, type ResolvedOptions } from "./context";
import { ConversationsService } from "./conversations/service";
import { GroupRegistry } from "./conversations/groups";
import { InvalidStateError } from "./errors";
import { Emitter } from "./events/emitter";
import { HistoryService } from "./history/service";
import { BackupService } from "./backup/service";
import { transferKeyName } from "./crypto/transfer";
import { backupKeyName } from "./crypto/backupKey";
import { InstanceManager, instanceKeyName } from "./instance/manager";
import { MediaService } from "./media/service";
import { MessagesService } from "./messages/service";
import { OutboxEngine } from "./outbox/engine";
import { AlloStore } from "./storage/store";
import { Model } from "./storage/model";
import { Namespace } from "./storage/namespace";
import { storageKeyName } from "./crypto/atRest";
import { SyncEngine } from "./sync/engine";
import { PresenceService, PRESENCE_UNKNOWN } from "./presence/service";
import { StatusService } from "./statuses/service";
import { Realtime } from "./sync/realtime";
import { HttpClient } from "./transport/http";
import { PRESENCE_HEARTBEAT_MS } from "@allo/shared-types";
import type {
  AlloClientOptions,
  BackupStatus,
  ConversationView,
  HistoryOfferView,
  HistoryProgress,
  PresenceView,
  StatusDraft,
  StatusView,
  StatusViewerView,
  InstanceState,
  InstanceView,
  LoadOlderResult,
  MediaRef,
  PendingEnrollmentView,
  PollDraft,
  PlaceDraft,
  ContactDraft,
  SendOptions,
  SubscriptionTopic,
  SyncState,
  TimelineItemView,
  UploadMediaMeta,
} from "./types";
import { Mutex } from "./util/async";
import { describeError, silentLogger } from "./util/logger";

/**
 * What `reset()` managed to tell the server before it wiped this device.
 *
 * The revoke is the half that needs a live Oxy session, and the wipe is the
 * half that cannot fail. An instance this device can no longer prove it owns —
 * wiped locally, still `active` on the server — is a GHOST: it holds an
 * approval slot nobody can use, and while it is the account's only active
 * instance every new device enrols as `pending` with nothing able to approve
 * it. So the outcome is returned rather than logged: a caller that wipes a
 * device has to be able to say what is still listed.
 */
export type ResetOutcome =
  | { revoked: "done" }
  /** Nothing was active to revoke: never registered, still pending, or already revoked. */
  | { revoked: "not-needed" }
  /** The wipe happened and the server still lists this instance as active. */
  | { revoked: "failed"; instanceId: string; reason: string };

export interface AlloClient {
  readonly accountId: string;
  /** The instance id once registered. */
  readonly instanceId: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Leaves this device: revokes the instance, then wipes its namespace and
   * every secret. Call it while the Oxy session is still alive — the revoke
   * is authenticated with it — and read the outcome; see {@link ResetOutcome}.
   */
  reset(): Promise<ResetOutcome>;
  /**
   * Takes the account over from devices that are gone, and makes THIS one its
   * only device.
   *
   * The way back for somebody who cannot be approved because there is nobody
   * left to approve them: every instance the account still calls `active` is
   * revoked with the Oxy session, this device's local state is wiped, and it
   * registers again — into an account with no active instance, which is the
   * bootstrap case, so it comes back `active`.
   *
   * It is destructive and the screen that offers it has to say so: the other
   * devices are signed out, and history that lives only on them is gone, since
   * nothing here can decrypt what they hold. Everything already on this device
   * is gone too — it was written under keys this wipe removes.
   */
  reclaimAccount(): Promise<void>;
  subscribe(topic: SubscriptionTopic, listener: () => void): () => void;
  onError(listener: (error: unknown) => void): () => void;

  instance: {
    state(): InstanceState;
    current(): InstanceView | null;
    list(): InstanceView[];
    pending(): PendingEnrollmentView[];
    refresh(): Promise<void>;
    refreshPending(): Promise<void>;
    approve(instanceId: string, expectedChallenge?: string): Promise<void>;
    reject(instanceId: string): Promise<void>;
    revoke(instanceId: string): Promise<void>;
    setPushToken(provider: "fcm" | "apns", token: string): Promise<void>;
    clearPushToken(): Promise<void>;
  };
  conversations: {
    list(): ConversationView[];
    get(id: string): ConversationView | undefined;
    createDirect(accountId: string): Promise<ConversationView>;
    createGroup(memberAccountIds: string[]): Promise<ConversationView>;
    addMember(conversationId: string, accountId: string): Promise<void>;
    removeMember(conversationId: string, accountId: string): Promise<void>;
    leave(conversationId: string): Promise<void>;
    rename(conversationId: string, name: string): Promise<void>;
    refresh(): Promise<void>;
  };
  messages: {
    timeline(conversationId: string): TimelineItemView[];
    send(conversationId: string, text: string, options?: SendOptions): Promise<string>;
    /** A poll. Resolves to the local key of the echo. */
    sendPoll(conversationId: string, poll: PollDraft): Promise<string>;
    /** This account's answer, which replaces the one before it; an empty list retracts. */
    vote(conversationId: string, targetId: string, optionIds: readonly string[]): Promise<void>;
    /** A place: the coordinates are the sender's, and nothing is resolved here. */
    sendLocation(conversationId: string, place: PlaceDraft): Promise<string>;
    /** Somebody's card. */
    sendContact(conversationId: string, contact: ContactDraft): Promise<string>;
    /** Pins a message for everybody in the conversation, or takes the pin off. */
    setPinned(conversationId: string, targetId: string, pinned: boolean): Promise<void>;
    edit(conversationId: string, targetId: string, body: string): Promise<void>;
    remove(conversationId: string, targetId: string): Promise<void>;
    react(conversationId: string, targetId: string, key: string): Promise<void>;
    markRead(conversationId: string): Promise<void>;
    /**
     * Deletes this conversation's history on THIS device, and with
     * `forEveryone` asks everybody else in it to do the same.
     *
     * The local half is a real delete. The remote half is a request their app
     * obeys — in an end-to-end encrypted system the other copy is on their
     * device under their keys — and the screen offering it has to say so.
     */
    clearHistory(conversationId: string, options?: { forEveryone?: boolean }): Promise<void>;
    setTyping(conversationId: string, on: boolean): Promise<void>;
    isTyping(conversationId: string): boolean;
    /** `limit` defaults to 50. */
    loadOlder(conversationId: string, before?: string, limit?: number): Promise<LoadOlderResult>;
    unreadCount(conversationId: string): number;
  };
  media: {
    upload(conversationId: string, bytes: Uint8Array, meta: UploadMediaMeta): Promise<string>;
    /** Aborting the signal rejects with the fetch AbortError. */
    download(ref: MediaRef, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  };
  sync: {
    state(): SyncState;
    now(): Promise<void>;
    /** Resolves once the outbox has drained. */
    flush(): Promise<void>;
  };
  /**
   * Who is online, for the accounts this client says it is SHOWING. Topic
   * `presence`. Nothing is persisted and nothing is remembered across a
   * restart: a dot restored from disk is a claim the device cannot make.
   */
  /**
   * Status updates: one ciphertext, a key sealed per device, 24 hours. Topic
   * `statuses`. Nothing is persisted — the deadline is the promise, and a
   * status restored from disk would outlive it.
   */
  statuses: {
    /** Everything this device can read, newest first. Referentially stable between emissions. */
    list(): readonly StatusView[];
    /** Post one. The audience is resolved on this device; the server never sees a contact list. */
    post(draft: StatusDraft): Promise<string>;
    /** Tell the author it was seen. Whether your name travels is your own setting. */
    view(statusId: string): Promise<void>;
    /** Who saw one of YOURS. The server refuses this from anybody else. */
    viewers(statusId: string): Promise<StatusViewerView>;
    /** Take one of yours down before its deadline. */
    remove(statusId: string): Promise<void>;
    /** The picture or video, decrypted. Nothing is fetched until this is called. */
    media(statusId: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
    refresh(): Promise<void>;
  };
  presence: {
    /** The accounts being drawn. Replaces the previous set; an empty one stops the updates. */
    watch(accountIds: readonly string[]): Promise<void>;
    /** Stable between changes. `known: false` until the server has answered for this account. */
    of(accountId: string): PresenceView;
    /**
     * Whether THIS account publishes its own presence — and so whether it may
     * see anybody else's, which is the same switch. False means every answer
     * above is the hidden one and the app should say why.
     */
    publishing(): boolean;
    /** Bumped on every change: what a UI subscribes to, since a map is not a comparable snapshot. */
    version(): number;
  };
  history: {
    /** Topic `history`. Referentially stable between emissions. */
    progress(): HistoryProgress;
    /** Offers to THIS instance, as last listed. `refreshOffers()` re-lists; the SDK also does so on a nudge and after syncs. */
    pendingOffers(): HistoryOfferView[];
    refreshOffers(): Promise<void>;
    /** Verifies the donor (an active, chain-verified instance of this account) and the manifest, then downloads, decrypts and imports. */
    accept(offerId: string): Promise<void>;
    /** Exports this instance's history to another active, verified instance of the account. Automatic for newly added instances; manual here. */
    offerTo(instanceId: string): Promise<void>;
  };
  backup: {
    /** Topic `backup`. Referentially stable between emissions. */
    status(): BackupStatus;
    /** Asks the server whether a backup exists (`status().remote`). */
    refreshStatus(): Promise<void>;
    /** Returns the 12-word recovery phrase ONCE. The SDK keeps only the derived key. */
    enable(): Promise<string>;
    refresh(): Promise<void>;
    disable(): Promise<void>;
    /** Refuses a wrong phrase before downloading anything (`RecoveryPhraseError`). */
    restore(phrase: string): Promise<void>;
  };
}

/**
 * What the facade answers before `start()` has opened the store and after
 * `reset()` has closed it. Every getter a hook can subscribe to is read
 * through `useSyncExternalStore`, which re-renders whenever two consecutive
 * reads differ by identity: an inline `?? []` there is a new array per call
 * and therefore an unbounded re-render loop the moment a screen mounts over a
 * not-yet-started client (React error #185). So each answer is ONE shared,
 * frozen value, the same reference on every call, exactly as the started
 * services cache theirs.
 */
const EMPTY_LIST: never[] = Object.freeze([]) as never[];
const NO_INSTANCES: InstanceView[] = EMPTY_LIST;
const NO_PENDING: PendingEnrollmentView[] = EMPTY_LIST;
const NO_CONVERSATIONS: ConversationView[] = EMPTY_LIST;
const NO_TIMELINE: TimelineItemView[] = EMPTY_LIST;
const IDLE_PROGRESS: HistoryProgress = { phase: "idle", done: 0, total: 0 };
const NO_OFFERS: HistoryOfferView[] = EMPTY_LIST;
const NO_BACKUP: BackupStatus = { enabled: false, lastBackupAt: null, eventCount: 0, remote: null, busy: false };

export function createAlloClient(options: AlloClientOptions): AlloClient {
  const log = options.logger ?? silentLogger;
  const now = options.now ?? (() => Date.now());
  const resolved: ResolvedOptions = { ...options, keyPackageTarget: options.keyPackageTarget ?? 20, syncIntervalMs: options.syncIntervalMs ?? 30_000 };
  const emitter = new Emitter();
  let ctx: Context | null = null;
  let started = false;
  let pendingPoll: ReturnType<typeof setInterval> | null = null;
  let activated = false;

  const requireCtx = (): Context => {
    if (!ctx) throw new InvalidStateError("client is not started");
    return ctx;
  };

  const activate = async (): Promise<void> => {
    const c = requireCtx();
    if (activated || !c.instance.isActive) return;
    activated = true;
    if (pendingPoll) clearInterval(pendingPoll);
    pendingPoll = null;
    c.sync.instancesStale = true;
    try {
      await c.instance.topUpKeyPackages();
    } catch (error) {
      log.warn?.("key package upload failed", { error: describeError(error) });
    }
    try {
      await c.conversations.refreshFromServer();
    } catch (error) {
      log.warn?.("conversation list refresh failed", { error: describeError(error) });
    }
    c.sync.start();
    c.outbox.start();
    c.backup.start();
    c.presence.start(PRESENCE_HEARTBEAT_MS);
    c.statuses.start();
    await c.instance.ensureTransferKey();
    c.history.offersStale = true;
    await c.sync.now().catch(() => undefined);
    c.outbox.kick();
  };

  const start = async (): Promise<void> => {
    if (started) return;
    const accountId = options.session.getAccountId();
    if (!accountId) throw new InvalidStateError("no Oxy account in session");
    const cipher = await AtRestCipher.open(options.secrets, accountId, options.appId);
    const rootStore = new AlloStore(options.storage, cipher, new Namespace(options.appId, accountId));
    /**
     * The storage key was minted just now and this account already has rows.
     * Those rows were written under a key that no longer exists, so nothing
     * can ever read them again — not this device, not a later one, not an
     * attacker with the disk. Reading one raises "stored value failed
     * authentication" out of `start()`, and a device that cannot start is a
     * device with no way back.
     *
     * So drop them, loudly. What survives is the instance SIGNING key, which
     * lives under its own name in the secret store: with it the registration
     * below meets `idempotency_conflict` and ADOPTS the instance this device
     * already has, staying active rather than asking to be approved. History
     * is what is lost, and it was lost before this ran.
     */
    if (cipher.mintedFresh) {
      const orphaned = await options.storage.list(rootStore.ns.accountPrefix);
      if (orphaned.length > 0) {
        log.error?.("the storage key is gone; dropping the rows it encrypted", { rows: orphaned.length });
        await rootStore.wipeAccount();
      }
    }
    const engine = await CryptoEngine.create(options.crypto);
    const http = new HttpClient({
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      fetch: options.transport?.fetch ?? globalThis.fetch.bind(globalThis),
      getAccessToken: () => options.session.getAccessToken(),
      now,
      onInstanceRevoked: () => ctx?.instance.markRevoked(),
    });
    const c = new Context(resolved, accountId, log, now, http, emitter, engine, new Mutex());
    c.instance = new InstanceManager({
      http,
      rootStore,
      secrets: options.secrets,
      engine,
      emitter,
      log,
      now,
      accountId,
      appId: options.appId,
      platform: options.platform,
      displayName: options.displayName,
      keyPackageTarget: resolved.keyPackageTarget,
      onRevoked: () => {
        // A revoked instance can neither sync nor send; stop everything and leave the state for the UI to show.
        c.realtime.disconnect();
        c.sync.stop();
        c.outbox.stop();
        c.conversations.stop();
        if (pendingPoll) clearInterval(pendingPoll);
        pendingPoll = null;
      },
    });
    await c.instance.ensureRegistered();
    c.store = c.instance.instanceStore;
    c.signer = c.instance.signer;
    c.identity = c.instance.identity;
    c.model = new Model();
    await c.model.load(c.store);
    c.instance.bindModel(c.model);
    c.groups = new GroupRegistry(engine, c.store);
    await c.groups.load();
    c.messages = new MessagesService(c);
    c.conversations = new ConversationsService(c);
    c.outbox = new OutboxEngine(c);
    c.sync = new SyncEngine(c);
    c.presence = new PresenceService(c);
    c.statuses = new StatusService(c);
    c.realtime = new Realtime(c);
    c.history = new HistoryService(c);
    await c.history.load();
    c.backup = new BackupService(c, options.backupDebounceMs);
    await c.backup.load();
    c.onInstanceActivated = () => void activate();
    ctx = c;
    started = true;
    c.realtime.connect();
    if (c.instance.isActive) await activate();
    else if (c.instance.state === "pending-approval") {
      pendingPoll = setInterval(() => {
        void c.instance
          .refresh()
          .then(() => activate())
          .catch(() => undefined);
      }, 5000);
    }
    emitter.emit("instance");
  };

  const stop = async (): Promise<void> => {
    if (!ctx) return;
    if (pendingPoll) clearInterval(pendingPoll);
    pendingPoll = null;
    ctx.realtime.disconnect();
    ctx.sync.stop();
    ctx.outbox.stop();
    ctx.conversations.stop();
    ctx.messages.stop();
    ctx.history.stop();
    ctx.backup.stop();
    ctx.presence.stop();
    ctx.statuses.stop();
    await ctx.outbox.idle().catch(() => undefined);
    started = false;
    activated = false;
  };

  const reset = async (): Promise<ResetOutcome> => {
    const c = ctx;
    await stop();
    const accountId = c?.accountId ?? options.session.getAccountId();
    let outcome: ResetOutcome = { revoked: "not-needed" };
    if (c && c.instance.isActive) {
      const instanceId = c.instanceId;
      try {
        await c.instance.revoke(instanceId);
        outcome = { revoked: "done" };
      } catch (error) {
        // Not "best effort" any more: what is left behind is an instance this
        // device can no longer prove it owns, and the caller is the only one
        // in a position to say so.
        const reason = describeError(error);
        log.error?.("self-revoke on reset failed; this instance is still listed", { instanceId, reason });
        outcome = { revoked: "failed", instanceId, reason };
      }
    }
    if (accountId) {
      const cipher = await AtRestCipher.open(options.secrets, accountId, options.appId);
      await new AlloStore(options.storage, cipher, new Namespace(options.appId, accountId)).wipeAccount();
      await options.secrets.delete(instanceKeyName(accountId, options.appId));
      await options.secrets.delete(storageKeyName(accountId, options.appId));
      await options.secrets.delete(transferKeyName(accountId, options.appId));
      await options.secrets.delete(backupKeyName(accountId, options.appId));
    }
    ctx = null;
    emitter.emit("instance");
    emitter.emit("conversations");
    return outcome;
  };

  const reclaimAccount = async (): Promise<void> => {
    const c = ctx;
    if (!c) throw new InvalidStateError("client is not started");
    const mine = c.instance.current?.id ?? null;
    const listed = await c.instance.listWithSession();
    const active = listed.filter((i) => i.status === "active");
    log.warn?.("reclaiming the account from devices that cannot approve", { revoking: active.length });
    for (const instance of active) {
      // `mine` is pending in the case this exists for, so it is not in here;
      // skipping it is belt and braces for the case where it somehow is.
      if (instance.id === mine) continue;
      await c.instance.revokeWithSession(instance.id);
    }
    // Local state was written under keys the wipe removes, and every group
    // this device was in has just lost its other members' devices anyway.
    await reset();
    await start();
  };

  return {
    get accountId() {
      return ctx?.accountId ?? options.session.getAccountId() ?? "";
    },
    get instanceId() {
      return ctx?.instance.current?.id ?? null;
    },
    start,
    stop,
    reset,
    reclaimAccount,
    subscribe: (topic, listener) => emitter.subscribe(topic, listener),
    onError: (listener) => emitter.onError(listener),
    instance: {
      state: () => ctx?.instance.state ?? "unregistered",
      current: () => ctx?.instance.currentView() ?? null,
      list: () => ctx?.instance.list() ?? NO_INSTANCES,
      pending: () => ctx?.instance.pending() ?? NO_PENDING,
      refresh: () => requireCtx().instance.refresh().then(() => activate()),
      refreshPending: () => requireCtx().instance.refreshPending(),
      approve: async (id, challenge) => {
        const c = requireCtx();
        await c.instance.approve(id, challenge);
        await c.conversations.reconcile();
        c.outbox.kick();
      },
      reject: (id) => requireCtx().instance.reject(id),
      revoke: (id) => requireCtx().instance.revoke(id),
      setPushToken: (provider, token) => requireCtx().instance.setPushToken(provider, token),
      clearPushToken: () => requireCtx().instance.clearPushToken(),
    },
    conversations: {
      list: () => ctx?.conversations.list() ?? NO_CONVERSATIONS,
      get: (id) => ctx?.conversations.get(id),
      createDirect: (accountId) => requireCtx().conversations.createDirect(accountId),
      createGroup: (ids) => requireCtx().conversations.createGroup(ids),
      addMember: (id, accountId) => requireCtx().conversations.addMember(id, accountId),
      removeMember: (id, accountId) => requireCtx().conversations.removeMember(id, accountId),
      leave: (id) => requireCtx().conversations.leave(id),
      rename: (id, name) => requireCtx().conversations.rename(id, name),
      refresh: () => requireCtx().conversations.refreshFromServer(),
    },
    messages: {
      timeline: (id) => ctx?.messages.timeline(id) ?? NO_TIMELINE,
      send: (id, text, o) => requireCtx().messages.send(id, text, o),
      sendPoll: (id, poll) => requireCtx().messages.sendPoll(id, poll),
      vote: (id, t, optionIds) => requireCtx().messages.vote(id, t, optionIds),
      sendLocation: (id, place) => requireCtx().messages.sendLocation(id, place),
      sendContact: (id, contact) => requireCtx().messages.sendContact(id, contact),
      setPinned: (id, t, pinned) => requireCtx().messages.setPinned(id, t, pinned),
      edit: (id, t, body) => requireCtx().messages.edit(id, t, body),
      remove: (id, t) => requireCtx().messages.remove(id, t),
      react: (id, t, key) => requireCtx().messages.react(id, t, key),
      markRead: (id) => requireCtx().messages.markRead(id),
      clearHistory: (id, options) => requireCtx().messages.clearHistory(id, options ?? {}),
      setTyping: (id, on) => requireCtx().messages.setTyping(id, on),
      isTyping: (id) => ctx?.messages.isTyping(id) ?? false,
      loadOlder: (id, before, limit) => requireCtx().messages.loadOlder(id, before, limit),
      unreadCount: (id) => ctx?.messages.unreadCount(id) ?? 0,
    },
    media: {
      upload: (id, bytes, meta) => new MediaService(requireCtx()).upload(id, bytes, meta),
      download: (ref, options) => new MediaService(requireCtx()).download(ref, options),
    },
    statuses: {
      list: () => ctx?.statuses.list() ?? EMPTY_LIST,
      post: (draft) => requireCtx().statuses.post(draft),
      view: (statusId) => requireCtx().statuses.view(statusId),
      viewers: (statusId) => requireCtx().statuses.viewers(statusId),
      remove: (statusId) => requireCtx().statuses.remove(statusId),
      media: (statusId, options) => requireCtx().statuses.media(statusId, options),
      refresh: () => requireCtx().statuses.refresh(),
    },
    presence: {
      watch: (accountIds) => (ctx ? ctx.presence.watch(accountIds) : Promise.resolve()),
      of: (accountId) => ctx?.presence.of(accountId) ?? PRESENCE_UNKNOWN,
      publishing: () => ctx?.presence.publishing ?? true,
      version: () => ctx?.presence.version ?? 0,
    },
    sync: {
      state: () => ctx?.sync.state ?? "idle",
      now: () => requireCtx().sync.now(),
      flush: () => requireCtx().outbox.idle(),
    },
    history: {
      progress: () => ctx?.history.progress() ?? IDLE_PROGRESS,
      pendingOffers: () => ctx?.history.pendingOffers() ?? NO_OFFERS,
      refreshOffers: () => requireCtx().history.refreshOffers(),
      accept: (id) => requireCtx().history.accept(id),
      offerTo: (id) => requireCtx().history.offerTo(id).then(() => undefined),
    },
    backup: {
      status: () => ctx?.backup.status() ?? NO_BACKUP,
      refreshStatus: () => requireCtx().backup.refreshStatus(),
      enable: () => requireCtx().backup.enable(),
      refresh: () => requireCtx().backup.refresh(),
      disable: () => requireCtx().backup.disable(),
      restore: (phrase) => requireCtx().backup.restore(phrase),
    },
  };
}
