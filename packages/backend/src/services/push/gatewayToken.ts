import { createHash, createHmac, timingSafeEqual } from "crypto";

/**
 * The capability that keeps the push gateway from being a spam relay.
 *
 * ## The problem the Matrix specification leaves open
 *
 * The Push Gateway API has no authentication. Synapse posts to whatever URL the
 * client put in `data.url` and sends no credentials of any kind, and it cannot be
 * made to send any: it is not configured with the gateway, the *client* is. So a
 * gateway published on the internet with no further thought accepts a POST from
 * anybody, and what that POST does is ring a phone. Given a device token —
 * something an app on the same device can read, and which is not secret-grade —
 * an attacker could notify someone else's phone as often as they liked. The
 * gateway is a megaphone pointed at our own users.
 *
 * ## What is available to authenticate with
 *
 * Only the URL. Synapse validates that a pusher's URL has the path
 * `/_matrix/push/v1/notify` and stores the rest verbatim, query string included,
 * so the query string is the one field that travels from the client, through the
 * homeserver, back to us on every notification.
 *
 * It cannot be a constant compiled into the app: a secret shipped to every
 * installation is not a secret. So the URL is **minted per device** by
 * `routes/push.ts`, which is behind Oxy authentication, and the token in it is
 * an HMAC over the pusher's identity:
 *
 *     token = base64url(HMAC-SHA256(secret, length-prefixed(app_id, pushkey)))
 *
 * Which gives the property that matters: producing a URL this gateway will serve
 * requires *both* an Oxy session *and* the device token it is being minted for.
 * Holding a stolen device token is not enough, and holding a stolen URL only
 * reaches the one device it was minted for — the token is bound to that pushkey
 * and to no other, so it cannot be replayed against anybody else.
 *
 * There is no database behind this. The token is recomputed from the request's
 * own `app_id` and `pushkey` and compared; nothing is stored, which is what keeps
 * the promise that Synapse is the only pusher registry.
 *
 * ## What it does not do
 *
 * It does not stop somebody who has *both* halves for a device from notifying
 * that one device repeatedly. Rate limiting is the answer to that, and it
 * deliberately does not live here: this process is one of several behind a load
 * balancer, so an in-memory limiter would be N times looser than it claims while
 * looking exact. It belongs at the edge, where it is shared. See
 * `docs/matrix/push.md` §6.
 */

/** Everything a pusher is identified by, and everything the token is bound to. */
export interface PusherIdentity {
  readonly appId: string;
  readonly pushkey: string;
}

/** The query parameter the token rides in. */
export const GATEWAY_TOKEN_PARAMETER = "t";

/**
 * The two halves of a pusher's identity as one unambiguous message.
 *
 * Length-prefixed rather than joined by a delimiter, so that no two distinct
 * pairs can ever produce the same bytes. A delimiter is only safe if it cannot
 * occur in either half, and a `pushkey` is an opaque provider token whose
 * alphabet is not ours to make promises about. What an ambiguity here would buy
 * an attacker is a token minted for their own device that also authenticates
 * somebody else's.
 */
function signedMessage(identity: PusherIdentity): string {
  return `${identity.appId.length}:${identity.appId}:${identity.pushkey}`;
}

/** The token for one pusher under one secret. */
export function gatewayToken(secret: string, identity: PusherIdentity): string {
  return createHmac("sha256", secret).update(signedMessage(identity), "utf8").digest("base64url");
}

/**
 * The URL a client registers its pusher against.
 *
 * Minted with the FIRST secret, which is what makes rotation work: a new secret
 * is prepended, every URL minted from then on carries it, and the old one keeps
 * verifying the pushers already out there until it is dropped from the list.
 */
export function mintGatewayUrl(
  gatewayUrl: string,
  secret: string,
  identity: PusherIdentity,
): string {
  const url = new URL(gatewayUrl);
  url.searchParams.set(GATEWAY_TOKEN_PARAMETER, gatewayToken(secret, identity));
  return url.toString();
}

/**
 * Whether `supplied` is a token this deployment minted for this pusher.
 *
 * Every secret is tried and the loop does **not** stop at the first match, for
 * the same reason `routes/bridgesInternal.ts` does not: returning early makes the
 * response time depend on which secret matched, which over enough requests says
 * whether a pusher was minted before or after the last rotation.
 */
export function verifyGatewayToken(
  supplied: string,
  identity: PusherIdentity,
  secrets: readonly string[],
): boolean {
  let matched = false;
  for (const secret of secrets) {
    if (constantTimeEquals(supplied, gatewayToken(secret, identity))) {
      matched = true;
    }
  }
  return matched;
}

/**
 * Compares two tokens without leaking their contents through timing.
 *
 * Both sides are hashed first so the comparison is over fixed-length buffers:
 * `timingSafeEqual` throws on a length mismatch, and catching that throw would
 * itself be a length oracle.
 */
function constantTimeEquals(supplied: string, expected: string): boolean {
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}
