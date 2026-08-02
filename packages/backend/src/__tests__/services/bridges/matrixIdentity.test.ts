import { describe, expect, it } from "vitest";

import {
  MatrixIdentityError,
  matrixUserIdForOxyUser,
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
});
