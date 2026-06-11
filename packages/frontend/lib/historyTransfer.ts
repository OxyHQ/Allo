/**
 * WhatsApp-style P2P history transfer (Fase 1C).
 *
 * A NEW device starts with NO message history — old envelopes are cryptographically
 * unreadable by design (each device has its own Signal identity). To bootstrap the
 * new device with the user's existing conversations, an OLD device of the SAME
 * account streams its local *plaintext* cache over an encrypted WebRTC data channel.
 *
 * Crypto model:
 *  - The two devices agree on a 32-byte ephemeral `secret` out of band (manual code
 *    typed by the user, or scanned QR). The secret NEVER touches the server.
 *  - Both sides derive a `transferKey = HKDF(secret, info='allo-history-transfer-v1')`.
 *  - The serialized history is chunked (≤64 KiB plaintext per chunk) and each chunk
 *    is AEAD-encrypted (ChaCha20-Poly1305) with `transferKey`, binding the chunk
 *    `seq` into the associated data so chunks cannot be reordered or substituted.
 *  - A SHA-256 checksum over the full serialized plaintext is sent in `history:end`;
 *    the receiver applies the import ONLY after the reassembled bytes match (no
 *    partial apply — the whole transfer is atomic from the store's perspective).
 *
 * What is transferred: the plaintext local cache only (conversations metadata +
 * per-conversation decrypted messages). Signal sessions, ratchet state and identity
 * keys are NEVER transferred — the new device keeps its own Signal identity.
 *
 * This module is transport-agnostic and side-effect-free except for the explicit
 * `collectLocalHistory` / `applyTransferredHistory` helpers, so the protocol can be
 * unit-tested end to end in memory.
 */

import {
  hkdfDerive,
  aeadEncrypt,
  aeadDecrypt,
  random,
  bytesToBase64,
  base64ToBytes,
  utf8ToBytes,
  bytesToUtf8,
} from '@/lib/signal/keys';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  getConversationsLocally,
  getMessagesLocally,
  storeConversationsLocally,
  storeMessagesLocally,
} from '@/lib/offlineStorage';
import {
  p2pManager,
  type TransferConnection,
  type TransferPeer,
} from '@/lib/p2pMessaging';
import type { Message } from '@/stores/messagesStore';
import type { Conversation } from '@/app/(chat)/index';

// --- Protocol constants -----------------------------------------------------

/** Length of the ephemeral pairing secret in bytes. */
export const TRANSFER_SECRET_LENGTH = 32;

/** HKDF context string — versioned so the derivation can evolve without ambiguity. */
export const TRANSFER_HKDF_INFO = 'allo-history-transfer-v1';

/** Wire/serialization version for the history payload envelope. */
export const HISTORY_PAYLOAD_VERSION = 1;

/** Checksum algorithm identifier carried in `history:begin`. */
export const CHECKSUM_ALGO = 'sha256';

/**
 * Maximum plaintext bytes per chunk. Kept at 48 KiB so that after base64 encoding
 * (+~33%) and AEAD overhead each data-channel frame stays comfortably under the
 * 64 KiB SCTP message ceiling that some WebRTC stacks enforce.
 */
export const MAX_CHUNK_PLAINTEXT_BYTES = 48 * 1024;

/**
 * Hard upper bound on the number of chunks a transfer may declare/contain.
 *
 * The receiver buffers every chunk in memory before applying (atomic apply, no
 * partial writes), so an unbounded `chunkCount` from `history:begin` — whether
 * from a genuinely enormous history or a malicious peer — would let a sender OOM
 * a low-end device. At `MAX_CHUNK_PLAINTEXT_BYTES` (48 KiB) per chunk, a cap of
 * 2048 bounds the buffered plaintext at ~96 MiB, which is generous for a real
 * message cache yet safe on memory-constrained phones. The SENDER refuses to
 * build a stream above the cap (fail fast), and the RECEIVER rejects a
 * `history:begin` that declares more (defence in depth against a hostile peer).
 */
export const MAX_TRANSFER_CHUNK_COUNT = 2048;

// --- Frame types (sent over the data channel) -------------------------------

export interface HistoryBeginFrame {
  type: 'history:begin';
  /** Protocol version of the payload being streamed. */
  version: number;
  /** Number of conversations included (for progress display). */
  conversationCount: number;
  /** Total number of messages across all conversations (for progress display). */
  totalMessages: number;
  /** Total number of encrypted chunks the receiver should expect. */
  chunkCount: number;
  /** Checksum algorithm (always `sha256` today). */
  checksumAlgo: string;
}

export interface HistoryChunkFrame {
  type: 'history:chunk';
  /** Zero-based sequence number; chunks arrive in order over a reliable channel. */
  seq: number;
  /** Base64 of `nonce(12) || ciphertext+tag` for this chunk. */
  dataB64: string;
}

export interface HistoryEndFrame {
  type: 'history:end';
  /** Hex SHA-256 of the full serialized plaintext payload. */
  checksum: string;
}

export interface HistoryCancelFrame {
  type: 'history:cancel';
  /** Machine-readable reason (free-form, surfaced as an i18n key by the UI). */
  reason: string;
}

export type HistoryFrame =
  | HistoryBeginFrame
  | HistoryChunkFrame
  | HistoryEndFrame
  | HistoryCancelFrame;

// --- Serialized payload shape ----------------------------------------------

/**
 * The plaintext history payload. Conversations carry their display metadata and
 * each message is the already-decrypted local cache entry. Timestamps are ISO
 * strings on the wire (re-hydrated to `Date` on apply).
 */
export interface HistoryPayload {
  version: number;
  conversations: Conversation[];
  /** Per-conversation message arrays, keyed by conversation id. */
  messages: Record<string, SerializableMessage[]>;
}

/** A message with `Date` fields flattened to ISO strings for JSON transport. */
type SerializableMessage = Omit<Message, 'timestamp' | 'editedAt'> & {
  timestamp: string;
  editedAt?: string;
};

// --- Key derivation ---------------------------------------------------------

/**
 * Derive the symmetric transfer key from the shared ephemeral secret. A 32-byte
 * zero salt keeps the derivation deterministic on both ends (the secret itself is
 * the high-entropy input); the versioned `info` string domain-separates this key
 * from any other HKDF use in the app.
 */
export function deriveTransferKey(secret: Uint8Array): Uint8Array {
  if (secret.length !== TRANSFER_SECRET_LENGTH) {
    throw new Error('deriveTransferKey: secret must be 32 bytes');
  }
  return hkdfDerive(secret, new Uint8Array(32), utf8ToBytes(TRANSFER_HKDF_INFO), 32);
}

/** Generate a fresh ephemeral pairing secret (used by the receiving device). */
export function generateTransferSecret(): Uint8Array {
  return random(TRANSFER_SECRET_LENGTH);
}

// --- Chunk AEAD -------------------------------------------------------------

/**
 * Associated data binding a chunk to its sequence number and the total chunk
 * count, so a chunk cannot be replayed at a different position or in a transfer
 * of a different length without the tag check failing.
 */
function chunkAad(seq: number, chunkCount: number): Uint8Array {
  return utf8ToBytes(`${TRANSFER_HKDF_INFO}|${seq}|${chunkCount}`);
}

/** Encrypt one plaintext chunk, returning base64 of `nonce || ct+tag`. */
export function encryptChunk(
  transferKey: Uint8Array,
  seq: number,
  chunkCount: number,
  plaintext: Uint8Array
): string {
  return bytesToBase64(aeadEncrypt(transferKey, plaintext, chunkAad(seq, chunkCount)));
}

/** Decrypt one chunk (base64 of `nonce || ct+tag`) back to plaintext bytes. */
export function decryptChunk(
  transferKey: Uint8Array,
  seq: number,
  chunkCount: number,
  dataB64: string
): Uint8Array {
  return aeadDecrypt(transferKey, base64ToBytes(dataB64), chunkAad(seq, chunkCount));
}

// --- Serialization + checksum ----------------------------------------------

/** Stable checksum of serialized payload bytes (hex SHA-256). */
export function checksumOf(payloadBytes: Uint8Array): string {
  return bytesToHex(sha256(payloadBytes));
}

/** Serialize a history payload to UTF-8 bytes ready for chunking. */
export function serializePayload(payload: HistoryPayload): Uint8Array {
  return utf8ToBytes(JSON.stringify(payload));
}

/** Parse serialized payload bytes back into a `HistoryPayload`, validating shape. */
export function parsePayload(bytes: Uint8Array): HistoryPayload {
  const parsed: unknown = JSON.parse(bytesToUtf8(bytes));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    !('conversations' in parsed) ||
    !('messages' in parsed)
  ) {
    throw new Error('parsePayload: malformed history payload');
  }
  const obj = parsed as Partial<HistoryPayload>;
  if (
    typeof obj.version !== 'number' ||
    !Array.isArray(obj.conversations) ||
    typeof obj.messages !== 'object' ||
    obj.messages === null
  ) {
    throw new Error('parsePayload: malformed history payload fields');
  }
  return {
    version: obj.version,
    conversations: obj.conversations,
    messages: obj.messages as Record<string, SerializableMessage[]>,
  };
}

/**
 * Split serialized payload bytes into ≤`MAX_CHUNK_PLAINTEXT_BYTES` slices.
 * Always returns at least one chunk (an empty payload yields a single empty
 * chunk) so `chunkCount` and the begin/end framing stay well-defined.
 */
export function chunkBytes(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_PLAINTEXT_BYTES) {
    chunks.push(bytes.subarray(offset, offset + MAX_CHUNK_PLAINTEXT_BYTES));
  }
  if (chunks.length === 0) {
    chunks.push(new Uint8Array(0));
  }
  return chunks;
}

// --- Sender: build the outgoing frame stream --------------------------------

/** Count the total number of messages across all conversations in a payload. */
function countMessages(payload: HistoryPayload): number {
  let total = 0;
  for (const key of Object.keys(payload.messages)) {
    total += payload.messages[key]?.length ?? 0;
  }
  return total;
}

/**
 * Build the ordered list of frames for a payload: one `begin`, N encrypted
 * `chunk` frames, one `end` with the checksum. The transport layer is
 * responsible for writing them in order and honoring backpressure.
 */
export function buildTransferFrames(
  transferKey: Uint8Array,
  payload: HistoryPayload
): HistoryFrame[] {
  const bytes = serializePayload(payload);
  const checksum = checksumOf(bytes);
  const chunks = chunkBytes(bytes);
  const chunkCount = chunks.length;

  // Fail fast on the sender side: refuse to build a stream larger than the cap
  // the receiver will accept, so the sender errors clearly instead of streaming
  // chunks that the receiver would reject mid-transfer.
  if (chunkCount > MAX_TRANSFER_CHUNK_COUNT) {
    throw new Error(
      `history transfer too large: ${chunkCount} chunks exceeds the cap of ${MAX_TRANSFER_CHUNK_COUNT}`
    );
  }

  const frames: HistoryFrame[] = [
    {
      type: 'history:begin',
      version: payload.version,
      conversationCount: payload.conversations.length,
      totalMessages: countMessages(payload),
      chunkCount,
      checksumAlgo: CHECKSUM_ALGO,
    },
  ];
  chunks.forEach((chunk, seq) => {
    frames.push({
      type: 'history:chunk',
      seq,
      dataB64: encryptChunk(transferKey, seq, chunkCount, chunk),
    });
  });
  frames.push({ type: 'history:end', checksum });
  return frames;
}

// --- Receiver: stateful reassembler ----------------------------------------

export interface ReceiverProgress {
  receivedChunks: number;
  totalChunks: number;
  conversationCount: number;
  totalMessages: number;
}

/**
 * Result of feeding a frame to the receiver. `status === 'complete'` means the
 * checksum verified and `payload` holds the fully reassembled, validated history
 * (ready to apply). `status === 'progress'` means more chunks are expected.
 */
export type ReceiverFeedResult =
  | { status: 'progress'; progress: ReceiverProgress }
  | { status: 'complete'; payload: HistoryPayload; progress: ReceiverProgress };

/**
 * Stateful receiver that buffers encrypted chunks to memory and only produces a
 * `HistoryPayload` once `history:end` arrives AND the SHA-256 checksum of the
 * reassembled plaintext matches. Any protocol violation (out-of-order chunk,
 * bad AEAD tag, checksum mismatch) throws — the caller treats a throw as a hard
 * failure and discards everything (no partial apply).
 */
export class HistoryReceiver {
  private readonly transferKey: Uint8Array;
  private begun = false;
  private ended = false;
  private expectedChunkCount = 0;
  private nextSeq = 0;
  private conversationCount = 0;
  private totalMessages = 0;
  private readonly chunks: Uint8Array[] = [];

  constructor(transferKey: Uint8Array) {
    this.transferKey = transferKey;
  }

  get progress(): ReceiverProgress {
    return {
      receivedChunks: this.chunks.length,
      totalChunks: this.expectedChunkCount,
      conversationCount: this.conversationCount,
      totalMessages: this.totalMessages,
    };
  }

  /** Feed one decoded frame. Throws on any protocol violation. */
  feed(frame: HistoryFrame): ReceiverFeedResult {
    switch (frame.type) {
      case 'history:begin':
        return this.handleBegin(frame);
      case 'history:chunk':
        return this.handleChunk(frame);
      case 'history:end':
        return this.handleEnd(frame);
      case 'history:cancel':
        throw new Error(`history transfer cancelled by sender: ${frame.reason}`);
      default: {
        // Exhaustiveness guard: an unknown frame type is a protocol error.
        const exhaustiveCheck: never = frame;
        throw new Error(`unknown history frame: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  private handleBegin(frame: HistoryBeginFrame): ReceiverFeedResult {
    if (this.begun) {
      throw new Error('history:begin received twice');
    }
    if (frame.version !== HISTORY_PAYLOAD_VERSION) {
      throw new Error(`unsupported history payload version: ${frame.version}`);
    }
    if (frame.checksumAlgo !== CHECKSUM_ALGO) {
      throw new Error(`unsupported checksum algorithm: ${frame.checksumAlgo}`);
    }
    if (!Number.isInteger(frame.chunkCount) || frame.chunkCount < 1) {
      throw new Error('history:begin has an invalid chunkCount');
    }
    // Defence in depth: reject an oversized (or hostile) declared chunk count
    // before buffering anything, so a peer cannot OOM this device.
    if (frame.chunkCount > MAX_TRANSFER_CHUNK_COUNT) {
      throw new Error(
        `history:begin chunkCount ${frame.chunkCount} exceeds the cap of ${MAX_TRANSFER_CHUNK_COUNT}`
      );
    }
    this.begun = true;
    this.expectedChunkCount = frame.chunkCount;
    this.conversationCount = frame.conversationCount;
    this.totalMessages = frame.totalMessages;
    return { status: 'progress', progress: this.progress };
  }

  private handleChunk(frame: HistoryChunkFrame): ReceiverFeedResult {
    if (!this.begun || this.ended) {
      throw new Error('history:chunk received outside an active transfer');
    }
    if (frame.seq !== this.nextSeq) {
      throw new Error(`out-of-order history chunk: expected ${this.nextSeq}, got ${frame.seq}`);
    }
    if (frame.seq >= this.expectedChunkCount) {
      throw new Error('history chunk seq exceeds announced chunk count');
    }
    // Throws if the AEAD tag (or the seq/count AAD binding) does not verify.
    const plaintext = decryptChunk(
      this.transferKey,
      frame.seq,
      this.expectedChunkCount,
      frame.dataB64
    );
    this.chunks.push(plaintext);
    this.nextSeq += 1;
    return { status: 'progress', progress: this.progress };
  }

  private handleEnd(frame: HistoryEndFrame): ReceiverFeedResult {
    if (!this.begun || this.ended) {
      throw new Error('history:end received outside an active transfer');
    }
    if (this.chunks.length !== this.expectedChunkCount) {
      throw new Error(
        `history transfer incomplete: ${this.chunks.length}/${this.expectedChunkCount} chunks`
      );
    }
    const reassembled = concatChunks(this.chunks);
    const actualChecksum = checksumOf(reassembled);
    if (actualChecksum !== frame.checksum) {
      throw new Error('history checksum mismatch');
    }
    this.ended = true;
    const payload = parsePayload(reassembled);
    return { status: 'complete', payload, progress: this.progress };
  }
}

/** Concatenate received chunk buffers into a single contiguous payload. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// --- Pairing payload (encodes the receiver's address + secret) --------------

/**
 * The information the NEW (receiving) device must hand to the OLD (sending)
 * device out of band: where to signal (userId + deviceId) and the ephemeral
 * secret from which both derive the transfer key. This NEVER goes through the
 * server — it is carried by a QR or a manually typed code.
 */
export interface PairingPayload {
  /** Receiver's user id (same account on both devices). */
  userId: string;
  /** Receiver's Signal device id — the signaling target for the old device. */
  deviceId: number;
  /** Ephemeral 32-byte secret (the transfer-key seed). */
  secret: Uint8Array;
}

/** Internal JSON shape of an encoded pairing payload (`s` = base64 secret). */
interface EncodedPairing {
  v: number;
  u: string;
  d: number;
  s: string;
}

/** Current pairing-code format version. */
export const PAIRING_CODE_VERSION = 1;

/**
 * Encode a pairing payload to a compact, URL-safe ASCII string suitable both for
 * a QR code and for manual entry. We base64url-encode a tiny JSON object; the
 * caller can additionally group the string for readability when showing it.
 */
export function encodePairingPayload(payload: PairingPayload): string {
  const obj: EncodedPairing = {
    v: PAIRING_CODE_VERSION,
    u: payload.userId,
    d: payload.deviceId,
    s: bytesToBase64(payload.secret),
  };
  return base64UrlEncode(utf8ToBytes(JSON.stringify(obj)));
}

/** Decode a pairing code (from QR scan or manual entry) back to its payload. */
export function decodePairingPayload(code: string): PairingPayload {
  const normalized = normalizePairingCode(code);
  if (!normalized) {
    throw new Error('decodePairingPayload: empty code');
  }
  let obj: EncodedPairing;
  try {
    obj = JSON.parse(bytesToUtf8(base64UrlDecode(normalized))) as EncodedPairing;
  } catch {
    throw new Error('decodePairingPayload: malformed code');
  }
  if (
    !obj ||
    obj.v !== PAIRING_CODE_VERSION ||
    typeof obj.u !== 'string' ||
    obj.u.length === 0 ||
    typeof obj.d !== 'number' ||
    !Number.isInteger(obj.d) ||
    obj.d < 1 ||
    typeof obj.s !== 'string'
  ) {
    throw new Error('decodePairingPayload: invalid code fields');
  }
  const secret = base64ToBytes(obj.s);
  if (secret.length !== TRANSFER_SECRET_LENGTH) {
    throw new Error('decodePairingPayload: invalid secret length');
  }
  return { userId: obj.u, deviceId: obj.d, secret };
}

/**
 * Format an encoded pairing code into readability groups for manual entry, e.g.
 * `ABCD-EFGH-IJKL`. Purely cosmetic; `normalizePairingCode` reverses it.
 */
export function formatPairingCodeForDisplay(code: string, groupSize = 4): string {
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += groupSize) {
    groups.push(code.slice(i, i + groupSize));
  }
  return groups.join('-');
}

/** Strip grouping/whitespace a user may have introduced when typing the code. */
export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]+/g, '').trim();
}

/** base64url (no padding) encode. */
function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (no padding) decode. */
function base64UrlDecode(value: string): Uint8Array {
  let b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  return base64ToBytes(b64);
}

// --- Drivers (orchestrate protocol + transport) -----------------------------

/** Progress + outcome callbacks shared by both transfer roles. */
export interface TransferDriverCallbacks {
  /** Fired as the channel connects / streams (n received vs total). */
  onProgress?: (progress: TransferDriverProgress) => void;
  /** Fired once the transfer fully succeeds. */
  onComplete?: () => void;
  /** Fired on any failure or cancellation with a machine-readable reason. */
  onError?: (reason: string) => void;
}

export interface TransferDriverProgress {
  phase: 'connecting' | 'transferring' | 'applying' | 'done';
  /** Chunks sent/received so far. */
  current: number;
  /** Total chunks (0 until known). */
  total: number;
  conversationCount: number;
  totalMessages: number;
}

/** A running transfer the UI can cancel. */
export interface TransferHandle {
  cancel: () => void;
}

/**
 * SENDER side (OLD device). Collects local history, opens a device-addressed P2P
 * channel to the receiver, and streams the encrypted frames. Resolves the handle
 * synchronously so the UI can offer a cancel button immediately.
 */
export function startHistorySend(
  pairing: PairingPayload,
  callbacks: TransferDriverCallbacks
): TransferHandle {
  const transferKeyBytes = deriveTransferKey(pairing.secret);
  const peer: TransferPeer = { userId: pairing.userId, deviceId: pairing.deviceId };
  let cancelled = false;
  let connection: TransferConnection | null = null;
  let finished = false;

  const fail = (reason: string) => {
    if (finished) return;
    finished = true;
    callbacks.onError?.(reason);
  };
  const succeed = () => {
    if (finished) return;
    finished = true;
    callbacks.onComplete?.();
  };

  callbacks.onProgress?.({
    phase: 'connecting',
    current: 0,
    total: 0,
    conversationCount: 0,
    totalMessages: 0,
  });

  connection = p2pManager.openTransfer(peer, {
    onOpen: () => {
      void (async () => {
        try {
          const payload = await collectLocalHistory();
          const frames = buildTransferFrames(transferKeyBytes, payload);
          const begin = frames[0] as HistoryBeginFrame;
          const total = begin.chunkCount;
          let sentChunks = 0;
          for (const frame of frames) {
            if (cancelled || !connection) return;
            const ok = await connection.send(JSON.stringify(frame));
            if (!ok) {
              fail('channel_closed');
              return;
            }
            if (frame.type === 'history:chunk') {
              sentChunks += 1;
              callbacks.onProgress?.({
                phase: 'transferring',
                current: sentChunks,
                total,
                conversationCount: begin.conversationCount,
                totalMessages: begin.totalMessages,
              });
            }
          }
          if (cancelled) return;
          callbacks.onProgress?.({
            phase: 'done',
            current: total,
            total,
            conversationCount: begin.conversationCount,
            totalMessages: begin.totalMessages,
          });
          succeed();
        } catch (err) {
          fail(err instanceof Error ? err.message : 'send_failed');
        }
      })();
    },
    onFrame: () => {
      // The sender does not expect inbound frames in this one-way protocol.
    },
    onClose: (reason) => {
      // A close after we finished is benign; otherwise it's a failure.
      if (!finished) fail(reason);
    },
    onError: (reason) => fail(reason),
  });

  if (!connection) {
    // openTransfer already invoked onError via its own handler path.
    return { cancel: () => undefined };
  }

  return {
    cancel: () => {
      cancelled = true;
      connection?.close('user_cancelled');
      fail('user_cancelled');
    },
  };
}

/**
 * RECEIVER side (NEW device). Prepares to accept an inbound transfer from one of
 * the user's OWN other devices, buffers chunks, verifies the checksum, and
 * applies the history atomically.
 *
 * The receiver does not know the OLD device's id up front (the pairing code flows
 * new→old, carrying the NEW device's address). It therefore registers for the
 * first transfer offer from its own account (`ownUserId`) and learns the sender
 * device from the signaling handshake. Authenticity is enforced by the AEAD: only
 * a peer holding the transfer key derived from the out-of-band secret can produce
 * frames that decrypt.
 */
export function startHistoryReceive(
  secret: Uint8Array,
  ownUserId: string,
  callbacks: TransferDriverCallbacks
): TransferHandle {
  const transferKeyBytes = deriveTransferKey(secret);
  const receiver = new HistoryReceiver(transferKeyBytes);
  let finished = false;
  let connection: TransferConnection | null = null;

  const fail = (reason: string) => {
    if (finished) return;
    finished = true;
    connection?.close(reason);
    callbacks.onError?.(reason);
  };

  callbacks.onProgress?.({
    phase: 'connecting',
    current: 0,
    total: 0,
    conversationCount: 0,
    totalMessages: 0,
  });

  connection = p2pManager.prepareTransferResponder(ownUserId, {
    onOpen: () => {
      callbacks.onProgress?.({
        phase: 'transferring',
        current: 0,
        total: 0,
        conversationCount: 0,
        totalMessages: 0,
      });
    },
    onFrame: (raw) => {
      if (finished) return;
      let frame: HistoryFrame;
      try {
        frame = JSON.parse(raw) as HistoryFrame;
      } catch {
        fail('bad_frame');
        return;
      }
      try {
        const result = receiver.feed(frame);
        if (result.status === 'progress') {
          callbacks.onProgress?.({
            phase: 'transferring',
            current: result.progress.receivedChunks,
            total: result.progress.totalChunks,
            conversationCount: result.progress.conversationCount,
            totalMessages: result.progress.totalMessages,
          });
          return;
        }
        // Complete: apply atomically, then signal success.
        callbacks.onProgress?.({
          phase: 'applying',
          current: result.progress.receivedChunks,
          total: result.progress.totalChunks,
          conversationCount: result.progress.conversationCount,
          totalMessages: result.progress.totalMessages,
        });
        void (async () => {
          try {
            await applyTransferredHistory(result.payload);
            if (finished) return;
            finished = true;
            callbacks.onProgress?.({
              phase: 'done',
              current: result.progress.totalChunks,
              total: result.progress.totalChunks,
              conversationCount: result.progress.conversationCount,
              totalMessages: result.progress.totalMessages,
            });
            connection?.close('complete');
            callbacks.onComplete?.();
          } catch (err) {
            fail(err instanceof Error ? err.message : 'apply_failed');
          }
        })();
      } catch (err) {
        // Any protocol/crypto violation: discard everything (no partial apply).
        fail(err instanceof Error ? err.message : 'transfer_failed');
      }
    },
    onClose: (reason) => {
      if (!finished) fail(reason);
    },
    onError: (reason) => {
      if (!finished) fail(reason);
    },
  });

  return {
    cancel: () => fail('user_cancelled'),
  };
}

// --- Local cache I/O (sender collect / receiver apply) ----------------------

/**
 * Collect the device's local plaintext history into a serializable payload.
 * Reads every conversation in the local cache and its decrypted messages. Only
 * messages that decrypted to plaintext are useful to a new device, so messages
 * still flagged `isEncrypted` (an undecryptable placeholder) are dropped — they
 * would be meaningless on the receiver, which has no Signal session for them.
 */
export async function collectLocalHistory(): Promise<HistoryPayload> {
  const conversations = (await getConversationsLocally()) as Conversation[];
  const messages: Record<string, SerializableMessage[]> = {};

  for (const conversation of conversations) {
    const local = await getMessagesLocally(conversation.id);
    const serializable = local
      .filter((m) => !m.isEncrypted)
      .map((m) => toSerializableMessage(m));
    if (serializable.length > 0) {
      messages[conversation.id] = serializable;
    }
  }

  return { version: HISTORY_PAYLOAD_VERSION, conversations, messages };
}

/** Flatten a `Message` (Date fields) into its JSON-transportable form. */
function toSerializableMessage(message: Message): SerializableMessage {
  const { timestamp, editedAt, ...rest } = message;
  return {
    ...rest,
    timestamp: toIso(timestamp),
    ...(editedAt ? { editedAt: toIso(editedAt) } : {}),
  };
}

/** Re-hydrate a serialized message back into a store `Message` (Date fields). */
function fromSerializableMessage(message: SerializableMessage): Message {
  const { timestamp, editedAt, ...rest } = message;
  return {
    ...rest,
    timestamp: new Date(timestamp),
    ...(editedAt ? { editedAt: new Date(editedAt) } : {}),
    // Transferred messages are already-decrypted plaintext — never re-encrypt or
    // re-decrypt them on the receiver. Force the flag off defensively.
    isEncrypted: false,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Apply a fully-validated history payload to the local stores of the receiving
 * device. Writes conversations + per-conversation messages to offline storage so
 * the next conversation list / message fetch reads them. This runs ONLY after the
 * receiver verified the checksum (atomic apply — never on partial data).
 *
 * Existing local data is merged conservatively: for each conversation we union the
 * transferred messages with anything already present (dedup by id), so a re-run is
 * idempotent and a device that already received some messages live is not clobbered.
 */
export async function applyTransferredHistory(payload: HistoryPayload): Promise<void> {
  // Merge conversations: keep existing entries, add any new ones from the transfer.
  const existingConversations = (await getConversationsLocally()) as Conversation[];
  const byId = new Map<string, Conversation>();
  for (const c of existingConversations) byId.set(c.id, c);
  for (const c of payload.conversations) {
    if (!byId.has(c.id)) byId.set(c.id, c);
  }
  await storeConversationsLocally(Array.from(byId.values()));

  // Merge messages per conversation (union by message id), then persist.
  for (const conversationId of Object.keys(payload.messages)) {
    const incoming = (payload.messages[conversationId] ?? []).map(fromSerializableMessage);
    const existing = await getMessagesLocally(conversationId);
    const seen = new Set(existing.map((m) => m.id));
    const merged = [...existing];
    for (const m of incoming) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }
    merged.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    await storeMessagesLocally(conversationId, merged);
  }
}
