import { describe, expect, it } from "vitest";

import { BRIDGE_NETWORK_IDS } from "../../../config/bridges";
import {
  isOxyUserId,
  MatrixIdentityError,
  matrixUserIdForOxyUser,
  oxyAccountIdFromMatrixUserId,
  oxyUserIdFromMatrixLocalpart,
  oxyUserIdFromMatrixUserId,
} from "../../../services/bridges/matrixIdentity";

/**
 * Translating between Oxy ids and Matrix ids (docs/matrix/data-model.md §6.2).
 *
 * The whole reason this is arithmetic and not a mapping collection is that a map
 * brings orphans, collisions and rows that go missing. The tests below are about
 * the one way arithmetic can still go wrong: a REPAIR that makes two different
 * users share one identity.
 */

const SERVER = "allo.you";

describe("deriving a Matrix id from an Oxy id", () => {
  it("passes a hexadecimal ObjectId through unchanged", () => {
    /** Allo's ids today. They are already a valid localpart. */
    expect(matrixUserIdForOxyUser("507f1f77bcf86cd799439011", SERVER)).toBe(
      "@507f1f77bcf86cd799439011:allo.you",
    );
  });

  it("is deterministic, so the same user is always the same MXID", () => {
    /**
     * The property that removes the need for a mapping collection. If this were
     * ever not true — a random suffix, a timestamp — a user would come back as
     * somebody else after every restart, and their linked accounts would be
     * unreachable.
     */
    const first = matrixUserIdForOxyUser("507f1f77bcf86cd799439011", SERVER);
    const second = matrixUserIdForOxyUser("507f1f77bcf86cd799439011", SERVER);

    expect(first).toBe(second);
  });

  it.each(["ABCDEF0123456789ABCDEF01", "user@example.com", "user name", "user#1"])(
    "refuses %s rather than repairing it",
    (oxyUserId) => {
      /**
       * The important test in this file. A Matrix localpart admits only `a-z`,
       * `0-9` and `._=-/+`, and the tempting fix for an id that does not fit is
       * to lowercase it and strip the rest.
       *
       * That is an account takeover. `ABCDEF…` and `abcdef…` are different Oxy
       * users and would become the SAME localpart, so the second one to link
       * would be provisioning the first one's bridge account — with the shared
       * secret, which the bridge trusts completely.
       *
       * Failing one link attempt loudly is the correct trade against merging two
       * identities quietly.
       */
      expect(() => matrixUserIdForOxyUser(oxyUserId, SERVER)).toThrow(MatrixIdentityError);
    },
  );

  it("never maps two different ids to one MXID", () => {
    /**
     * Stated directly rather than inferred from the refusals above: for every
     * pair of ids that both succeed, the results differ.
     */
    const ids = ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012", "abc", "abc.def"];
    const produced = ids.map((id) => matrixUserIdForOxyUser(id, SERVER));

    expect(new Set(produced).size).toBe(ids.length);
  });

  it("refuses an empty id", () => {
    expect(() => matrixUserIdForOxyUser("   ", SERVER)).toThrow(MatrixIdentityError);
  });
});

describe("reading an Oxy id back out of a Matrix id", () => {
  it("round-trips", () => {
    const mxid = matrixUserIdForOxyUser("507f1f77bcf86cd799439011", SERVER);

    expect(oxyUserIdFromMatrixUserId(mxid, SERVER)).toBe("507f1f77bcf86cd799439011");
  });

  it("refuses a user of another homeserver", () => {
    /**
     * A bridge is only meant to report about users of OUR homeserver. Keeping
     * the localpart from `@someone:elsewhere.example` would let a compromised or
     * misconfigured bridge write state onto a row keyed by a localpart it does
     * not own.
     */
    expect(
      oxyUserIdFromMatrixUserId("@507f1f77bcf86cd799439011:elsewhere.example", SERVER),
    ).toBeUndefined();
  });

  it("is not fooled by a server name that merely ends with ours", () => {
    /**
     * `notallo.you` ends with `allo.you`. A suffix check rather than an equality
     * check would accept it — and accepting it is accepting reports from a
     * homeserver somebody else controls.
     */
    expect(
      oxyUserIdFromMatrixUserId("@507f1f77bcf86cd799439011:notallo.you", SERVER),
    ).toBeUndefined();
  });

  it.each(["507f1f77bcf86cd799439011", "@no-colon", "", "@:allo.you", "@UPPER:allo.you"])(
    "refuses %s, which is not a well-formed MXID for us",
    (candidate) => {
      expect(oxyUserIdFromMatrixUserId(candidate, SERVER)).toBeUndefined();
    },
  );

  it("still hands back a bridge ghost's localpart, which the moderation path needs", () => {
    /**
     * The looser function stays loose ON PURPOSE.
     * `services/moderation/subjectIdentity.ts` reads the raw localpart so it can
     * recognise a ghost and say WHICH network it came from; tightening this
     * would replace that specific, useful reason with "this homeserver does not
     * own that identifier", which is false. The strict answer lives in
     * {@link oxyAccountIdFromMatrixUserId} below.
     */
    expect(oxyUserIdFromMatrixUserId("@whatsapp_447700900000:allo.you", SERVER)).toBe(
      "whatsapp_447700900000",
    );
  });
});

describe("deciding whether a localpart names an Oxy ACCOUNT", () => {
  /**
   * The direction that authenticates somebody, added for
   * `middleware/matrixAuth.ts`. Everything above answers "could a homeserver
   * hold this string?"; everything below answers "is this a person on this
   * platform?", and a wrong yes here is a request authenticated as somebody
   * else's account.
   */

  it("accepts a 24-character hexadecimal ObjectId", () => {
    expect(isOxyUserId("507f1f77bcf86cd799439011")).toBe(true);
    expect(oxyUserIdFromMatrixLocalpart("507f1f77bcf86cd799439011")).toBe(
      "507f1f77bcf86cd799439011",
    );
  });

  it.each([
    ["alice", "a perfectly legal localpart that is not an id"],
    ["507f1f77bcf86cd79943901", "one character short"],
    ["507f1f77bcf86cd7994390111", "one character long"],
    ["507F1F77BCF86CD799439011", "uppercase, which no localpart may contain"],
    ["507f1f77bcf86cd79943901g", "a character outside hexadecimal"],
    ["507f1f77-bcf86cd79943901", "a hyphen where a digit belongs"],
    ["", "empty"],
    ["   ", "blank"],
  ])("refuses %s (%s)", (localpart) => {
    expect(isOxyUserId(localpart)).toBe(false);
    expect(oxyUserIdFromMatrixLocalpart(localpart)).toBeUndefined();
  });

  it("refuses every bridge puppet the catalogue can produce", () => {
    /**
     * A mautrix bridge owns one ghost per remote user (`whatsapp_<remote id>`)
     * and one bot per bridge (`whatsappbot`). Nobody behind either ever signed
     * up to Allo, so neither names an account that can be authenticated.
     * Derived from `BRIDGE_NETWORK_IDS` rather than listed, so a network added
     * to the catalogue cannot be forgotten here.
     */
    for (const network of BRIDGE_NETWORK_IDS) {
      expect(oxyUserIdFromMatrixLocalpart(`${network}_447700900000`)).toBeUndefined();
      expect(oxyUserIdFromMatrixLocalpart(`${network}bot`)).toBeUndefined();
      expect(
        oxyAccountIdFromMatrixUserId(`@${network}_447700900000:allo.you`, SERVER),
      ).toBeUndefined();
      expect(oxyAccountIdFromMatrixUserId(`@${network}bot:allo.you`, SERVER)).toBeUndefined();
    }
  });

  it("accepts one of our own users by full MXID", () => {
    expect(oxyAccountIdFromMatrixUserId("@507f1f77bcf86cd799439011:allo.you", SERVER)).toBe(
      "507f1f77bcf86cd799439011",
    );
  });

  it("refuses one of our own account ids on another homeserver", () => {
    expect(
      oxyAccountIdFromMatrixUserId("@507f1f77bcf86cd799439011:elsewhere.example", SERVER),
    ).toBeUndefined();
  });

  it("is not fooled by a server name that merely ends with ours", () => {
    expect(
      oxyAccountIdFromMatrixUserId("@507f1f77bcf86cd799439011:notallo.you", SERVER),
    ).toBeUndefined();
  });

  it("round-trips an id it would itself derive", () => {
    const mxid = matrixUserIdForOxyUser("507f1f77bcf86cd799439011", SERVER);

    expect(oxyAccountIdFromMatrixUserId(mxid, SERVER)).toBe("507f1f77bcf86cd799439011");
  });
});
