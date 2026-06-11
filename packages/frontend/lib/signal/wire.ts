/**
 * Wire format for encrypted messages.
 *
 * A wire message is a base64-encoded JSON object:
 *  {
 *    v: 2,
 *    dh: base64,          // ratchet sender DH public key
 *    pn: number,          // previous chain length
 *    n: number,           // message number
 *    ct: base64,          // nonce(12) || AEAD ciphertext
 *    x3dh?: {             // present only for the very first message in a session
 *      ek:   base64,      // initiator ephemeral public key
 *      ikE:  base64,      // initiator Ed25519 identity public key
 *      ikD:  base64,      // initiator X25519 identity public key
 *      spk:  number,      // signed prekey id used
 *      opk?: number       // optional one-time prekey id used
 *    }
 *  }
 */

import { bytesToBase64, base64ToBytes } from './keys';
import { EncryptedRatchetMessage } from './doubleRatchet';

export const WIRE_VERSION = 2;

export interface X3dhWireHeader {
  ek: string;
  ikE: string;
  ikD: string;
  spk: number;
  opk?: number;
}

export interface WireMessage {
  v: number;
  dh: string;
  pn: number;
  n: number;
  ct: string;
  x3dh?: X3dhWireHeader;
}

export function encodeWire(
  msg: EncryptedRatchetMessage,
  x3dh?: X3dhWireHeader
): string {
  const wire: WireMessage = {
    v: WIRE_VERSION,
    dh: bytesToBase64(msg.header.dh),
    pn: msg.header.pn,
    n: msg.header.n,
    ct: bytesToBase64(msg.body),
  };
  if (x3dh) wire.x3dh = x3dh;
  return btoa(JSON.stringify(wire));
}

export interface DecodedWire {
  message: EncryptedRatchetMessage;
  x3dh?: X3dhWireHeader;
  version: number;
}

export class LegacyMessageError extends Error {
  constructor() {
    super('Legacy/unknown encrypted message format');
    this.name = 'LegacyMessageError';
  }
}

export function decodeWire(payload: string): DecodedWire {
  let json: string;
  try {
    json = atob(payload);
  } catch {
    throw new LegacyMessageError();
  }

  let parsed: WireMessage;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new LegacyMessageError();
  }

  if (!parsed || typeof parsed !== 'object' || parsed.v !== WIRE_VERSION) {
    throw new LegacyMessageError();
  }
  if (
    typeof parsed.dh !== 'string' ||
    typeof parsed.ct !== 'string' ||
    typeof parsed.pn !== 'number' ||
    typeof parsed.n !== 'number'
  ) {
    throw new LegacyMessageError();
  }

  return {
    version: parsed.v,
    message: {
      header: {
        dh: base64ToBytes(parsed.dh),
        pn: parsed.pn,
        n: parsed.n,
      },
      body: base64ToBytes(parsed.ct),
    },
    x3dh: parsed.x3dh,
  };
}

/** Best-effort legacy detection without throwing (used for backend validation). */
export function looksLikeWireV2(payload: string): boolean {
  try {
    const obj = JSON.parse(atob(payload));
    return (
      obj &&
      typeof obj === 'object' &&
      obj.v === WIRE_VERSION &&
      typeof obj.dh === 'string' &&
      typeof obj.ct === 'string' &&
      typeof obj.pn === 'number' &&
      typeof obj.n === 'number'
    );
  } catch {
    return false;
  }
}
