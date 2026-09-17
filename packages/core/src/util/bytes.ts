/**
 * Byte helpers that run everywhere the SDK runs: Node, browsers and Hermes.
 * Nothing here touches `Buffer`, `atob` or `node:*`; base64 is the standard
 * padded alphabet the wire uses in JSON, base64url comes from
 * `@allo/shared-types`.
 */
import { sha256 } from "@noble/hashes/sha2.js";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = Object.fromEntries(Array.from(B64, (c, i) => [c, i] as const));

/** Standard base64, padded. */
export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

/** Inverse of {@link base64Encode}; tolerates missing padding, throws `RangeError` on a bad character. */
export function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  if (clean.length % 4 === 1) throw new RangeError("malformed base64: impossible length");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const c of clean) {
    const v = B64_LOOKUP[c];
    if (v === undefined) throw new RangeError("malformed base64: bad character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function hexEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function hexDecode(text: string): Uint8Array {
  if (text.length % 2 !== 0 || /[^0-9a-fA-F]/.test(text)) throw new RangeError("malformed hex");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function sha256Hex(bytes: Uint8Array): string {
  return hexEncode(sha256(bytes));
}

export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

/** `crypto.getRandomValues` is the one platform primitive the SDK requires. */
export function randomBytes(n: number): Uint8Array {
  const g = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!g?.getRandomValues) throw new Error("crypto.getRandomValues is not available on this platform");
  return g.getRandomValues(new Uint8Array(n));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** True when `needle` occurs anywhere inside `hay`. Used by tests to prove secrets never hit storage. */
export function bytesInclude(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** RFC 9420 variable-length integer prefix (the QUIC scheme), used for KeyPackageRef. */
export function varLenData(data: Uint8Array): Uint8Array {
  const len = data.length;
  let prefix: Uint8Array;
  if (len < 0x40) prefix = new Uint8Array([len]);
  else if (len < 0x4000) prefix = new Uint8Array([0x40 | (len >> 8), len & 0xff]);
  else if (len < 0x40000000) {
    prefix = new Uint8Array([0x80 | (len >>> 24), (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]);
  } else throw new RangeError("varLenData: too long");
  return concatBytes(prefix, data);
}
