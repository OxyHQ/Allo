/**
 * Instance-bound requests are signed by the instance's Ed25519 key.
 *
 * Every instance-signed route carries three headers:
 *
 *   X-Allo-Instance    the instance id
 *   X-Allo-Timestamp   unix time in MILLISECONDS, as decimal text
 *   X-Allo-Signature   base64 Ed25519 signature over {@link signedRequestMessage}
 *
 * The signature covers method, path WITH query, timestamp and the SHA-256 of
 * the raw body bytes, so a captured request can be replayed only within the
 * skew window and only verbatim. The server rejects a timestamp more than
 * {@link MAX_CLOCK_SKEW_MS} from its clock, an unknown or non-active instance,
 * and an instance whose account is not the Oxy session's.
 *
 * Socket.IO carries the same three fields in `handshake.auth`
 * ({@link socketAuthSchema}) with the path fixed to {@link SOCKET_SIGNING_PATH}
 * and an empty body.
 */
import { z } from "zod";
import { ed25519SignatureSchema, instanceIdSchema, nonNegativeIntSchema, SHA256_HEX_PATTERN } from "./common";

export const INSTANCE_HEADER = "x-allo-instance";
export const TIMESTAMP_HEADER = "x-allo-timestamp";
export const SIGNATURE_HEADER = "x-allo-signature";

/** Domain separator, first line of every signed request message. */
export const REQUEST_SIGNING_CONTEXT = "allo-v1";

export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The `pathWithQuery` a Socket.IO handshake is signed over. Its body is empty. */
export const SOCKET_SIGNING_PATH = "/socket";

export interface SignedRequestInput {
  /** HTTP method; upper-cased before signing, so `get` and `GET` sign the same bytes. */
  method: string;
  /** The request target as sent: path plus `?query` when there is one, starting with `/`. */
  pathWithQuery: string;
  /** Unix time in milliseconds. */
  timestampMs: number;
  /**
   * Lowercase hex SHA-256 of the RAW body bytes as transmitted (after JSON
   * serialisation, before any transport encoding), or of the empty string
   * ({@link EMPTY_BODY_SHA256_HEX}) when the request has no body.
   */
  bodySha256Hex: string;
}

/**
 * The bytes (as a UTF-8 string) an instance signs and the server verifies:
 *
 *     "allo-v1\n" + METHOD + "\n" + pathWithQuery + "\n" + String(timestampMs) + "\n" + bodySha256Hex
 *
 * Throws on input that could not have come from a well-formed request, so a
 * signer bug fails at the signer rather than as a 401 at the far end.
 */
export function signedRequestMessage(input: SignedRequestInput): string {
  if (!/^[A-Za-z]+$/.test(input.method)) throw new RangeError("method must be an HTTP method token");
  if (!input.pathWithQuery.startsWith("/")) throw new RangeError("pathWithQuery must start with '/'");
  if (!Number.isInteger(input.timestampMs) || input.timestampMs < 0) {
    throw new RangeError("timestampMs must be a non-negative integer");
  }
  if (!SHA256_HEX_PATTERN.test(input.bodySha256Hex)) throw new RangeError("bodySha256Hex must be 64 lowercase hex chars");
  return (
    REQUEST_SIGNING_CONTEXT +
    "\n" +
    input.method.toUpperCase() +
    "\n" +
    input.pathWithQuery +
    "\n" +
    String(input.timestampMs) +
    "\n" +
    input.bodySha256Hex
  );
}

/** The `auth` object of the Socket.IO handshake on the `/v1` namespace. */
export const socketAuthSchema = z.object({
  instanceId: instanceIdSchema,
  /** Unix time in milliseconds. */
  timestamp: nonNegativeIntSchema,
  /** Ed25519 over `signedRequestMessage({ method: "GET", pathWithQuery: "/socket", timestampMs, bodySha256Hex: EMPTY_BODY_SHA256_HEX })`. */
  signature: ed25519SignatureSchema,
});
export type SocketAuth = z.infer<typeof socketAuthSchema>;
