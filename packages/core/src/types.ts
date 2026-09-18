/**
 * The public types of `@allo/core`: construction options, the platform
 * adapters a host supplies, and every view model the UI reads. Nothing here
 * imports React, Expo or a Matrix-shaped thing; the wire types come from
 * `@allo/shared-types`.
 */
import type { AppMessage, ClientInstance, MediaKind, Platform } from "@allo/shared-types";
import type { CryptoProvider } from "ts-mls";
import type { Logger } from "./util/logger";

// ---------------------------------------------------------------------------
// Adapters the host supplies
// ---------------------------------------------------------------------------

/** How the SDK reaches the Oxy session: a bearer token and the account it names. */
export interface OxySessionAdapter {
  getAccessToken(): Promise<string | null>;
  getAccountId(): string | null;
  /** Called on any session change (sign-in, sign-out, account switch). Returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
}

export type StorageOp = { type: "set"; key: string; value: Uint8Array } | { type: "delete"; key: string };

/**
 * A byte KV with prefix scan and an atomic batch. Every value the SDK writes
 * through it is already encrypted at rest; the adapter never sees plaintext.
 */
export interface StorageAdapter {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  batch(ops: StorageOp[]): Promise<void>;
}

/** A small secure store (Keychain / Keystore / IndexedDB) for the storage key and the instance signing key. */
export interface SecretStore {
  get(name: string): Promise<Uint8Array | undefined>;
  set(name: string, value: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

/** The minimum of a Socket.IO client the SDK relies on, so tests can inject a fake. */
export interface SocketLike {
  readonly connected: boolean;
  connect(): void;
  disconnect(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler?: (...args: unknown[]) => void): void;
  emit(event: string, payload: unknown): void;
}

/** The handshake `auth` object; recomputed on every (re)connect because the signature carries a timestamp. */
export interface SocketAuthPayload {
  token: string;
  instanceId: string;
  timestamp: number;
  signature: string;
}

export type SocketFactory = (url: string, auth: () => Promise<SocketAuthPayload>) => SocketLike;

export interface TransportOptions {
  fetch?: typeof fetch;
  socketFactory?: SocketFactory;
}

export interface PersonInfo {
  displayName: string;
  avatarFileId?: string;
}

/** Optional resolver for display names. The SDK never guesses a name; without this it exposes ids only. */
export interface PeopleDirectory {
  resolve(accountIds: string[]): Promise<Map<string, PersonInfo>>;
}

export interface AlloClientOptions {
  baseUrl: string;
  appId: string;
  platform: Platform;
  /** The name this installation registers under (shown in the devices list). */
  displayName: string;
  session: OxySessionAdapter;
  storage: StorageAdapter;
  secrets: SecretStore;
  /** ts-mls crypto provider. Default: the SDK's noble-only provider on every platform. */
  crypto?: CryptoProvider;
  transport?: TransportOptions;
  people?: PeopleDirectory;
  logger?: Logger;
  now?: () => number;
  /** Key packages kept on the server. Default 20. */
  keyPackageTarget?: number;
  /** Live sync interval in ms. Default 30 000. */
  syncIntervalMs?: number;
  /** How long after a sync that makes a backup due the automatic refresh waits, ms. Default 10 000. */
  backupDebounceMs?: number;
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export type InstanceState = "unregistered" | "pending-approval" | "active" | "revoked";
export type SyncState = "idle" | "syncing" | "live" | "offline" | "error";
export type SendState = "pending" | "accepted" | "delivered" | "read" | "failed";

export interface InstanceView {
  id: string;
  accountId: string;
  appId: string;
  platform: Platform;
  displayName: string;
  signingPublicKey: string;
  /** `null` on an instance registered before transfer keys existed and not yet upgraded: it cannot receive history. */
  transferPublicKey: string | null;
  status: ClientInstance["status"];
  isThis: boolean;
  approvedByInstanceId: string | null;
  enrolledAt: string | null;
  revokedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  /**
   * Only on THIS instance's own view while it is pending approval: the
   * challenge the server issued and its fingerprint, computed with the same
   * function the approver's `pending()[i].fingerprint` uses, so the two
   * screens can be compared by eye. Never present for other instances.
   */
  enrollment?: { challenge: string; fingerprint: string };
}

export interface PendingEnrollmentView {
  instance: InstanceView;
  /** The server-issued challenge, base64url. Show its fingerprint before approving. */
  challenge: string;
  /** A short human-checkable digest of the challenge (first 8 hex of its SHA-256, grouped). */
  fingerprint: string;
}

/** An opaque handle for `client.media.download(ref)`. */
export interface MediaRef {
  conversationId: string;
  blobId: string;
}

export interface MediaView {
  kind: MediaKind;
  filename: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
  caption?: string;
  ref: MediaRef;
  thumbnail?: { ref: MediaRef; width: number; height: number };
}

export type TimelineContent =
  | { kind: "text"; body: string; isEdited: boolean }
  | { kind: "media"; media: MediaView }
  | { kind: "deleted" }
  | { kind: "undecryptable"; reason: string }
  | { kind: "system"; text: string };

export interface TimelineItemView {
  /** The server event id, or the local key while the item is still a local echo. */
  id: string;
  localKey?: string;
  conversationId: string;
  seq: number | null;
  senderAccountId: string;
  senderInstanceId: string | null;
  sentAt: string;
  isOwn: boolean;
  sendState: SendState;
  content: TimelineContent;
  reactions: Array<{ key: string; accountIds: string[] }>;
  replyTo?: string;
}

export interface ConversationView {
  id: string;
  kind: "dm" | "group";
  appId: string;
  /** From the E2EE `conversation` message; `null` until one arrives. The UI composes person names via `people`. */
  title: string | null;
  memberAccountIds: string[];
  myRole: "owner" | "admin" | "member";
  epoch: number;
  /** Whether this instance holds an active MLS leaf: it can read and send. */
  joined: boolean;
  lastMessage?: TimelineItemView;
  unreadCount: number;
  lastActivityAt: string;
  createdAt: string;
}

export interface UploadMediaMeta {
  kind: MediaKind;
  filename: string;
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
  caption?: string;
  /** A rendered preview, encrypted and uploaded as a second blob; its key travels in the same `media` message. */
  thumbnail?: { bytes: Uint8Array; mime: string; width: number; height: number };
}

// ---------------------------------------------------------------------------
// History transfer and backup
// ---------------------------------------------------------------------------

export type HistoryPhase = "idle" | "exporting" | "uploading" | "downloading" | "importing";

/** Topic `history`. `done`/`total` count chunks while uploading or downloading, and events while importing. */
export interface HistoryProgress {
  phase: HistoryPhase;
  done: number;
  total: number;
  /** The donor while receiving, so the UI can name the device ("Receiving history from …"). */
  fromInstanceId?: string;
  /** The recipient while sending. */
  toInstanceId?: string;
}

/** A pending offer as the recipient sees it. `trusted` is the SDK's verdict on the donor; `accept()` refuses an untrusted one anyway. */
export interface HistoryOfferView {
  id: string;
  donorInstanceId: string;
  /** From the account's instance listing; `null` when the donor is not listed. */
  donorDisplayName: string | null;
  conversationCount: number;
  eventCount: number;
  createdAt: string;
  expiresAt: string;
  trusted: boolean;
}

/** Topic `backup`. `remote` is `null` until the server has been asked (`refreshStatus()`). */
export interface BackupStatus {
  enabled: boolean;
  lastBackupAt: string | null;
  /** Events covered by the last refresh. */
  eventCount: number;
  remote: { exists: boolean; updatedAt: string | null } | null;
  /** A refresh or a restore is running. */
  busy: boolean;
}

export interface SendOptions {
  /** The id (or local key) of the message replied to. */
  replyTo?: string;
}

export interface LoadOlderResult {
  items: TimelineItemView[];
  /** True when nothing older can exist locally: history before this leaf's join epoch is not decryptable. */
  reachedStart: boolean;
}

export type SubscriptionTopic =
  | "conversations"
  | `timeline:${string}`
  | "instance"
  | "instances"
  | "sync"
  | `typing:${string}`
  | "history"
  | "backup"
  | "error";

export type { AppMessage };
