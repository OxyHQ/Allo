import { oxyClient } from "@oxyhq/core";
import type { User } from "@oxyhq/core";
import { isOxyUserNotFound } from "../../../utils/oxyUserDisplay";
import type { ModerationSubjectProvider, ModerationSubjectSnapshot } from "./types";

/**
 * A reported account, as universal material (§5.3 `profile`).
 *
 * This is the ONLY subject Allo can send for review, and everything about it is
 * shaped by that. Oxy owns identity, so the material comes from Oxy and is passed
 * through unchanged. Nothing here reads a conversation, a message, a participant
 * list or a ciphertext — a jury sees the account's own public self-presentation
 * and the reporter's allegation, and that is the entire disclosure.
 *
 * `name.displayName` is read directly and never recomposed from `first`/`last` or
 * from the username: what a jury judges has to be what the account actually shows,
 * and a name this code assembled would be evidence Allo invented. A profile with
 * no display name is normal, and every field of §5.3's `profile` resource is
 * optional for exactly that reason, so nothing here substitutes a handle for a
 * missing name — the handle travels separately, as a claim.
 */

/** §5.3 `profile.claims`: bounded, flat, scalar. */
const MAX_CLAIM_LENGTH = 200;

function claim(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_CLAIM_LENGTH) : undefined;
}

/**
 * The identity source, injectable so a test can describe an account without a
 * network. Production passes the SDK singleton.
 */
export interface UserSubjectDependencies {
  readonly getUserById: (userId: string, options?: { cache?: boolean }) => Promise<User>;
}

export function createUserSubjectProvider(
  dependencies: UserSubjectDependencies = {
    getUserById: (userId, options) => oxyClient.getUserById(userId, options),
  },
): ModerationSubjectProvider {
  return {
    reportedType: "user",
    subjectType: "identity.profile",

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      let user: User;
      try {
        /**
         * `cache: false`: a jury must review the profile as it is NOW, and the
         * SDK's five-minute GET cache would otherwise let a stale display name or
         * bio be the thing that was reviewed. A moderation snapshot is a
         * consistency-critical read.
         */
        user = await dependencies.getUserById(reportedId, { cache: false });
      } catch (error) {
        /**
         * A deleted or unknown account is `null`, not a throw — the caller treats
         * that as "there is nothing to review", whereas a thrown error is retried
         * as an outage. Every OTHER failure (network, 5xx, auth) must keep
         * throwing, so a transient Oxy problem is retried instead of being
         * recorded as a report about an account that does not exist.
         */
        if (isOxyUserNotFound(error)) return null;
        throw error;
      }

      const displayName = claim(user.name?.displayName);
      const bio = claim(user.description ?? user.bio);
      const username = claim(user.username);

      /**
       * Claims, not evidence. A username and a website are what the account
       * asserts about itself; they matter for an impersonation allegation and are
       * exactly the fields §5.3 means by `claims`.
       */
      const claims: Record<string, string> = {};
      if (username !== undefined) claims.username = username;
      const website = claim(user.website);
      if (website !== undefined) claims.website = website;

      return {
        subject: {
          externalId: reportedId,
          type: "identity.profile",
          /**
           * No `permalink`. Allo has no public profile page — `app/(chat)/u` is an
           * in-app route behind authentication, so any URL emitted here would be
           * one a reviewer cannot open and Allo invented. `permalink` is optional
           * precisely so nobody has to make one up.
           */
          author: { oxyUserId: reportedId },
        },
        content: {
          type: "profile",
          data: {
            ...(displayName === undefined ? {} : { displayName }),
            ...(bio === undefined ? {} : { bio }),
            ...(Object.keys(claims).length > 0 ? { claims } : {}),
          },
        },
      };
    },
  };
}
