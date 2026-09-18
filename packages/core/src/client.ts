/**
 * `createAlloClient`: wires the modules and owns the lifecycle.
 *
 *   start()  load the account's encrypted store, ensure an instance exists
 *            (register on first run), connect the socket, and — once the
 *            instance is active — top up key packages, pull the server's
 *            conversation list and sync.
 *   stop()   disconnect and stop every loop and timer.
 *   reset()  revoke this instance (best effort), wipe its namespace and its
 *            secrets (signing, storage, transfer and backup keys). For sign-out.
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
import { Realtime } from "./sync/realtime";
import { HttpClient } from "./transport/http";
import type {
  AlloClientOptions,
  BackupStatus,
  ConversationView,
  HistoryOfferView,
  HistoryProgress,
  InstanceState,
  InstanceView,
  LoadOlderResult,
  MediaRef,
  PendingEnrollmentView,
  SendOptions,
  SubscriptionTopic,
  SyncState,
  TimelineItemView,
  UploadMediaMeta,
} from "./types";
import { Mutex } from "./util/async";
import { describeError, silentLogger } from "./util/logger";

export interface AlloClient {
  readonly accountId: string;
  /** The instance id once registered. */
  readonly instanceId: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): Promise<void>;
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
    edit(conversationId: string, targetId: string, body: string): Promise<void>;
    remove(conversationId: string, targetId: string): Promise<void>;
    react(conversationId: string, targetId: string, key: string): Promise<void>;
    markRead(conversationId: string): Promise<void>;
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
    await ctx.outbox.idle().catch(() => undefined);
    started = false;
    activated = false;
  };

  const reset = async (): Promise<void> => {
    const c = ctx;
    await stop();
    const accountId = c?.accountId ?? options.session.getAccountId();
    if (c && c.instance.isActive) {
      try {
        await c.instance.revoke(c.instanceId);
      } catch (error) {
        log.warn?.("self-revoke on reset failed", { error: describeError(error) });
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
      edit: (id, t, body) => requireCtx().messages.edit(id, t, body),
      remove: (id, t) => requireCtx().messages.remove(id, t),
      react: (id, t, key) => requireCtx().messages.react(id, t, key),
      markRead: (id) => requireCtx().messages.markRead(id),
      setTyping: (id, on) => requireCtx().messages.setTyping(id, on),
      isTyping: (id) => ctx?.messages.isTyping(id) ?? false,
      loadOlder: (id, before, limit) => requireCtx().messages.loadOlder(id, before, limit),
      unreadCount: (id) => ctx?.messages.unreadCount(id) ?? 0,
    },
    media: {
      upload: (id, bytes, meta) => new MediaService(requireCtx()).upload(id, bytes, meta),
      download: (ref, options) => new MediaService(requireCtx()).download(ref, options),
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
