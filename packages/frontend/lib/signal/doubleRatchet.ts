/**
 * Double Ratchet implementation.
 *
 * Combines a DH ratchet (X25519) with two symmetric-key ratchets (sending and
 * receiving chains) derived via HKDF-SHA256. Skipped message keys are cached to
 * support out-of-order delivery.
 *
 * Reference: https://signal.org/docs/specifications/doubleratchet/
 */

import {
  KeyPair,
  generateX25519KeyPair,
  dh,
  hkdfDerive,
  deriveChainStep,
  aeadEncrypt,
  aeadDecrypt,
  concatBytes,
  utf8ToBytes,
  bytesToBase64,
  base64ToBytes,
} from './keys';

const ROOT_INFO = utf8ToBytes('AlloRatchetRoot');
const CHAIN_MSG_INFO = utf8ToBytes('AlloChainMessageKey');
const CHAIN_NEXT_INFO = utf8ToBytes('AlloChainNext');

const MAX_SKIP = 1000; // max skipped message keys per chain advance
const MAX_STORED_SKIPPED = 2000; // total cap of cached skipped keys

export interface MessageHeader {
  /** Sender's current DH ratchet public key. */
  dh: Uint8Array;
  /** Previous sending chain length (PN). */
  pn: number;
  /** Message number within the current sending chain (N). */
  n: number;
}

export interface RatchetState {
  /** Our current DH ratchet key pair. */
  dhSelf: KeyPair;
  /** Peer's current DH ratchet public key (null until first received). */
  dhRemote: Uint8Array | null;
  /** Root key. */
  rootKey: Uint8Array;
  /** Sending chain key (null until established). */
  chainKeySend: Uint8Array | null;
  /** Receiving chain key (null until established). */
  chainKeyRecv: Uint8Array | null;
  /** Message number in sending chain. */
  sendN: number;
  /** Message number in receiving chain. */
  recvN: number;
  /** Previous sending chain length. */
  prevSendN: number;
  /** Cached skipped message keys, keyed by `${base64(dhPub)}:${n}`. */
  skipped: Record<string, Uint8Array>;
}

function kdfRootKey(
  rootKey: Uint8Array,
  dhOut: Uint8Array
): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const out = hkdfDerive(dhOut, rootKey, ROOT_INFO, 64);
  return { rootKey: out.subarray(0, 32), chainKey: out.subarray(32, 64) };
}

function kdfChainKey(chainKey: Uint8Array): {
  chainKey: Uint8Array;
  messageKey: Uint8Array;
} {
  const messageKey = deriveChainStep(chainKey, CHAIN_MSG_INFO);
  const nextChainKey = deriveChainStep(chainKey, CHAIN_NEXT_INFO);
  return { chainKey: nextChainKey, messageKey };
}

/**
 * Initialize ratchet for the initiator (Alice). She already knows the receiver's
 * signed prekey (used as the initial remote DH key) and performs the first DH
 * ratchet step immediately so she can send.
 */
export function initRatchetInitiator(
  sharedSecret: Uint8Array,
  remoteSignedPreKey: Uint8Array
): RatchetState {
  const dhSelf = generateX25519KeyPair();
  const { rootKey, chainKey } = kdfRootKey(
    sharedSecret,
    dh(dhSelf.privateKey, remoteSignedPreKey)
  );
  return {
    dhSelf,
    dhRemote: remoteSignedPreKey,
    rootKey,
    chainKeySend: chainKey,
    chainKeyRecv: null,
    sendN: 0,
    recvN: 0,
    prevSendN: 0,
    skipped: {},
  };
}

/**
 * Initialize ratchet for the receiver (Bob). His DH ratchet key pair IS his
 * signed prekey pair, so the first message from Alice triggers a DH ratchet step.
 */
export function initRatchetReceiver(
  sharedSecret: Uint8Array,
  signedPreKeyPair: KeyPair
): RatchetState {
  return {
    dhSelf: signedPreKeyPair,
    dhRemote: null,
    rootKey: sharedSecret,
    chainKeySend: null,
    chainKeyRecv: null,
    sendN: 0,
    recvN: 0,
    prevSendN: 0,
    skipped: {},
  };
}

export interface EncryptedRatchetMessage {
  header: MessageHeader;
  body: Uint8Array; // nonce || aead ciphertext
}

function headerBytes(header: MessageHeader): Uint8Array {
  const meta = new Uint8Array(8);
  const view = new DataView(meta.buffer);
  view.setUint32(0, header.pn, false);
  view.setUint32(4, header.n, false);
  return concatBytes(header.dh, meta);
}

export function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array
): EncryptedRatchetMessage {
  if (!state.chainKeySend) {
    throw new Error('Ratchet: sending chain not initialized');
  }
  const { chainKey, messageKey } = kdfChainKey(state.chainKeySend);
  state.chainKeySend = chainKey;

  const header: MessageHeader = {
    dh: state.dhSelf.publicKey,
    pn: state.prevSendN,
    n: state.sendN,
  };
  state.sendN += 1;

  const ad = headerBytes(header);
  const body = aeadEncrypt(messageKey, plaintext, ad);
  return { header, body };
}

function skippedKey(dhPub: Uint8Array, n: number): string {
  return `${bytesToBase64(dhPub)}:${n}`;
}

function skipMessageKeys(state: RatchetState, until: number): void {
  if (state.chainKeyRecv === null) return;
  if (until - state.recvN > MAX_SKIP) {
    throw new Error('Ratchet: too many skipped messages');
  }
  while (state.recvN < until) {
    const { chainKey, messageKey } = kdfChainKey(state.chainKeyRecv);
    state.chainKeyRecv = chainKey;
    if (state.dhRemote) {
      const key = skippedKey(state.dhRemote, state.recvN);
      state.skipped[key] = messageKey;
    }
    state.recvN += 1;
  }
  // Cap the number of stored skipped keys (drop oldest insertion order).
  const keys = Object.keys(state.skipped);
  if (keys.length > MAX_STORED_SKIPPED) {
    for (const k of keys.slice(0, keys.length - MAX_STORED_SKIPPED)) {
      delete state.skipped[k];
    }
  }
}

function dhRatchet(state: RatchetState, header: MessageHeader): void {
  state.prevSendN = state.sendN;
  state.sendN = 0;
  state.recvN = 0;
  state.dhRemote = header.dh;

  // Receiving chain.
  const recv = kdfRootKey(state.rootKey, dh(state.dhSelf.privateKey, header.dh));
  state.rootKey = recv.rootKey;
  state.chainKeyRecv = recv.chainKey;

  // New sending ratchet key.
  state.dhSelf = generateX25519KeyPair();
  const send = kdfRootKey(state.rootKey, dh(state.dhSelf.privateKey, header.dh));
  state.rootKey = send.rootKey;
  state.chainKeySend = send.chainKey;
}

export function ratchetDecrypt(
  state: RatchetState,
  message: EncryptedRatchetMessage
): Uint8Array {
  const { header, body } = message;
  const ad = headerBytes(header);

  // Try cached skipped message keys first.
  const sk = skippedKey(header.dh, header.n);
  if (state.skipped[sk]) {
    const messageKey = state.skipped[sk];
    const pt = aeadDecrypt(messageKey, body, ad);
    delete state.skipped[sk];
    return pt;
  }

  // If the message uses a new DH ratchet key, perform a DH ratchet step.
  const isNewRatchet =
    state.dhRemote === null || bytesToBase64(header.dh) !== bytesToBase64(state.dhRemote);

  if (isNewRatchet) {
    // Skip remaining keys in the previous receiving chain up to header.pn.
    if (state.chainKeyRecv !== null) {
      skipMessageKeys(state, header.pn);
    }
    dhRatchet(state, header);
  }

  // Skip keys in the current receiving chain up to header.n.
  skipMessageKeys(state, header.n);

  if (!state.chainKeyRecv) {
    throw new Error('Ratchet: receiving chain not initialized');
  }
  const { chainKey, messageKey } = kdfChainKey(state.chainKeyRecv);
  state.chainKeyRecv = chainKey;
  state.recvN += 1;

  return aeadDecrypt(messageKey, body, ad);
}

// ---------------------------------------------------------------------------
// Serialization (state <-> JSON-safe object with base64 strings).
// ---------------------------------------------------------------------------

export interface SerializedRatchetState {
  dhSelfPub: string;
  dhSelfPriv: string;
  dhRemote: string | null;
  rootKey: string;
  chainKeySend: string | null;
  chainKeyRecv: string | null;
  sendN: number;
  recvN: number;
  prevSendN: number;
  skipped: Record<string, string>;
}

export function serializeRatchet(state: RatchetState): SerializedRatchetState {
  const skipped: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.skipped)) {
    skipped[k] = bytesToBase64(v);
  }
  return {
    dhSelfPub: bytesToBase64(state.dhSelf.publicKey),
    dhSelfPriv: bytesToBase64(state.dhSelf.privateKey),
    dhRemote: state.dhRemote ? bytesToBase64(state.dhRemote) : null,
    rootKey: bytesToBase64(state.rootKey),
    chainKeySend: state.chainKeySend ? bytesToBase64(state.chainKeySend) : null,
    chainKeyRecv: state.chainKeyRecv ? bytesToBase64(state.chainKeyRecv) : null,
    sendN: state.sendN,
    recvN: state.recvN,
    prevSendN: state.prevSendN,
    skipped,
  };
}

export function deserializeRatchet(data: SerializedRatchetState): RatchetState {
  const skipped: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(data.skipped)) {
    skipped[k] = base64ToBytes(v);
  }
  return {
    dhSelf: {
      publicKey: base64ToBytes(data.dhSelfPub),
      privateKey: base64ToBytes(data.dhSelfPriv),
    },
    dhRemote: data.dhRemote ? base64ToBytes(data.dhRemote) : null,
    rootKey: base64ToBytes(data.rootKey),
    chainKeySend: data.chainKeySend ? base64ToBytes(data.chainKeySend) : null,
    chainKeyRecv: data.chainKeyRecv ? base64ToBytes(data.chainKeyRecv) : null,
    sendN: data.sendN,
    recvN: data.recvN,
    prevSendN: data.prevSendN,
    skipped,
  };
}
