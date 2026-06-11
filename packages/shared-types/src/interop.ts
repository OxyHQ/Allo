/**
 * Interop bridge types (F3.0 SEAM).
 *
 * These types describe the additive, flag-gated bridge between Allo and external
 * messaging networks (Telegram first). They are SHARED between backend and the
 * future bridge connector service so both sides agree on the wire shape.
 *
 * Design rules baked into these types:
 *  - External people NEVER enter a conversation's `participants[]` (that array
 *    drives Oxy enrichment, unread counts, user rooms, device-key fetches).
 *    They live in `externalParticipants[]` on the conversation instead.
 *  - Bridged networks are NOT end-to-end encrypted (`e2e: false` for all of
 *    them) — inbound bridged content reuses Allo's legacy plaintext path.
 *  - Sentinel sender ids for bridged messages are `ext:<network>:<externalId>`,
 *    and the bridge origin uses `senderDeviceId: 0`.
 */

/** Networks Allo can talk to. `allo` is the native network. */
export type Network = "allo" | "telegram" | "whatsapp" | "gmessages";

/**
 * Runtime list of every known network. Used by route validation to reject
 * unknown networks (kept in sync with the `Network` union above).
 */
export const NETWORKS: Network[] = ["allo", "telegram", "whatsapp", "gmessages"];

/** Type guard: is `value` one of the known networks? */
export function isNetwork(value: unknown): value is Network {
  return typeof value === "string" && (NETWORKS as string[]).includes(value);
}

/**
 * Feature matrix for a network. Drives capability gating in the UI/bridge so a
 * feature is only offered when the target network actually supports it.
 */
export interface NetworkCapabilities {
  /** End-to-end encryption. Only `allo` is true. */
  e2e: boolean;
  /** Voice/video calls. */
  calls: boolean;
  reactions: boolean;
  edits: boolean;
  deletes: boolean;
  typing: boolean;
  readReceipts: boolean;
  polls: boolean;
  location: boolean;
  voiceNotes: boolean;
  gifs: boolean;
  /** Maximum single-file size accepted by the network, in bytes. */
  fileMaxBytes: number;
}

// --- Per-network file size limits (named consts; no magic numbers) ---

/** Allo native upload cap: 100 MB (matches the app's media pipeline). */
export const ALLO_FILE_MAX_BYTES = 100 * 1024 * 1024;

/** Telegram allows up to 2 GB per file for standard accounts. */
export const TELEGRAM_FILE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** WhatsApp's practical media cap is ~100 MB; conservative placeholder. */
export const WHATSAPP_FILE_MAX_BYTES = 100 * 1024 * 1024;

/** Google Messages (RCS) caps vary by carrier; 100 MB conservative placeholder. */
export const GMESSAGES_FILE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Capability matrix per network.
 *
 * `allo` supports everything. Bridged networks are deliberately CONSERVATIVE:
 *  - `e2e` is false for ALL bridged networks (bridged content is plaintext to
 *    the Allo server).
 *  - `calls` and `polls` are false for all bridged networks for now — neither is
 *    wired through the seam.
 *  - `whatsapp`/`gmessages` values are SEAM PLACEHOLDERS chosen conservatively
 *    (only features known to be broadly available are enabled). They will be
 *    refined when the corresponding connector actually lands (3.x); until then a
 *    capability defaulting to false simply means "not offered yet", which is the
 *    safe direction.
 */
export const NETWORK_CAPABILITIES: Record<Network, NetworkCapabilities> = {
  allo: {
    e2e: true,
    calls: true,
    reactions: true,
    edits: true,
    deletes: true,
    typing: true,
    readReceipts: true,
    polls: true,
    location: true,
    voiceNotes: true,
    gifs: true,
    fileMaxBytes: ALLO_FILE_MAX_BYTES,
  },
  telegram: {
    e2e: false,
    calls: false,
    reactions: true,
    edits: true,
    deletes: true,
    typing: true,
    readReceipts: true,
    polls: false,
    location: true,
    voiceNotes: true,
    gifs: true,
    fileMaxBytes: TELEGRAM_FILE_MAX_BYTES,
  },
  // Conservative placeholder. WhatsApp broadly supports reactions, edits,
  // deletes ("delete for everyone"), typing, read receipts, location, voice
  // notes and GIFs; e2e/calls/polls are not surfaced through the seam.
  whatsapp: {
    e2e: false,
    calls: false,
    reactions: true,
    edits: true,
    deletes: true,
    typing: true,
    readReceipts: true,
    polls: false,
    location: true,
    voiceNotes: true,
    gifs: true,
    fileMaxBytes: WHATSAPP_FILE_MAX_BYTES,
  },
  // Conservative placeholder. RCS (Google Messages) supports reactions, typing,
  // read receipts, location, voice notes and GIFs widely; message edit/delete
  // and polls are not reliably available, so they default to false until the
  // connector confirms.
  gmessages: {
    e2e: false,
    calls: false,
    reactions: true,
    edits: false,
    deletes: false,
    typing: true,
    readReceipts: true,
    polls: false,
    location: true,
    voiceNotes: true,
    gifs: true,
    fileMaxBytes: GMESSAGES_FILE_MAX_BYTES,
  },
};

/** Wire protocol version for bridge events/commands. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * A reference to media carried by a bridge event/command. The bridge re-hosts
 * external media on Allo's `/uploads` domain (via `POST /internal/bridge/media`)
 * and references it here by `url`.
 */
export interface BridgeMediaRef {
  /** Stored id on Allo (the upload filename), if already re-hosted. */
  id?: string;
  /** URL the media can be fetched from (Allo-hosted after re-hosting). */
  url: string;
  type: "image" | "video" | "audio" | "file" | "gif";
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  /** Duration in seconds for audio/video. */
  duration?: number;
}

/**
 * An event flowing FROM the bridge connector INTO Allo (`POST /internal/bridge/events`).
 *
 * `network`, `ownerUserId` (the Allo user who owns the linked account) and
 * `externalChatId` (the external conversation id) are always present. Other
 * fields depend on `type`.
 */
export interface BridgeEvent {
  v: 1;
  type: "message" | "edit" | "delete" | "send_result" | "session_status";
  network: Network;
  /** Allo user id that owns the linked external account. */
  ownerUserId: string;
  /** External network's id for the conversation/chat. */
  externalChatId: string;

  /** External id of the message sender (required for `message`). */
  externalSenderId?: string;
  /** External network's id for the message (required for `message`/`edit`/`delete`). */
  externalMessageId?: string;

  text?: string;
  media?: BridgeMediaRef[];
  /** ISO timestamp of the external event. */
  timestamp?: string;

  // --- send_result correlation ---
  /** Allo `Message._id`, echoed by the connector (preferred correlation key). */
  messageId?: string;
  /** Client-provided correlation id echoed back by the connector (fallback). */
  clientMessageId?: string;
  /** Result of an outbound send attempt. */
  status?: "sent" | "failed";
  /** Human-readable error (never logged with secrets). */
  error?: string;

  // --- session_status ---
  sessionStatus?: "active" | "expired" | "revoked" | "error";

  // --- contact upsert (carried on `message`) ---
  senderDisplayName?: string;
  senderUsername?: string;
  senderAvatarUrl?: string;
}

/**
 * A command flowing FROM Allo TO the bridge connector (`POST <bridge>/commands`).
 * Built when an Allo user sends/typing/reads in a bridged conversation.
 */
export interface BridgeCommand {
  v: 1;
  type: "send" | "typing" | "read";
  network: Network;
  ownerUserId: string;
  externalChatId: string;
  /** Allo `Message._id`, used to correlate the eventual `send_result`. */
  messageId?: string;
  text?: string;
  media?: BridgeMediaRef[];
}
