/**
 * Local identifiers. A uuid v7 (time-ordered, random tail) so ids the SDK
 * mints sort by creation and satisfy `idSchema` / `idempotencyKeySchema`.
 */
import { hexEncode, randomBytes } from "./bytes";

let lastMs = 0;
let counter = 0;

/**
 * Monotonic within a process: two ids minted in the same millisecond order
 * by a 12-bit counter in `rand_a`, so outbox items created back to back
 * still sort in creation order.
 */
export function uuidV7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  let ms = Math.max(0, Math.floor(nowMs));
  if (ms <= lastMs) {
    ms = lastMs;
    counter = (counter + 1) & 0x0fff;
    if (counter === 0) ms = ++lastMs;
  } else counter = 0;
  lastMs = ms;
  const t = BigInt(ms);
  b[0] = Number((t >> 40n) & 0xffn);
  b[1] = Number((t >> 32n) & 0xffn);
  b[2] = Number((t >> 24n) & 0xffn);
  b[3] = Number((t >> 16n) & 0xffn);
  b[4] = Number((t >> 8n) & 0xffn);
  b[5] = Number(t & 0xffn);
  b[6] = 0x70 | (counter >> 8);
  b[7] = counter & 0xff;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hexEncode(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 32 random bytes as hex: the blob-id shape, also fine for an idempotency key. */
export function randomHexId(): string {
  return hexEncode(randomBytes(32));
}
