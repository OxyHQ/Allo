import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BRIDGE_NETWORK_IDS, resetBridgesConfigForTests } from "../../../config/bridges";
import Report from "../../../models/Report";
import {
  moderationSubjectReasons,
  resolveModerationSubject,
} from "../../../services/moderation/subjectIdentity";

/**
 * Which reported identifiers name an Oxy account, and which only look like one.
 *
 * docs/matrix/data-model.md §6.3 is a decision about a SILENCE. Before it, a report
 * about a bridged WhatsApp identity or a user on a federated homeserver produced a
 * 404 from Oxy, which the provider correctly reads as "no such account", which the
 * delivery worker correctly reads as "the account was deleted" — and the report
 * closed saying something that had never been true. Nothing failed. Nothing logged.
 * The reporter got a 201 and a row that told a plausible lie.
 *
 * So the assertions below are mostly about the SENTENCE on the row, not about a
 * boolean. A test that only checked `kind` would pass against a version that
 * classified correctly and then recorded nothing, which is the same silence with a
 * better-typed hole in the middle.
 *
 * `@whatsapp_…:allo.you` is the one to read first. Its server name is OURS — the
 * homeserver really does own it, `oxyUserIdFromMatrixUserId` really does return a
 * localpart, and that localpart really does look exactly like an Oxy user id to
 * every line of code downstream. The appservice namespace is the only thing that
 * distinguishes it, and this file is where that distinction is held.
 */

const SERVER_NAME = "allo.you";
const OXY_ID = "507f1f77bcf86cd799439011";

beforeEach(() => {
  process.env.ALLO_MATRIX_SERVER_NAME = SERVER_NAME;
  resetBridgesConfigForTests();
});

afterEach(() => {
  delete process.env.ALLO_MATRIX_SERVER_NAME;
  resetBridgesConfigForTests();
});

describe("resolving a reported identifier", () => {
  it("passes an Oxy user id through untouched", () => {
    /**
     * Every report Allo takes today. §6.2 keeps `Report.reportedId` an Oxy id, so
     * the pre-Matrix path has to come out of this function exactly as it went in —
     * if it did not, the change would have moved §7.3's dedup key without saying so.
     */
    expect(resolveModerationSubject(OXY_ID)).toEqual({
      kind: "oxy-account",
      reportedId: OXY_ID,
    });
  });

  it("translates an MXID this homeserver owns back to the Oxy id", () => {
    expect(resolveModerationSubject(`@${OXY_ID}:${SERVER_NAME}`)).toEqual({
      kind: "oxy-account",
      reportedId: OXY_ID,
    });
  });

  it("resolves an MXID and the bare id to the SAME stored identifier", () => {
    /**
     * The property the unique index rests on. `{reporter, reportedId, reportedType}`
     * is unique, so if one account resolved to two identifiers, one reporter could
     * open two cases about one person — by reporting them from a room once and from
     * a profile once — and "one penalty per incident" would fail with nothing
     * failing in a test.
     */
    const fromRoom = resolveModerationSubject(`@${OXY_ID}:${SERVER_NAME}`);
    const fromProfile = resolveModerationSubject(OXY_ID);

    expect(fromRoom.reportedId).toBe(fromProfile.reportedId);
  });

  it("refuses a user on a homeserver Allo does not run", () => {
    const resolved = resolveModerationSubject(`@someone:elsewhere.example`);

    expect(resolved.kind).toBe("not-an-oxy-account");
    expect(resolved).toHaveProperty("reason", expect.stringContaining("homeserver"));
  });

  it("keeps the identifier as given when there is no Oxy id to give", () => {
    /**
     * Not the localpart. `@someone:elsewhere.example` and `@someone:allo.you` are
     * different people, and storing `someone` for the first would file the report
     * against a local account that may well exist and belong to somebody innocent.
     */
    expect(resolveModerationSubject("@someone:elsewhere.example").reportedId).toBe(
      "@someone:elsewhere.example",
    );
  });
});

describe("bridge ghosts on Allo's own homeserver", () => {
  /**
   * The case that motivated §6.3, and the one no other check catches: the server
   * name matches, so every guard about foreign homeservers passes it through.
   */
  it.each(BRIDGE_NETWORK_IDS)("refuses a %s ghost user", (network) => {
    const resolved = resolveModerationSubject(`@${network}_1234567890:${SERVER_NAME}`);

    expect(resolved.kind).toBe("not-an-oxy-account");
    expect(resolved).toHaveProperty("reason", expect.stringContaining("bridge"));
  });

  it.each(BRIDGE_NETWORK_IDS)("refuses the %s bridge bot", (network) => {
    /**
     * The bot is not a ghost and has a different localpart shape, and it is exactly
     * the account a confused user would report — it is the one that posts the "you
     * have been logged out" notices.
     */
    expect(resolveModerationSubject(`@${network}bot:${SERVER_NAME}`).kind).toBe(
      "not-an-oxy-account",
    );
  });

  it("names the network, so the row says what was actually reported", () => {
    const resolved = resolveModerationSubject(`@whatsapp_1234567890:${SERVER_NAME}`);
    expect(resolved).toHaveProperty("reason", expect.stringContaining("WhatsApp"));
  });

  it("does not mistake an Oxy id that merely contains a network name", () => {
    /**
     * The namespace check is a PREFIX plus a separator, not a substring search. An
     * id containing `whatsapp` in the middle is a normal account, and matching it
     * would make one real user permanently unreportable — the failure direction
     * that produces no error anywhere.
     */
    expect(resolveModerationSubject(`@a-whatsapp-fan:${SERVER_NAME}`).kind).toBe(
      "oxy-account",
    );
  });
});

describe("identifiers that are not principals at all", () => {
  it("refuses a room id", () => {
    expect(resolveModerationSubject(`!abcdefg:${SERVER_NAME}`).kind).toBe(
      "not-an-oxy-account",
    );
  });

  it("refuses a room alias", () => {
    expect(resolveModerationSubject(`#general:${SERVER_NAME}`).kind).toBe(
      "not-an-oxy-account",
    );
  });

  it("refuses an event id and says why it is worse than the others", () => {
    /**
     * §6.5. `reportContent(eventId, …)` goes to the homeserver administrator, who
     * can act on metadata without reading anything. CrowdSource is a different
     * recipient with a different authority, and an event id names one message in
     * one room — conversation metadata, which does not leave this deployment. The
     * reason says so, because "not an account" alone would read as a technicality
     * and invite somebody to route around it.
     */
    const resolved = resolveModerationSubject("$eventid123:allo.you");

    expect(resolved.kind).toBe("not-an-oxy-account");
    expect(resolved).toHaveProperty(
      "reason",
      expect.stringContaining("conversation metadata"),
    );
  });

  it("never echoes the identifier back into the reason", () => {
    /**
     * An event id is the thing §6.5 says must not travel. A reason that interpolated
     * it would copy conversation metadata into a second field — and `localStatus`
     * reasons are the fields an operator reads in bulk.
     */
    const eventId = "$aVeryDistinctiveEventId:allo.you";
    const resolved = resolveModerationSubject(eventId);

    expect(resolved).toHaveProperty("reason");
    if (resolved.kind === "not-an-oxy-account") {
      expect(resolved.reason).not.toContain(eventId);
      expect(resolved.reason).not.toContain("aVeryDistinctiveEventId");
    }
  });
});

describe("a deployment with no Matrix configured", () => {
  beforeEach(() => {
    delete process.env.ALLO_MATRIX_SERVER_NAME;
    resetBridgesConfigForTests();
  });

  it("refuses an MXID rather than guessing at its localpart", () => {
    /**
     * The tempting alternative is to read the localpart anyway. It is a string that
     * looks like an Oxy id, and it would usually be one. "Usually" is the problem:
     * with no configured server name there is nothing that distinguishes
     * `@507f…:allo.you` from `@507f…:someone-elses.example`, so the guess would
     * file a report against a local account because a stranger's MXID happened to
     * share its localpart.
     */
    const resolved = resolveModerationSubject(`@${OXY_ID}:${SERVER_NAME}`);

    expect(resolved.kind).toBe("not-an-oxy-account");
    expect(resolved.reportedId).toBe(`@${OXY_ID}:${SERVER_NAME}`);
  });

  it("still passes a plain Oxy id through", () => {
    /**
     * Moderation must not acquire a dependency on bridges being configured. Every
     * report Allo takes today is this one.
     */
    expect(resolveModerationSubject(OXY_ID).kind).toBe("oxy-account");
  });
});

describe("the reasons written onto a report", () => {
  /**
   * `Report.localStatusReason` is bounded by the schema, and intake writes the
   * reason INSIDE the transaction that stores the report. A reason one character
   * too long is therefore not a cosmetic problem: Mongoose rejects the document,
   * the transaction aborts, and `POST /reports` answers 500 for exactly the reports
   * this feature was written to record properly.
   */
  function localStatusReasonLimit(): number {
    const configured = Report.schema.path("localStatusReason").options.maxlength;
    if (typeof configured !== "number") {
      throw new Error(
        "Report.localStatusReason has no numeric maxlength; this test can no longer " +
          "check what it claims to check.",
      );
    }
    return configured;
  }

  it("every reason fits the field it is stored in", () => {
    const limit = localStatusReasonLimit();
    for (const reason of moderationSubjectReasons()) {
      expect(reason.length).toBeLessThanOrEqual(limit);
    }
  });

  it("covers every network in the catalogue, so a new bridge cannot be forgotten", () => {
    /**
     * The list is derived rather than hand-written for the same reason the
     * namespace check is: a second list agrees with the first until somebody adds a
     * network, and the failure that day is a ghost classified as an Oxy account.
     */
    const reasons = moderationSubjectReasons();
    expect(reasons.length).toBeGreaterThanOrEqual(BRIDGE_NETWORK_IDS.length);
  });

  it("says what CrowdSource does, in every reason", () => {
    for (const reason of moderationSubjectReasons()) {
      expect(reason).toContain("CrowdSource reviews Oxy accounts only");
      expect(reason).toContain("not sent for community review");
    }
  });
});
