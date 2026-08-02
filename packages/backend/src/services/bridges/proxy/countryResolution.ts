import { countryFromDialingPrefix } from "./dialingCodes";

/**
 * Deciding the country a proxy lease is frozen to (docs/matrix/bridges.md §8.3 rule 2).
 *
 * Three sources, in a fixed order, evaluated ONCE. The order is not arbitrary:
 * it runs from what the user told us on purpose, through what the account they
 * are linking implies, to where the request happened to come from — most
 * deliberate first, most incidental last.
 *
 * After this runs, the answer is written to the lease and never recalculated,
 * not even when the user travels. A user who genuinely emigrates is a support
 * case with a human in it (§8.3 rule 2), precisely because the automatic version
 * of that change is indistinguishable from the signal we are trying not to emit.
 */

export const LEASE_COUNTRY_SOURCES = ["profile", "phone", "request"] as const;
export type LeaseCountrySource = (typeof LEASE_COUNTRY_SOURCES)[number];

export interface LeaseCountryCandidates {
  /** The country on the user's Oxy profile — stated deliberately, so trusted first. */
  readonly profileCountry?: string;
  /**
   * The number being linked, in international form.
   *
   * Used only to derive a country, and never stored (`BridgeLinkSession` holds
   * nothing the user typed). A country is not a phone number.
   */
  readonly phoneNumber?: string;
  /** Where the link request appeared to come from. The weakest source, and last. */
  readonly requestCountry?: string;
}

export interface ResolvedLeaseCountry {
  readonly countryCode: string;
  readonly source: LeaseCountrySource;
}

function normaliseCountry(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The country to freeze, or `undefined` when none of the three sources answered.
 *
 * `undefined` is a real outcome and must not be papered over with a default.
 * A default country would silently give some users an exit in a country they
 * have never been to, which is worse than refusing to link and asking.
 */
export function resolveLeaseCountry(
  candidates: LeaseCountryCandidates,
): ResolvedLeaseCountry | undefined {
  const fromProfile = normaliseCountry(candidates.profileCountry);
  if (fromProfile) return { countryCode: fromProfile, source: "profile" };

  const fromPhone = candidates.phoneNumber
    ? normaliseCountry(countryFromDialingPrefix(candidates.phoneNumber))
    : undefined;
  if (fromPhone) return { countryCode: fromPhone, source: "phone" };

  const fromRequest = normaliseCountry(candidates.requestCountry);
  if (fromRequest) return { countryCode: fromRequest, source: "request" };

  return undefined;
}
