/**
 * What every module shares. Built by `client.ts` in dependency order; the
 * late-bound members are assigned before `start()` returns and never read
 * before that.
 */
import type { CryptoEngine, Identity } from "./crypto/engine";
import type { Emitter } from "./events/emitter";
import type { InstanceManager } from "./instance/manager";
import type { Model } from "./storage/model";
import type { InstanceStore } from "./storage/store";
import type { HttpClient, Signer } from "./transport/http";
import type { AlloClientOptions } from "./types";
import type { Logger } from "./util/logger";
import type { Mutex } from "./util/async";
import type { GroupRegistry } from "./conversations/groups";
import type { OutboxEngine } from "./outbox/engine";
import type { SyncEngine } from "./sync/engine";
import type { ConversationsService } from "./conversations/service";
import type { MessagesService } from "./messages/service";
import type { CallsService } from "./calls/service";
import type { PresenceService } from "./presence/service";
import type { StatusService } from "./statuses/service";
import type { Realtime } from "./sync/realtime";
import type { HistoryService } from "./history/service";
import type { BackupService } from "./backup/service";

export interface ResolvedOptions extends AlloClientOptions {
  keyPackageTarget: number;
  syncIntervalMs: number;
}

export class Context {
  constructor(
    readonly options: ResolvedOptions,
    readonly accountId: string,
    readonly log: Logger,
    readonly now: () => number,
    readonly http: HttpClient,
    readonly emitter: Emitter,
    readonly engine: CryptoEngine,
    readonly mutex: Mutex,
  ) {}

  instance!: InstanceManager;
  store!: InstanceStore;
  model!: Model;
  groups!: GroupRegistry;
  identity!: Identity;
  signer!: Signer;
  outbox!: OutboxEngine;
  sync!: SyncEngine;
  conversations!: ConversationsService;
  messages!: MessagesService;
  realtime!: Realtime;
  calls!: CallsService;
  presence!: PresenceService;
  statuses!: StatusService;
  history!: HistoryService;
  backup!: BackupService;
  /** Set by the client: runs the post-activation steps when a pending instance is approved. */
  onInstanceActivated?: () => void;

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  get instanceId(): string {
    return this.signer.instanceId;
  }
}
