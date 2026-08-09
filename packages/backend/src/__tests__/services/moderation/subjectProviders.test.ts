import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { REPORTED_TYPES } from "../../../db/schema/moderation";
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
    expect(subjectProviderFor("message")).toBeUndefined();
    expect(subjectProviderFor("conversation")).toBeUndefined();
  });

  it("covers every reported type as either deliverable or explicitly local-only", () => {
    /**
     * The vacuity floor. Without it, a registry that returned an empty map and a
     * `localOnlyTypes()` that returned nothing would satisfy the assertions above
     * for the wrong reason. Every enum member must be accounted for by exactly one
     * of the two lists.
     */
    const all = [...REPORTED_TYPES].sort();
    const accounted = [...deliverableTypes(), ...localOnlyTypes()].sort();
    expect(accounted).toEqual(all);
    expect(all.length).toBeGreaterThan(1);
  });

  it("resolves the user provider to the identity.profile subject type", () => {
    const provider = subjectProviderFor("user");
    expect(provider?.subjectType).toBe("identity.profile");
  });
});

/**
 * §6.4 — the assertion above is necessary and is NOT sufficient.
 *
 * A bridged room is not encrypted. The bridge holds the far side's keys and joins
 * as a member, so the server really can read a WhatsApp message in full, and the
 * argument that protects every other room — "the server holds ciphertext and has no
 * decryption code" — simply does not apply there. That makes a `message` provider
 * *technically* possible for the first time, and it makes the review that would
 * approve it read reasonably: "bridged rooms aren't encrypted, so for those we can
 * describe the content".
 *
 * Pinning `deliverableTypes()` to `['user']` does not catch that change in its most
 * likely form. The one-line version keeps `reportedType: 'user'` and hangs the
 * bridged room's messages off the snapshot's `context`: the deliverable SET is
 * untouched, every assertion above still passes, and a jury of strangers receives a
 * WhatsApp conversation written mostly by somebody with no Oxy account who never
 * agreed to anything.
 *
 * So what is pinned here is the MODULE GRAPH. A provider cannot condition on a
 * room's encryption state without reading room state, and it cannot read room state
 * without importing something that knows what a room is. The closure below is that
 * import surface, and it is deliberately small enough that any growth is a
 * deliberate act with a failing test attached.
 *
 * This will occasionally fail for an innocent refactor. That is the trade: the
 * alternative is a denylist of suspicious module names, which is defeated by
 * calling the new module something else.
 */
describe("what the subject providers are allowed to reach", () => {
  const SUBJECTS_DIRECTORY = path.resolve(__dirname, "../../../services/moderation/subjects");

  /**
   * The first-party modules reachable from `subjects/`, as relative paths from
   * `src/`. Nothing here can observe a room, a conversation, a message or an
   * encryption state — which is the property, stated as a list because a property
   * about absence has to be checked against something.
   */
  const ALLOWED_FIRST_PARTY = [
    /**
     * The reportable-type tuple, which `localOnlyTypes()` subtracts the registry
     * from. It replaces `models/Report.ts`, and the swap is a WIDENING worth
     * reading rather than a rename: this module declares three tables, and one of
     * them is `reports`. What it still cannot reach is any table describing a
     * room, a conversation, a message or an encryption state — those live in
     * sibling schema files this closure never touches, and the pattern below
     * fails loudly if a barrel import ever brings them in.
     */
    "db/schema/columns.ts",
    "db/schema/moderation.ts",
    "services/moderation/subjects/registry.ts",
    "services/moderation/subjects/types.ts",
    "services/moderation/subjects/userSubject.ts",
    "utils/oxyUserDisplay.ts",
  ];

  /** The packages that closure imports. Also pinned: a new one is a new capability. */
  const ALLOWED_PACKAGES = [
    "@allo/shared-types",
    "@oxyhq/core",
    "@oxyhq/crowdsource",
    "@oxyhq/db",
    "drizzle-orm",
    "drizzle-orm/pg-core",
  ];

  /**
   * Module state a provider must not be able to observe, checked by NAME as well.
   *
   * Redundant with the closure while the closure is correct, and it is here for the
   * day it is not: a list that must be edited to make a test pass is a list that
   * gets edited to make a test pass. This one names the thing itself, so widening
   * the closure to include a room-state module still fails, loudly, on the
   * assertion that actually describes §6.4.
   */
  const FORBIDDEN_MODULE_PATTERN = /conversation|message|room|encrypt|cipher|crypto|bridge/i;

  const SOURCE_ROOT = path.resolve(__dirname, "../../..");

  function importSpecifiers(sourcePath: string): string[] {
    /**
     * Comments are stripped before the scan. The prose in these files is long and
     * quotes things, and a scan that read it matched a sentence as a dependency —
     * a test failing for a reason unrelated to what it protects is a test that
     * gets weakened rather than believed.
     */
    const code = readFileSync(sourcePath, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");

    const specifiers: string[] = [];
    /** `import … from "x"`, `export … from "x"` and `import("x")` alike. */
    for (const match of code.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
    return specifiers;
  }

  /** Every first-party module reachable from `subjects/`, plus the packages seen. */
  function moduleClosure(): { firstParty: string[]; packages: string[] } {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const queue = ["registry.ts", "types.ts", "userSubject.ts"].map((file) =>
      path.join(SUBJECTS_DIRECTORY, file),
    );

    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);

      for (const specifier of importSpecifiers(current)) {
        if (!specifier.startsWith(".")) {
          packages.add(specifier);
          continue;
        }
        const resolved = path.resolve(path.dirname(current), `${specifier}.ts`);
        queue.push(resolved);
      }
    }

    return {
      firstParty: [...seen].map((file) => path.relative(SOURCE_ROOT, file)).sort(),
      packages: [...packages].sort(),
    };
  }

  it("reaches exactly the modules it needs to describe an account, and no others", () => {
    const { firstParty, packages } = moduleClosure();

    expect(firstParty).toEqual(ALLOWED_FIRST_PARTY);
    expect(packages).toEqual(ALLOWED_PACKAGES);
  });

  it("registers no provider that can observe a room's encryption state", () => {
    /**
     * The assertion §6.4 asks for by name. `deliverableTypes()` answers "is there a
     * `message` provider"; this answers the harder question — "could any provider
     * behave differently in a bridged room" — and the answer is no, because nothing
     * in its reach can tell it whether a room is encrypted.
     */
    const { firstParty, packages } = moduleClosure();

    for (const module of [...firstParty, ...packages]) {
      expect(
        FORBIDDEN_MODULE_PATTERN.test(module),
        `${module} is reachable from the subject providers. A provider that can see ` +
          "room, conversation or encryption state can be conditioned on a bridged " +
          "room being unencrypted, which is exactly what §6.4 forbids.",
      ).toBe(false);
    }
  });

  it("declares only identity-realm subject types", () => {
    /**
     * The other half of the same door. A provider could keep `reportedType: 'user'`
     * — leaving `deliverableTypes()` untouched — and still tell a jury it is looking
     * at a room. The subject type is what the jury is told, so it is pinned too.
     */
    for (const type of deliverableTypes()) {
      expect(subjectProviderFor(type)?.subjectType).toBe("identity.profile");
    }
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
