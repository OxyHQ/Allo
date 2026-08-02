import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The proxy allocator against a REAL replica set (docs/matrix/bridges.md §8.3).
 *
 * Mongo is not mocked here, and that is the point of the file. Three of the
 * rules under test are not properties of this service at all — they are
 * properties of the UNIQUE INDEX on `{oxyUserId, network}`:
 *
 * - rule 7, that a lease is never shared between users;
 * - the race where two concurrent link attempts must converge on one lease;
 * - and the fact that "the service is careful" is not the same claim as "the
 *   database refuses".
 *
 * A mocked model agrees with any of those claims for free.
 *
 * The provider IS mocked, because no provider has been contracted (§12.1) and
 * what is under test is the policy — freeze, reuse, rotate, verify — not
 * somebody's gateway. The transport lives in `proxyProvider.test.ts`.
 */

const composeUrl = vi.fn((lease: { countryCode: string; sessionSeed: string }) =>
  `http://acct-country-${lease.countryCode.toLowerCase()}-session-${lease.sessionSeed}:pw@gw.example:8000`,
);
const verifyExit = vi.fn(async () => ({ ip: "203.0.113.7", country: "ES" }));
const supportsCountry = vi.fn((code: string) => code.toUpperCase() !== "XX");

vi.mock("../../../services/bridges/proxy/proxyProvider", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/bridges/proxy/proxyProvider")
  >("../../../services/bridges/proxy/proxyProvider");
  return {
    ...actual,
    proxyProvider: () => ({
      id: "provider-a",
      supportsCountry,
      composeUrl,
      verifyExit,
    }),
  };
});

import BridgeAccount from "../../../models/BridgeAccount";
import BridgeProxyLease, {
  type LeanBridgeProxyLease,
} from "../../../models/BridgeProxyLease";
import {
  ensureProxyLease,
  LeaseCountryUnresolvedError,
  LeaseCountryUnsupportedError,
  ProxyExitMismatchError,
  proxyUrlForSlot,
  resetProxyUrlCacheForTests,
  rotateProxyLease,
  verifyLeaseExit,
} from "../../../services/bridges/proxy/ProxyLeaseService";
import { logger } from "../../../utils/logger";

const USER = "oxy-user-1";
const OTHER_USER = "oxy-user-2";

describe("the proxy allocator", () => {
  beforeAll(async () => {
    const uri = process.env.ALLO_TEST_MONGODB_URI;
    if (!uri) throw new Error("ALLO_TEST_MONGODB_URI is not set by vitest.globalSetup.ts");
    await mongoose.connect(uri, { dbName: "allo_bridges_test" });
    // The unique index is what several assertions below actually test.
    await BridgeProxyLease.init();
    await BridgeAccount.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(() => {
    verifyExit.mockResolvedValue({ ip: "203.0.113.7", country: "ES" });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    resetProxyUrlCacheForTests();
    await BridgeProxyLease.deleteMany({});
    await BridgeAccount.deleteMany({});
  });

  describe("rule 2 — the country is frozen at creation", () => {
    it("keeps the original country when the same user links again from elsewhere", async () => {
      /**
       * The rule that matters most, stated as the scenario it exists for: the
       * user travelled. Their profile now says France, their IP is French, and
       * the lease must still say Spain.
       *
       * A user who genuinely emigrates is a support case with a human in it —
       * precisely BECAUSE the automatic version of that change is
       * indistinguishable from the signal the design exists not to emit.
       */
      const first = await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });
      expect(first.countryCode).toBe("ES");

      const second = await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "FR", requestCountry: "FR" },
      });

      expect(second.countryCode).toBe("ES");
      expect(second.sessionSeed).toBe(first.sessionSeed);
      expect(second._id.toString()).toBe(first._id.toString());
      expect(await BridgeProxyLease.countDocuments({})).toBe(1);
    });

    it("resolves the country from the profile, then the phone, then the request", async () => {
      /**
       * The priority order runs from the most deliberate source to the most
       * incidental. Asserted as three separate leases rather than three calls to
       * the pure resolver, because the resolver being right is worth nothing if
       * the service passes it the candidates in a different order.
       */
      const fromProfile = await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "PT", phoneNumber: "+34600111222", requestCountry: "DE" },
      });
      expect(fromProfile.countryCode).toBe("PT");

      const fromPhone = await ensureProxyLease({
        oxyUserId: OTHER_USER,
        network: "whatsapp",
        candidates: { phoneNumber: "+34600111222", requestCountry: "DE" },
      });
      expect(fromPhone.countryCode).toBe("ES");

      const fromRequest = await ensureProxyLease({
        oxyUserId: "oxy-user-3",
        network: "whatsapp",
        candidates: { requestCountry: "DE" },
      });
      expect(fromRequest.countryCode).toBe("DE");
    });

    it("refuses to invent a country when no source answers", async () => {
      /**
       * A default country would quietly put somebody's traffic in a country they
       * have never been to. Refusing fails one link attempt loudly instead.
       */
      await expect(
        ensureProxyLease({
          oxyUserId: USER,
          network: "whatsapp",
          candidates: { phoneNumber: "600111222" },
        }),
      ).rejects.toBeInstanceOf(LeaseCountryUnresolvedError);

      expect(await BridgeProxyLease.countDocuments({})).toBe(0);
    });

    it("refuses a country the provider does not serve, before anything is written", async () => {
      await expect(
        ensureProxyLease({
          oxyUserId: USER,
          network: "whatsapp",
          candidates: { profileCountry: "XX" },
        }),
      ).rejects.toBeInstanceOf(LeaseCountryUnsupportedError);

      expect(await BridgeProxyLease.countDocuments({})).toBe(0);
    });
  });

  describe("rule 3 — unlinking does not release the lease", () => {
    it("returns the same seed after a lease was released and the user re-links", async () => {
      /**
       * §5.2's `DELETE /accounts/:id` explicitly does NOT free the lease: coming
       * back to a network must mean coming back through the same geography.
       * Reviving a released lease keeps both its country and its seed — releasing
       * is an operational act, and it does not make the user's home country a
       * different country.
       */
      const original = await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });

      await BridgeProxyLease.updateOne(
        { _id: original._id },
        { $set: { state: "released", releasedAt: new Date() } },
      );

      const revived = await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "FR" },
      });

      expect(revived.state).toBe("active");
      expect(revived.countryCode).toBe("ES");
      expect(revived.sessionSeed).toBe(original.sessionSeed);
      expect(revived.releasedAt).toBeUndefined();
    });
  });

  describe("rule 7 — a lease is never shared", () => {
    it("gives two users different sessions in the same country", async () => {
      const mine = await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });
      const theirs = await ensureProxyLease({
        oxyUserId: OTHER_USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });

      expect(mine.countryCode).toBe(theirs.countryCode);
      expect(mine.sessionSeed).not.toBe(theirs.sessionSeed);
    });

    it("keeps one user's networks on separate leases", async () => {
      /**
       * The lease is per (user, NETWORK). One network's ban quarantine must not
       * drag another network's exit along with it.
       */
      const whatsapp = await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });
      const instagram = await ensureProxyLease({
        oxyUserId: USER,
        network: "instagram",
        candidates: { profileCountry: "ES" },
      });

      expect(whatsapp.sessionSeed).not.toBe(instagram.sessionSeed);
      expect(await BridgeProxyLease.countDocuments({ oxyUserId: USER })).toBe(2);
    });

    it("converges on ONE lease when two link attempts race", async () => {
      /**
       * Not hypothetical: two taps on "link" produce two concurrent requests.
       * Without the unique index both would insert, and the loser's seed would be
       * the one that silently stopped being used — a user whose exit address
       * changes for no reason anybody could later explain.
       *
       * The duplicate-key path must RESOLVE rather than throw: both callers
       * wanted the same lease and there is exactly one.
       */
      const [a, b, c] = await Promise.all([
        ensureProxyLease({
          oxyUserId: USER,
          network: "whatsapp",
          candidates: { profileCountry: "ES" },
        }),
        ensureProxyLease({
          oxyUserId: USER,
          network: "whatsapp",
          candidates: { profileCountry: "ES" },
        }),
        ensureProxyLease({
          oxyUserId: USER,
          network: "whatsapp",
          candidates: { profileCountry: "ES" },
        }),
      ]);

      expect(await BridgeProxyLease.countDocuments({ oxyUserId: USER })).toBe(1);
      expect(a.sessionSeed).toBe(b.sessionSeed);
      expect(b.sessionSeed).toBe(c.sessionSeed);
    });

    it("is the DATABASE that refuses a second lease, not the service", async () => {
      /**
       * The vacuity guard for the race test above, and the reason this file uses
       * a real replica set. Inserting directly, around `ensureProxyLease`
       * entirely, must still fail — otherwise "converges on one lease" is only a
       * statement about the happy path through one function.
       */
      await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });

      await expect(
        BridgeProxyLease.create({
          oxyUserId: USER,
          network: "whatsapp",
          provider: "provider-a",
          countryCode: "ES",
          sessionSeed: "a-second-seed-for-the-same-pair",
          state: "active",
          rotations: [],
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });
  });

  describe("rule 4 — rotation stays inside the country", () => {
    it("changes the seed, keeps the country, and records why", async () => {
      const original = await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });
      await BridgeProxyLease.updateOne({ _id: original._id }, { $set: { regionCode: "MD" } });

      const rotated = await rotateProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        reason: "ban_quarantine",
      });

      expect(rotated.countryCode).toBe("ES");
      expect(rotated.regionCode).toBe("MD");
      expect(rotated.sessionSeed).not.toBe(original.sessionSeed);
      expect(rotated.state).toBe("active");
      expect(rotated.rotations).toHaveLength(1);
      expect(rotated.rotations[0]).toMatchObject({
        fromSeed: original.sessionSeed,
        toSeed: rotated.sessionSeed,
        reason: "ban_quarantine",
      });
    });

    it("keeps the whole history rather than only the last rotation", async () => {
      /**
       * `rotations[]` is what gets read when somebody asks why this user keeps
       * being challenged. A field that only remembered the most recent rotation
       * would answer that question with "once", forever.
       */
      await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });
      await rotateProxyLease({ oxyUserId: USER, network: "whatsapp", reason: "provider_retired" });
      const twice = await rotateProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        reason: "operator_forced",
      });

      expect(twice.rotations.map((entry) => entry.reason)).toEqual([
        "provider_retired",
        "operator_forced",
      ]);
      // The chain has to join up: each rotation starts where the last one ended.
      expect(twice.rotations[1].fromSeed).toBe(twice.rotations[0].toSeed);
    });
  });

  describe("rule 5 — the exit is verified, and a mismatch does not connect", () => {
    it("quarantines the lease and refuses when the exit country is wrong", async () => {
      /**
       * The rule that makes the design operable. Without it, a provider
       * misconfiguration is invisible in every signal the system produces until
       * accounts start being banned three weeks later, with no apparent cause.
       *
       * Refusing is the correct outcome: an account that does not connect is a
       * support ticket, and an account that connects from the wrong country is a
       * ban.
       */
      const lease = await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });
      verifyExit.mockResolvedValue({ ip: "198.51.100.4", country: "DE" });

      await expect(verifyLeaseExit(lease)).rejects.toBeInstanceOf(ProxyExitMismatchError);

      const stored = await BridgeProxyLease.findById(lease._id).lean<LeanBridgeProxyLease>();
      expect(stored?.state).toBe("quarantined");
      expect(stored?.lastExitCountry).toBe("DE");
      expect(logger.error).toHaveBeenCalledWith(
        "[Bridges] proxy exit country mismatch — lease quarantined",
        expect.objectContaining({ expectedCountry: "ES", observedCountry: "DE" }),
      );
    });

    it("records the observation and leaves the lease active when the country matches", async () => {
      /**
       * The vacuity guard: without it, a `verifyLeaseExit` that quarantined
       * unconditionally would pass the test above perfectly.
       */
      const lease = await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });

      const observation = await verifyLeaseExit(lease);

      expect(observation.country).toBe("ES");
      const stored = await BridgeProxyLease.findById(lease._id).lean<LeanBridgeProxyLease>();
      expect(stored?.state).toBe("active");
      expect(stored?.lastExitIp).toBe("203.0.113.7");
      expect(stored?.lastVerifiedAt).toBeInstanceOf(Date);
    });

    it("compares countries case-insensitively rather than by raw string equality", async () => {
      /**
       * Echo endpoints answer `es` or `ES` depending on the vendor. A raw
       * comparison would quarantine every healthy lease on half the providers in
       * the market — an outage that looks exactly like a genuine geography fault.
       */
      const lease = await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });
      verifyExit.mockResolvedValue({ ip: "203.0.113.7", country: "es" });

      await expect(verifyLeaseExit(lease)).resolves.toMatchObject({ country: "ES" });
    });
  });

  describe("rule 6 — serving the composed URL to a slot", () => {
    async function accountWithSlot(slotId: string): Promise<void> {
      await BridgeAccount.create({
        oxyUserId: USER,
        network: "whatsapp",
        remoteLoginId: "remote-1",
        slotId,
        state: "connected",
        linkedAt: new Date(),
        lastStateAt: new Date(),
      });
    }

    const lookup = async (slotId: string) => {
      const account = await BridgeAccount.findOne({ slotId }).lean();
      return account
        ? { oxyUserId: account.oxyUserId, network: account.network }
        : undefined;
    };

    it("composes a URL carrying the lease's country and session", async () => {
      await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });
      await accountWithSlot("allo-wa-0042");

      const url = await proxyUrlForSlot("allo-wa-0042", lookup);

      expect(url).toContain("country-es");
      expect(url).toContain("gw.example:8000");
    });

    it("serves nothing for a quarantined lease", async () => {
      /**
       * A quarantined lease is one whose geography we have already decided not to
       * trust. Serving it anyway would be connecting through a country we know is
       * wrong — which is the precise thing rule 5 refused to do a moment earlier.
       */
      const lease = await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });
      await accountWithSlot("allo-wa-0042");
      await BridgeProxyLease.updateOne({ _id: lease._id }, { $set: { state: "quarantined" } });

      await expect(proxyUrlForSlot("allo-wa-0042", lookup)).resolves.toBeUndefined();
    });

    it("serves nothing for an unknown slot", async () => {
      await expect(proxyUrlForSlot("allo-wa-9999", lookup)).resolves.toBeUndefined();
    });

    it("stops serving the old URL once the lease has rotated", async () => {
      /**
       * The cache exists because the bridge calls this on its connect path and a
       * slow answer fails the connection outright (§8.3 rule 6). A cache that
       * outlived a rotation would keep a user connecting through a session we had
       * deliberately stopped using — which is the whole point of rotating.
       */
      await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });
      await accountWithSlot("allo-wa-0042");

      const before = await proxyUrlForSlot("allo-wa-0042", lookup);
      await rotateProxyLease({ oxyUserId: USER, network: "whatsapp", reason: "ban_quarantine" });
      const after = await proxyUrlForSlot("allo-wa-0042", lookup);

      expect(after).toBeDefined();
      expect(after).not.toBe(before);
    });

    it("answers a repeated call from cache rather than re-reading the lease", async () => {
      /**
       * The vacuity guard for the invalidation test: it proves there is a cache
       * to invalidate. Without it, an implementation that never cached would
       * satisfy "stops serving the old URL" trivially and the rotation
       * invalidation would be untested.
       */
      await ensureProxyLease({
        oxyUserId: USER,
        network: "whatsapp",
        candidates: { profileCountry: "ES" },
      });
      await accountWithSlot("allo-wa-0042");

      await proxyUrlForSlot("allo-wa-0042", lookup);
      const callsAfterFirst = composeUrl.mock.calls.length;
      await proxyUrlForSlot("allo-wa-0042", lookup);

      expect(composeUrl.mock.calls.length).toBe(callsAfterFirst);
    });
  });
});
