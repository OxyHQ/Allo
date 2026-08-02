import { createPrivateKey, sign, type KeyObject } from "crypto";

import type { ApnsCredentials } from "../../config/push";

/**
 * The provider token APNs authenticates every request with.
 *
 * A JWT signed with ES256 over the `.p8` key downloaded from Apple, carrying the
 * team id as issuer and the key id in the header. There is no exchange and no
 * round trip: the token is minted here and presented on the request.
 *
 * ## Why it is cached, and why for fifty minutes
 *
 * Apple's two rules pull in opposite directions. A token is valid for one hour
 * and a request presenting an older one is refused with `ExpiredProviderToken`;
 * but a provider that mints a *new* token more often than once every twenty
 * minutes is refused with `TooManyProviderTokenUpdates`. So neither "mint one
 * per request" nor "mint one and keep it" is correct, and the safe interval is a
 * band rather than a value. Fifty minutes sits inside it with room on both sides
 * — ten minutes before expiry, and far past the twenty-minute floor.
 */

/** How long a minted token is reused before another is signed. */
export const TOKEN_LIFETIME_MS = 50 * 60 * 1000;

export interface ApnsTokenProvider {
  /** The current token, minting a new one only when the last has aged out. */
  token(): string;
}

/**
 * Builds a token provider over one set of credentials.
 *
 * `now` is injected so the caching band can be tested without waiting fifty
 * minutes; nothing else supplies it.
 */
export function createApnsTokenProvider(
  credentials: ApnsCredentials,
  now: () => number = Date.now,
): ApnsTokenProvider {
  // Parsed once. The PEM is a credential and the KeyObject keeps it out of any
  // string that could be logged or serialised by accident.
  const privateKey: KeyObject = createPrivateKey(credentials.privateKeyPem);

  let cachedToken: string | undefined;
  let mintedAt = 0;

  return {
    token(): string {
      const currentTime = now();
      if (cachedToken !== undefined && currentTime - mintedAt < TOKEN_LIFETIME_MS) {
        return cachedToken;
      }
      cachedToken = mintToken(credentials, privateKey, currentTime);
      mintedAt = currentTime;
      return cachedToken;
    },
  };
}

function mintToken(
  credentials: ApnsCredentials,
  privateKey: KeyObject,
  currentTime: number,
): string {
  const header = encodeSegment({ alg: "ES256", kid: credentials.keyId });
  const claims = encodeSegment({
    iss: credentials.teamId,
    iat: Math.floor(currentTime / 1000),
  });
  const signingInput = `${header}.${claims}`;
  /**
   * `ieee-p1363` is not optional. Node signs ECDSA in DER by default, and a JWS
   * signature is the raw `r || s` pair — a DER signature is accepted by nothing,
   * and the failure arrives as APNs refusing every request with
   * `InvalidProviderToken` rather than as an error here.
   */
  const signature = sign("sha256", Buffer.from(signingInput, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function encodeSegment(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
