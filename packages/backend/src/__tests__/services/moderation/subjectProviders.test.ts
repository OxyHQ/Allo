import { describe, expect, it, vi } from "vitest";
import { ReportedType } from "../../../models/Report";
import {
  deliverableTypes,
  localOnlyTypes,
  subjectProviderFor,
} from "../../../services/moderation/subjects/registry";
import { createUserSubjectProvider } from "../../../services/moderation/subjects/userSubject";

/**
 * What Allo will and will not disclose to a jury.
 *
 * The assertions below look like coverage bookkeeping and are not. Allo is
 * end-to-end encrypted, and the difference between a reported type that leaves the
 * deployment and one that does not is invisible everywhere else: intake answers
 * 201 either way, the response body is identical by design, and the only thing
 * that decides it is whether a provider is registered. So registering one — or
 * having one appear during a refactor, a merge or a copy-paste from another Oxy
 * app — is a privacy change that no other test in this repository would notice.
 *
 * `deliverableTypes()` is pinned to EXACTLY `['user']`. If that assertion ever
 * fails because someone wired up `message`, the failure is the entire point of the
 * file.
 */
describe("moderation subject registry", () => {
  it("delivers exactly one subject type: the account", () => {
    expect(deliverableTypes()).toEqual(["user"]);
  });

  it("accepts message and conversation reports but never delivers them", () => {
    /**
     * Both are real `ReportedType`s — intake stores them — and both have no
     * provider. Asserting membership of `localOnlyTypes()` rather than merely
     * `subjectProviderFor(...) === undefined` also pins that they are still
     * REPORTABLE: a change that deleted the enum values to "fix" this test would
     * break a report surface instead of protecting one.
     */
    expect(localOnlyTypes().sort()).toEqual(["conversation", "message"]);
    expect(subjectProviderFor(ReportedType.MESSAGE)).toBeUndefined();
    expect(subjectProviderFor(ReportedType.CONVERSATION)).toBeUndefined();
  });

  it("covers every reported type as either deliverable or explicitly local-only", () => {
    /**
     * The vacuity floor. Without it, a registry that returned an empty map and a
     * `localOnlyTypes()` that returned nothing would satisfy the assertions above
     * for the wrong reason. Every enum member must be accounted for by exactly one
     * of the two lists.
     */
    const all = Object.values(ReportedType).sort();
    const accounted = [...deliverableTypes(), ...localOnlyTypes()].sort();
    expect(accounted).toEqual(all);
    expect(all.length).toBeGreaterThan(1);
  });

  it("resolves the user provider to the identity.profile subject type", () => {
    const provider = subjectProviderFor(ReportedType.USER);
    expect(provider?.subjectType).toBe("identity.profile");
  });
});

describe("user subject provider", () => {
  const oxyUser = {
    id: "user-1",
    username: "reported_account",
    name: { displayName: "Reported Account", first: "Reported", last: "Account" },
    description: "  A bio with surrounding space  ",
    website: "https://example.test",
  };

  it("reads the profile with the SDK cache bypassed", async () => {
    /**
     * A jury must review the profile as it is now. The SDK's five-minute GET cache
     * would otherwise let a stale display name be the thing that was reviewed, and
     * a moderation snapshot is a consistency-critical read.
     */
    const getUserById = vi.fn().mockResolvedValue(oxyUser);
    await createUserSubjectProvider({ getUserById }).snapshot("user-1");
    expect(getUserById).toHaveBeenCalledWith("user-1", { cache: false });
  });

  it("passes displayName through and never recomposes it from a handle", async () => {
    const getUserById = vi.fn().mockResolvedValue(oxyUser);
    const snapshot = await createUserSubjectProvider({ getUserById }).snapshot("user-1");

    expect(snapshot?.content).toEqual({
      type: "profile",
      data: {
        displayName: "Reported Account",
        bio: "A bio with surrounding space",
        claims: { username: "reported_account", website: "https://example.test" },
      },
    });
  });

  it("omits displayName entirely when the profile has none", async () => {
    /**
     * A profile with no display name is normal, and §5.3 makes every field
     * optional for that reason. Substituting the handle here would show a jury a
     * name the account does not actually display — evidence Allo invented. The
     * handle still travels, as a claim.
     */
    const getUserById = vi.fn().mockResolvedValue({
      id: "user-2",
      username: "handle_only",
      name: {},
    });
    const snapshot = await createUserSubjectProvider({ getUserById }).snapshot("user-2");

    expect(snapshot?.content).toEqual({
      type: "profile",
      data: { claims: { username: "handle_only" } },
    });
  });

  it("emits no permalink, because Allo has no public profile page", async () => {
    const getUserById = vi.fn().mockResolvedValue(oxyUser);
    const snapshot = await createUserSubjectProvider({ getUserById }).snapshot("user-1");

    expect(snapshot?.subject).toEqual({
      externalId: "user-1",
      type: "identity.profile",
      author: { oxyUserId: "user-1" },
    });
    expect(snapshot?.subject).not.toHaveProperty("permalink");
  });

  it("discloses no conversation material of any kind", async () => {
    /**
     * The load-bearing assertion of the whole integration, expressed as a property
     * of the payload rather than a property of the code: whatever the provider
     * grows later, the serialised snapshot must never carry a message, a
     * ciphertext, a key or a participant list.
     */
    const getUserById = vi.fn().mockResolvedValue(oxyUser);
    const snapshot = await createUserSubjectProvider({ getUserById }).snapshot("user-1");
    const serialised = JSON.stringify(snapshot);

    for (const forbidden of [
      "ciphertext",
      "conversationId",
      "participants",
      "identityKey",
      "preKey",
      "encryptedMedia",
      "senderDeviceId",
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
    expect(snapshot?.attachments).toBeUndefined();
    expect(snapshot?.context).toBeUndefined();
  });

  it("returns null for a deleted account instead of throwing", async () => {
    /**
     * `null` means "there is nothing to review" and closes the report; a throw
     * means "try again" and is retried as an outage. A deleted account is the
     * former, and `isOxyUserNotFound` recognises both shapes the Oxy client uses.
     */
    const notFound = Object.assign(new Error("Not Found"), { status: 404 });
    const getUserById = vi.fn().mockRejectedValue(notFound);
    await expect(
      createUserSubjectProvider({ getUserById }).snapshot("gone"),
    ).resolves.toBeNull();
  });

  it("rethrows a transient failure so delivery is retried, not closed", async () => {
    /**
     * The counterpart, and the one that matters more. Swallowing a 503 into `null`
     * would close a live report as "the account no longer exists" — a report
     * silently discarded because Oxy had a bad minute.
     */
    const outage = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const getUserById = vi.fn().mockRejectedValue(outage);
    await expect(
      createUserSubjectProvider({ getUserById }).snapshot("user-1"),
    ).rejects.toThrow("Service Unavailable");
  });

  it("bounds every claim so a profile cannot inflate an envelope", async () => {
    const getUserById = vi.fn().mockResolvedValue({
      id: "user-3",
      username: "x".repeat(500),
      name: { displayName: "y".repeat(500) },
      description: "z".repeat(500),
    });
    const snapshot = await createUserSubjectProvider({ getUserById }).snapshot("user-3");

    /**
     * Read back through the serialised form rather than casting the union.
     * `content` is `string | ResourceInput` and narrowing it with an assertion
     * would be the test agreeing with itself about a shape it never checked.
     */
    const profile: unknown = JSON.parse(JSON.stringify(snapshot?.content));
    expect(profile).toMatchObject({
      type: "profile",
      data: {
        displayName: "y".repeat(200),
        bio: "z".repeat(200),
        claims: { username: "x".repeat(200) },
      },
    });
  });
});
