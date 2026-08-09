import { randomBytes } from "crypto";
import { uuidv7 } from "@oxyhq/db";
import type { BridgeNetworkId } from "../../../config/bridges";
import { getDb } from "../../../db";
import {
  acquireLease,
  findLease,
  recordLeaseExit,
  rotateLease,
  type BridgeProxyLeaseRow,
} from "../../../db/bridges/proxyLeases";
import type { BridgeProxyRotationReason } from "../../../db/schema/bridges";
import { logger } from "../../../utils/logger";
import {
  resolveLeaseCountry,
  type LeaseCountryCandidates,
} from "./countryResolution";
import {
  proxyProvider,
  ProxyVerificationUnavailableError,
  type ProxyExitObservation,
  type ProxyLeaseDescriptor,
} from "./proxyProvider";

/**
 * The proxy allocator (docs/matrix/bridges.md §8.3).
 *
 * What it guarantees, in the design's own order:
 *
 * 1. A lease is created when the account is LINKED, not when it connects —
 *    assigning at connect time would let the exit move between reconnections,
 *    which is exactly the thing being prevented.
 * 2. The country is frozen at creation and never recalculated.
 * 3. Unlinking does not release the lease, so re-linking returns to the same
 *    geography.
 * 4. Rotation happens for three named reasons only, and always within country.
 * 5. The exit is verified before connecting. On a mismatch the account does NOT
 *    connect. An account that fails to connect is a support ticket; an account
 *    that connects from the wrong country is a ban three weeks later with no
 *    apparent cause.
 * 7. A lease is never shared between users — enforced by the unique index on
 *    `{oxyUserId, network}`, not by this file being careful.
 *
 * (Rule 6, serving the composed URL to the bridge, is `routes/bridgesInternal.ts`
 * on top of `proxyUrlForSlot` below.)
 */

export class ProxyLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyLeaseError";
  }
}

/** No provider configured — the state in which proxy-requiring networks do not exist. */
export class ProxyProviderNotConfiguredError extends ProxyLeaseError {
  constructor() {
    super("no proxy provider is configured");
    this.name = "ProxyProviderNotConfiguredError";
  }
}

/** None of §8.3 rule 2's three sources produced a country. */
export class LeaseCountryUnresolvedError extends ProxyLeaseError {
  constructor() {
    super(
      "could not determine a country to pin this account's exit to, and defaulting to one " +
        "would put the user's traffic in a country they have never been to",
    );
    this.name = "LeaseCountryUnresolvedError";
  }
}

export class LeaseCountryUnsupportedError extends ProxyLeaseError {
  constructor(public readonly countryCode: string) {
    super(`the configured proxy provider does not serve ${countryCode}`);
    this.name = "LeaseCountryUnsupportedError";
  }
}

/** The exit came out somewhere other than the lease says. §8.3 rule 5. */
export class ProxyExitMismatchError extends ProxyLeaseError {
  constructor(
    public readonly expectedCountry: string,
    public readonly observedCountry: string,
  ) {
    super(
      `proxy exited from ${observedCountry} but the lease is pinned to ${expectedCountry}`,
    );
    this.name = "ProxyExitMismatchError";
  }
}

export interface EnsureProxyLeaseInput {
  readonly oxyUserId: string;
  readonly network: BridgeNetworkId;
  readonly candidates: LeaseCountryCandidates;
}

/**
 * The lease for this (user, network), creating it if there is none.
 *
 * An existing lease is returned UNTOUCHED — no country recalculation, no new
 * seed — however different today's candidate country is from the one on file.
 * That is rule 2 and rule 3 in one place: the only code path that decides a
 * country is the one that runs when the lease does not yet exist.
 */
export async function ensureProxyLease(
  input: EnsureProxyLeaseInput,
): Promise<BridgeProxyLeaseRow> {
  const provider = proxyProvider();
  if (!provider) throw new ProxyProviderNotConfiguredError();

  /**
   * A country is resolved BEFORE the acquisition, on every call, even though it
   * is used only when the row does not exist yet — and the reason is worth
   * stating because the Mongo version read first and could skip this.
   *
   * `acquireLease` is ONE statement that both creates and returns the existing
   * row, which is what removes the read-then-write race two concurrent link
   * attempts used to run. The price is that its inputs must be ready before it
   * is called. That costs a pure, in-process country resolution on a path that
   * will discard it, and buys away a duplicate-key error that had to be caught
   * and re-read.
   *
   * The refusals still happen first, so a user in an unsupported country is
   * refused rather than given a lease: rule 2 and rule 3 are unchanged, because
   * the only value that decides a country is the one handed to a create.
   */
  const resolved = resolveLeaseCountry(input.candidates);
  if (!resolved) throw new LeaseCountryUnresolvedError();
  if (!provider.supportsCountry(resolved.countryCode)) {
    throw new LeaseCountryUnsupportedError(resolved.countryCode);
  }

  const { lease, created } = await acquireLease(getDb(), {
    id: uuidv7(),
    oxyUserId: input.oxyUserId,
    network: input.network,
    provider: provider.id,
    countryCode: resolved.countryCode,
    sessionSeed: newSessionSeed(),
    at: new Date(),
  });

  if (created) {
    logger.info("[Bridges] proxy lease created", {
      network: input.network,
      countryCode: resolved.countryCode,
      countrySource: resolved.source,
    });
  }
  return lease;
}

/**
 * Checks where the proxy actually comes out, and refuses the account if it is
 * the wrong country (§8.3 rule 5).
 *
 * Quarantining on mismatch rather than rotating: a lease that exits from an
 * unexpected country is evidence that something about the provider's
 * configuration is not what we think it is, and silently picking a new session
 * from the same provider would paper over exactly the fault that needs looking
 * at.
 */
export async function verifyLeaseExit(
  lease: BridgeProxyLeaseRow,
): Promise<ProxyExitObservation> {
  const provider = proxyProvider();
  if (!provider) throw new ProxyProviderNotConfiguredError();

  const reported = await provider.verifyExit(descriptorFor(lease));
  /**
   * Normalised once, here, and used for both the comparison and what is stored.
   *
   * Echo endpoints answer `es` or `ES` depending on the vendor, and the lease's
   * own `countryCode` is uppercase by schema. Comparing case-insensitively but
   * STORING whatever arrived would leave `lastExitCountry` and `countryCode` in
   * different cases — two fields that are meant to be compared by eye during an
   * incident, looking different for a reason that has nothing to do with the
   * incident.
   */
  const observation: ProxyExitObservation = {
    ip: reported.ip,
    country: reported.country.toUpperCase(),
  };

  if (observation.country !== lease.countryCode.toUpperCase()) {
    await recordLeaseExit(getDb(), {
      id: lease.id,
      observedIp: observation.ip,
      observedCountry: observation.country,
      at: new Date(),
      quarantine: true,
    });
    invalidateComposedProxyUrls(lease.oxyUserId, lease.network);
    /**
     * Logged at error level with a stable prefix because this is the alert.
     * A provider silently serving the wrong geography is invisible in every
     * other signal the system produces until accounts start being banned.
     */
    logger.error("[Bridges] proxy exit country mismatch — lease quarantined", {
      network: lease.network,
      expectedCountry: lease.countryCode,
      observedCountry: observation.country,
    });
    throw new ProxyExitMismatchError(lease.countryCode, observation.country);
  }

  await recordLeaseExit(getDb(), {
    id: lease.id,
    observedIp: observation.ip,
    observedCountry: observation.country,
    at: new Date(),
    quarantine: false,
  });
  return observation;
}

/**
 * Verification that a deployment without an echo endpoint can still get past.
 *
 * Separated from `verifyLeaseExit` so the decision is visible: a missing echo
 * URL is a deployment that cannot check its own geography, and every OTHER
 * failure — a mismatch, a timeout, an unreachable proxy — still refuses. If this
 * swallowed those too, §8.3 rule 5 would be a comment.
 */
export async function verifyLeaseExitIfPossible(
  lease: BridgeProxyLeaseRow,
): Promise<ProxyExitObservation | undefined> {
  try {
    return await verifyLeaseExit(lease);
  } catch (error) {
    if (error instanceof ProxyVerificationUnavailableError) {
      logger.warn(
        "[Bridges] proxy exit not verified: no echo endpoint is configured. " +
          "A provider misconfiguration will not be detected until accounts start being banned.",
        { network: lease.network },
      );
      return undefined;
    }
    throw error;
  }
}

export interface RotateProxyLeaseInput {
  readonly oxyUserId: string;
  readonly network: BridgeNetworkId;
  readonly reason: BridgeProxyRotationReason;
}

/**
 * Moves a lease to a new session within the SAME country (§8.3 rule 4).
 *
 * `countryCode` and `regionCode` are untouched by construction: only the seed
 * changes, and the history goes into `rotations[]` — which is the record that
 * gets read when somebody asks why this user's accounts keep getting
 * challenged.
 */
export async function rotateProxyLease(
  input: RotateProxyLeaseInput,
): Promise<BridgeProxyLeaseRow> {
  /**
   * No read-then-write. `rotateLease` locks the row and reads `from_seed` under
   * that lock in the same transaction that writes the replacement, so two
   * concurrent rotations serialize into a chain each naming its true
   * predecessor. The Mongo version read the previous seed OUTSIDE the update, so
   * two rotations could both record the same `fromSeed` and leave a gap in the
   * evidence an operator reads during a ban investigation.
   */
  const rotated = await rotateLease(getDb(), {
    oxyUserId: input.oxyUserId,
    network: input.network,
    rotationId: uuidv7(),
    toSeed: newSessionSeed(),
    reason: input.reason,
    at: new Date(),
  });

  if (!rotated) {
    throw new ProxyLeaseError(`no proxy lease to rotate for ${input.network}`);
  }

  invalidateComposedProxyUrls(input.oxyUserId, input.network);
  logger.info("[Bridges] proxy lease rotated", {
    network: input.network,
    countryCode: rotated.lease.countryCode,
    reason: input.reason,
  });
  return rotated.lease;
}

interface CachedProxyUrl {
  readonly oxyUserId: string;
  readonly network: BridgeNetworkId;
  readonly url: string;
}

/**
 * Composed URLs, by slot (§8.3 rule 6).
 *
 * The bridge calls `get_proxy_url` on its connect path and a 5xx or slow answer
 * fails the connection outright, so this must not depend on anything that can be
 * slow. Invalidated by rotation rather than expired by a timer: a rotated lease
 * whose old URL is still being served is a user connecting through a session we
 * have decided to stop using.
 */
const composedUrlBySlot = new Map<string, CachedProxyUrl>();

export function invalidateComposedProxyUrls(
  oxyUserId: string,
  network: BridgeNetworkId,
): void {
  for (const [slotId, cached] of composedUrlBySlot) {
    if (cached.oxyUserId === oxyUserId && cached.network === network) {
      composedUrlBySlot.delete(slotId);
    }
  }
}

/** Drops the whole cache. Tests only. */
export function resetProxyUrlCacheForTests(): void {
  composedUrlBySlot.clear();
}

export interface SlotLeaseLookup {
  readonly oxyUserId: string;
  readonly network: BridgeNetworkId;
}

/**
 * The proxy URL to hand a slot's bridge process.
 *
 * `undefined` means "no URL for this slot", and the caller answers 404 — for an
 * unknown slot, for a lease that does not exist, and for a QUARANTINED lease
 * alike. That last case is the important one: a quarantined lease is one whose
 * geography we no longer trust, and serving it anyway would be connecting from a
 * country we have already decided is wrong.
 *
 * The lookup is injected rather than done here so the mapping from slot to user
 * — which belongs to the account collection — does not pull a model into the
 * proxy allocator.
 */
export async function proxyUrlForSlot(
  slotId: string,
  lookup: (slotId: string) => Promise<SlotLeaseLookup | undefined>,
): Promise<string | undefined> {
  const cached = composedUrlBySlot.get(slotId);
  if (cached) return cached.url;

  const provider = proxyProvider();
  if (!provider) return undefined;

  const owner = await lookup(slotId);
  if (!owner) return undefined;

  const lease = await findLease(getDb(), {
    oxyUserId: owner.oxyUserId,
    network: owner.network,
  });

  if (!lease || lease.state !== "active") return undefined;

  const url = provider.composeUrl(descriptorFor(lease));
  composedUrlBySlot.set(slotId, {
    oxyUserId: lease.oxyUserId,
    network: lease.network,
    url,
  });
  return url;
}

function descriptorFor(lease: BridgeProxyLeaseRow): ProxyLeaseDescriptor {
  return {
    countryCode: lease.countryCode,
    ...(lease.regionCode ? { regionCode: lease.regionCode } : {}),
    sessionSeed: lease.sessionSeed,
  };
}

/**
 * 128 bits of randomness.
 *
 * The seed is what keeps two users off the same exit address, so it has to be
 * unguessable rather than merely unique: a predictable seed lets somebody else's
 * session be requested from the provider.
 */
function newSessionSeed(): string {
  return randomBytes(16).toString("hex");
}
