/**
 * Tests for the P2P history-transfer protocol (Fase 1C).
 *
 * Covers the pure, transport-agnostic core:
 *  - transfer-key derivation is deterministic for the same secret, distinct otherwise
 *  - full round-trip: serialize → chunk → encrypt → frames → receiver → checksum OK
 *  - multi-chunk payloads reassemble correctly
 *  - chunk tampering fails the AEAD tag
 *  - a reordered / wrong-seq chunk is rejected
 *  - checksum mismatch is rejected
 *  - cancel mid-transfer surfaces as a hard failure (caller discards — no partial)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  deriveTransferKey,
  generateTransferSecret,
  buildTransferFrames,
  HistoryReceiver,
  serializePayload,
  chunkBytes,
  encryptChunk,
  decryptChunk,
  checksumOf,
  encodePairingPayload,
  decodePairingPayload,
  formatPairingCodeForDisplay,
  normalizePairingCode,
  applyTransferredHistory,
  collectLocalHistory,
  TRANSFER_SECRET_LENGTH,
  MAX_CHUNK_PLAINTEXT_BYTES,
  MAX_TRANSFER_CHUNK_COUNT,
  HISTORY_PAYLOAD_VERSION,
  CHECKSUM_ALGO,
  type HistoryPayload,
  type HistoryChunkFrame,
  type HistoryFrame,
} from '@/lib/historyTransfer';
import {
  storeMessagesLocally,
  storeConversationsLocally,
  getMessagesLocally,
  getConversationsLocally,
} from '@/lib/offlineStorage';

function samplePayload(messageCount = 3): HistoryPayload {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    id: `m${i}`,
    text: `message ${i}`,
    senderId: i % 2 === 0 ? 'userA' : 'userB',
    senderDeviceId: 1,
    timestamp: new Date(1700000000000 + i * 1000).toISOString(),
    isSent: i % 2 === 0,
    conversationId: 'conv1',
    isEncrypted: false,
    messageType: 'user' as const,
  }));
  return {
    version: HISTORY_PAYLOAD_VERSION,
    conversations: [
      {
        id: 'conv1',
        type: 'direct',
        name: 'Alice',
        lastMessage: `message ${messageCount - 1}`,
        timestamp: new Date(1700000000000).toISOString(),
        unreadCount: 0,
      },
    ],
    messages: { conv1: messages },
  };
}

/** Drive every frame through a fresh receiver and return the final result. */
function runTransfer(payload: HistoryPayload, key: Uint8Array) {
  const frames = buildTransferFrames(key, payload);
  const receiver = new HistoryReceiver(key);
  let last = receiver.feed(frames[0]);
  for (let i = 1; i < frames.length; i++) {
    last = receiver.feed(frames[i]);
  }
  return last;
}

describe('deriveTransferKey', () => {
  it('is deterministic for the same secret', () => {
    const secret = new Uint8Array(TRANSFER_SECRET_LENGTH).fill(7);
    const a = deriveTransferKey(secret);
    const b = deriveTransferKey(secret);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(32);
  });

  it('produces different keys for different secrets', () => {
    const a = deriveTransferKey(new Uint8Array(TRANSFER_SECRET_LENGTH).fill(1));
    const b = deriveTransferKey(new Uint8Array(TRANSFER_SECRET_LENGTH).fill(2));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('rejects a secret of the wrong length', () => {
    expect(() => deriveTransferKey(new Uint8Array(16))).toThrow();
  });

  it('generateTransferSecret yields 32 fresh bytes', () => {
    const s1 = generateTransferSecret();
    const s2 = generateTransferSecret();
    expect(s1.length).toBe(TRANSFER_SECRET_LENGTH);
    expect(Array.from(s1)).not.toEqual(Array.from(s2));
  });
});

describe('history transfer round-trip', () => {
  it('serialize → chunk → encrypt → receiver → checksum OK', () => {
    const key = deriveTransferKey(generateTransferSecret());
    const payload = samplePayload(3);
    const result = runTransfer(payload, key);
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.payload.conversations).toHaveLength(1);
    expect(result.payload.messages.conv1).toHaveLength(3);
    expect(result.payload.messages.conv1[0].text).toBe('message 0');
    expect(result.progress.totalMessages).toBe(3);
  });

  it('reassembles a multi-chunk payload', () => {
    const key = deriveTransferKey(generateTransferSecret());
    // Build a payload whose serialization spans several chunks.
    const payload = samplePayload(2000);
    const bytes = serializePayload(payload);
    expect(bytes.length).toBeGreaterThan(MAX_CHUNK_PLAINTEXT_BYTES);
    const expectedChunks = chunkBytes(bytes).length;
    expect(expectedChunks).toBeGreaterThan(1);

    const result = runTransfer(payload, key);
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.payload.messages.conv1).toHaveLength(2000);
    expect(result.progress.receivedChunks).toBe(expectedChunks);
  });

  it('round-trips an empty payload as a single chunk', () => {
    const key = deriveTransferKey(generateTransferSecret());
    const payload: HistoryPayload = {
      version: HISTORY_PAYLOAD_VERSION,
      conversations: [],
      messages: {},
    };
    const result = runTransfer(payload, key);
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.payload.conversations).toHaveLength(0);
  });
});

describe('chunk AEAD', () => {
  it('decryptChunk recovers the plaintext', () => {
    const key = deriveTransferKey(generateTransferSecret());
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    const dataB64 = encryptChunk(key, 0, 1, plaintext);
    const recovered = decryptChunk(key, 0, 1, dataB64);
    expect(Array.from(recovered)).toEqual(Array.from(plaintext));
  });

  it('fails to decrypt with the wrong seq (AAD mismatch)', () => {
    const key = deriveTransferKey(generateTransferSecret());
    const dataB64 = encryptChunk(key, 0, 2, new Uint8Array([9, 9, 9]));
    expect(() => decryptChunk(key, 1, 2, dataB64)).toThrow();
  });

  it('fails to decrypt with the wrong key', () => {
    const key = deriveTransferKey(new Uint8Array(TRANSFER_SECRET_LENGTH).fill(1));
    const wrong = deriveTransferKey(new Uint8Array(TRANSFER_SECRET_LENGTH).fill(2));
    const dataB64 = encryptChunk(key, 0, 1, new Uint8Array([1, 2, 3]));
    expect(() => decryptChunk(wrong, 0, 1, dataB64)).toThrow();
  });
});

describe('tampering + protocol violations', () => {
  it('a tampered chunk fails the AEAD tag at the receiver', () => {
    const key = deriveTransferKey(generateTransferSecret());
    const payload = samplePayload(3);
    const frames = buildTransferFrames(key, payload);

    // Flip a byte inside the first chunk's ciphertext.
    const chunkFrame = frames.find((f) => f.type === 'history:chunk') as HistoryChunkFrame;
    const raw = Uint8Array.from(atob(chunkFrame.dataB64), (c) => c.charCodeAt(0));
    raw[raw.length - 1] ^= 0xff;
    chunkFrame.dataB64 = btoa(String.fromCharCode(...raw));

    const receiver = new HistoryReceiver(key);
    receiver.feed(frames[0]);
    expect(() => receiver.feed(chunkFrame)).toThrow();
  });

  it('rejects an out-of-order chunk', () => {
    const key = deriveTransferKey(generateTransferSecret());
    const payload = samplePayload(2000); // multi-chunk
    const frames = buildTransferFrames(key, payload);
    const receiver = new HistoryReceiver(key);
    receiver.feed(frames[0]); // begin
    receiver.feed(frames[1]); // chunk seq 0
    // Skip to chunk seq 2 (frames[3]) — should be rejected as out-of-order.
    expect(() => receiver.feed(frames[3])).toThrow();
  });

  it('rejects a checksum mismatch', () => {
    const key = deriveTransferKey(generateTransferSecret());
    const payload = samplePayload(3);
    const frames = buildTransferFrames(key, payload);
    const endFrame = frames[frames.length - 1];
    if (endFrame.type !== 'history:end') throw new Error('expected end frame');
    endFrame.checksum = checksumOf(new Uint8Array([0, 0, 0])); // wrong

    const receiver = new HistoryReceiver(key);
    for (let i = 0; i < frames.length - 1; i++) receiver.feed(frames[i]);
    expect(() => receiver.feed(endFrame)).toThrow();
  });

  it('treats a cancel frame as a hard failure', () => {
    const key = deriveTransferKey(generateTransferSecret());
    const receiver = new HistoryReceiver(key);
    receiver.feed(buildTransferFrames(key, samplePayload(1))[0]); // begin
    expect(() => receiver.feed({ type: 'history:cancel', reason: 'user_cancelled' })).toThrow();
  });

  it('rejects history:end before all chunks arrive (no partial completion)', () => {
    const key = deriveTransferKey(generateTransferSecret());
    const payload = samplePayload(2000); // multi-chunk
    const frames = buildTransferFrames(key, payload);
    const receiver = new HistoryReceiver(key);
    receiver.feed(frames[0]); // begin
    receiver.feed(frames[1]); // only first chunk
    const endFrame = frames[frames.length - 1];
    expect(() => receiver.feed(endFrame)).toThrow();
  });
});

describe('chunk-count cap (unbounded-memory guard)', () => {
  it('receiver rejects a history:begin declaring more chunks than the cap', () => {
    const key = deriveTransferKey(generateTransferSecret());
    const receiver = new HistoryReceiver(key);
    expect(() =>
      receiver.feed({
        type: 'history:begin',
        version: HISTORY_PAYLOAD_VERSION,
        conversationCount: 1,
        totalMessages: 1,
        chunkCount: MAX_TRANSFER_CHUNK_COUNT + 1,
        checksumAlgo: CHECKSUM_ALGO,
      })
    ).toThrow(/exceeds the cap/);
  });

  it('receiver accepts a history:begin exactly at the cap', () => {
    const key = deriveTransferKey(generateTransferSecret());
    const receiver = new HistoryReceiver(key);
    const result = receiver.feed({
      type: 'history:begin',
      version: HISTORY_PAYLOAD_VERSION,
      conversationCount: 1,
      totalMessages: 1,
      chunkCount: MAX_TRANSFER_CHUNK_COUNT,
      checksumAlgo: CHECKSUM_ALGO,
    });
    expect(result.status).toBe('progress');
  });

  it('sender refuses to build a stream larger than the cap (fail fast)', () => {
    const key = deriveTransferKey(generateTransferSecret());
    // Force the serialized payload past the cap by stuffing one conversation with
    // a single huge field, so chunkCount = ceil(bytes / MAX_CHUNK_PLAINTEXT_BYTES)
    // exceeds MAX_TRANSFER_CHUNK_COUNT.
    const oversizeBytes = (MAX_TRANSFER_CHUNK_COUNT + 1) * MAX_CHUNK_PLAINTEXT_BYTES;
    const payload: HistoryPayload = {
      version: HISTORY_PAYLOAD_VERSION,
      conversations: [
        {
          id: 'big',
          type: 'direct',
          name: 'x'.repeat(oversizeBytes),
          lastMessage: '',
          timestamp: '',
          unreadCount: 0,
        },
      ],
      messages: {},
    };
    expect(() => buildTransferFrames(key, payload)).toThrow(/too large/);
  });
});

describe('pairing code encode/decode', () => {
  const secret = new Uint8Array(TRANSFER_SECRET_LENGTH).map((_, i) => (i * 7) % 256);

  it('round-trips a pairing payload', () => {
    const code = encodePairingPayload({ userId: 'user.with.dots', deviceId: 3, secret });
    const decoded = decodePairingPayload(code);
    expect(decoded.userId).toBe('user.with.dots');
    expect(decoded.deviceId).toBe(3);
    expect(Array.from(decoded.secret)).toEqual(Array.from(secret));
  });

  it('tolerates grouping and whitespace introduced by manual entry', () => {
    const code = encodePairingPayload({ userId: 'u1', deviceId: 2, secret });
    const grouped = formatPairingCodeForDisplay(code);
    expect(grouped).toContain('-');
    expect(normalizePairingCode(grouped)).toBe(code);
    const decoded = decodePairingPayload(grouped);
    expect(decoded.deviceId).toBe(2);
    expect(Array.from(decoded.secret)).toEqual(Array.from(secret));
  });

  it('rejects a malformed code', () => {
    expect(() => decodePairingPayload('not-a-valid-code!!!')).toThrow();
    expect(() => decodePairingPayload('')).toThrow();
  });

  it('rejects a code carrying a wrong-length secret', () => {
    const badJson = JSON.stringify({ v: 1, u: 'u1', d: 1, s: btoa('short') });
    const code = btoa(badJson).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(() => decodePairingPayload(code)).toThrow();
  });

  it('rejects an invalid device id in the code', () => {
    const badJson = JSON.stringify({
      v: 1,
      u: 'u1',
      d: 0,
      s: btoa(String.fromCharCode(...secret)),
    });
    const code = btoa(badJson).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(() => decodePairingPayload(code)).toThrow();
  });
});

describe('local cache apply + collect', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('collectLocalHistory excludes still-encrypted (undecryptable) messages', async () => {
    await storeConversationsLocally([
      { id: 'c1', type: 'direct', name: 'Bob', lastMessage: 'hi', timestamp: '', unreadCount: 0 },
    ]);
    await storeMessagesLocally('c1', [
      {
        id: 'plain',
        text: 'readable',
        senderId: 'u2',
        timestamp: new Date(),
        isSent: false,
        conversationId: 'c1',
        isEncrypted: false,
      },
      {
        id: 'enc',
        text: '[Encrypted - Decryption failed]',
        senderId: 'u2',
        timestamp: new Date(),
        isSent: false,
        conversationId: 'c1',
        isEncrypted: true,
      },
    ]);

    const payload = await collectLocalHistory();
    expect(payload.conversations).toHaveLength(1);
    expect(payload.messages.c1).toHaveLength(1);
    expect(payload.messages.c1[0].id).toBe('plain');
  });

  it('applyTransferredHistory writes conversations + messages and is idempotent', async () => {
    const payload: HistoryPayload = {
      version: HISTORY_PAYLOAD_VERSION,
      conversations: [
        { id: 'c1', type: 'direct', name: 'Bob', lastMessage: 'hi', timestamp: '', unreadCount: 0 },
      ],
      messages: {
        c1: [
          {
            id: 'm1',
            text: 'hello',
            senderId: 'u2',
            timestamp: new Date(1700000000000).toISOString(),
            isSent: false,
            conversationId: 'c1',
            isEncrypted: false,
          },
        ],
      },
    };

    await applyTransferredHistory(payload);
    let convs = await getConversationsLocally();
    let msgs = await getMessagesLocally('c1');
    expect(convs).toHaveLength(1);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('hello');

    // Re-apply: must not duplicate (union by id).
    await applyTransferredHistory(payload);
    convs = await getConversationsLocally();
    msgs = await getMessagesLocally('c1');
    expect(convs).toHaveLength(1);
    expect(msgs).toHaveLength(1);
  });
});

describe('atomic apply (no partial writes on failure)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  /**
   * Simulates the receiver driver's contract: chunks are buffered in memory and
   * applied to storage ONLY after the checksum verifies. A failure mid-stream
   * (here: a cancel frame) must leave the receiver's local store untouched.
   */
  it('leaves the receiver store untouched when the transfer is cancelled mid-stream', async () => {
    const key = deriveTransferKey(generateTransferSecret());
    const payload = samplePayload(2000); // multi-chunk so cancel lands mid-stream
    const frames = buildTransferFrames(key, payload);
    const receiver = new HistoryReceiver(key);

    // Drive begin + a couple of chunks, then a cancel. The receiver buffers but
    // never produces a 'complete', so nothing is applied.
    let applied: HistoryPayload | null = null;
    const feedAndMaybeApply = async (frame: HistoryFrame) => {
      const result = receiver.feed(frame);
      if (result.status === 'complete') {
        applied = result.payload;
        await applyTransferredHistory(result.payload);
      }
    };

    await feedAndMaybeApply(frames[0]); // begin
    await feedAndMaybeApply(frames[1]); // chunk 0
    await feedAndMaybeApply(frames[2]); // chunk 1
    await expect(
      feedAndMaybeApply({ type: 'history:cancel', reason: 'user_cancelled' })
    ).rejects.toThrow();

    expect(applied).toBeNull();
    // Storage must be completely empty — no partial conversations or messages.
    expect(await getConversationsLocally()).toHaveLength(0);
    expect(await getMessagesLocally('conv1')).toHaveLength(0);
  });

  it('applies only after the checksum verifies (full success path writes once)', async () => {
    const key = deriveTransferKey(generateTransferSecret());
    const payload = samplePayload(5);
    const frames = buildTransferFrames(key, payload);
    const receiver = new HistoryReceiver(key);

    let applied = false;
    for (const frame of frames) {
      const result = receiver.feed(frame);
      if (result.status === 'complete') {
        await applyTransferredHistory(result.payload);
        applied = true;
      } else {
        // Nothing should be written before completion.
        expect(await getMessagesLocally('conv1')).toHaveLength(0);
      }
    }
    expect(applied).toBe(true);
    expect(await getMessagesLocally('conv1')).toHaveLength(5);
  });
});
