/**
 * The instance's Ed25519 key: request signing, enrollment approval, and the
 * approval-chain check that decides which of an account's instances may be
 * given a leaf.
 *
 * Chain rule, as verified at the time of use:
 *  - only `active` instances are candidates;
 *  - the ROOT is the first active instance (listing order; `createdAt`
 *    ascending when the listing carries it) with `approvedByInstanceId ===
 *    null`. Any other active root is refused: the server's bootstrap rule
 *    admits one unapproved instance while others are active, so a second one
 *    is either a server fault or an injected key;
 *  - every other instance must name an approver and carry a signature;
 *    naming itself, or an instance of another account, is refused;
 *  - every other instance's `approvalSignature` is verified over
 *    `enrollmentApprovalMessage` with the `enrollmentChallenge` the server
 *    publishes once the instance is approved, under the approver's key, and
 *    the approver's own approval is verified the same way, recursively up to
 *    the root. Nothing is taken on the server's word;
 *  - a REVOKED approver invalidates nothing already approved: its signature
 *    still verifies when its key is in the listing (an own-account listing
 *    carries revoked instances), so trust flows from the approval event, not
 *    from the approver's current status. Another account's listing carries
 *    active instances only, so from outside, an instance whose approver was
 *    revoked cannot be verified and is refused (contract gap, reported).
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { enrollmentApprovalMessage, signedRequestMessage, type PublicInstance, type SignedRequestInput } from "@allo/shared-types";
import { base64Decode, base64Encode, utf8Encode } from "../util/bytes";

export interface SigningKeyPair {
  /** 32-byte raw Ed25519 secret. */
  secretKey: Uint8Array;
  /** 32-byte raw Ed25519 public key. */
  publicKey: Uint8Array;
}

export function generateSigningKey(): SigningKeyPair {
  const secretKey = ed25519.utils.randomSecretKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export function signingKeyFromSecret(secretKey: Uint8Array): SigningKeyPair {
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export function publicKeyBase64(key: SigningKeyPair): string {
  return base64Encode(key.publicKey);
}

/** base64 Ed25519 signature over {@link signedRequestMessage}. */
export function signRequest(key: SigningKeyPair, input: SignedRequestInput): string {
  return base64Encode(ed25519.sign(utf8Encode(signedRequestMessage(input)), key.secretKey));
}

/** base64 Ed25519 signature over {@link enrollmentApprovalMessage}. */
export function signEnrollmentApproval(
  key: SigningKeyPair,
  input: { accountId: string; newInstanceId: string; newSigningPublicKey: string; challenge: string },
): string {
  return base64Encode(ed25519.sign(utf8Encode(enrollmentApprovalMessage(input)), key.secretKey));
}

/** base64 Ed25519 signature over an arbitrary UTF-8 message (archive manifests; see `archiveManifestMessage`). */
export function signUtf8(key: SigningKeyPair, message: string): string {
  return base64Encode(ed25519.sign(utf8Encode(message), key.secretKey));
}

export function verifyEd25519(publicKeyB64: string, message: string, signatureB64: string): boolean {
  try {
    return ed25519.verify(base64Decode(signatureB64), utf8Encode(message), base64Decode(publicKeyB64));
  } catch {
    return false;
  }
}

/** The subset of an instance listing the chain check reads; both `ClientInstance` and `PublicInstance` satisfy it. */
export type ChainInstance = Pick<
  PublicInstance,
  "id" | "accountId" | "signingPublicKey" | "status" | "approvedByInstanceId" | "approvalSignature" | "enrollmentChallenge"
> & {
  createdAt?: string;
};

export interface ChainVerdict {
  trusted: Set<string>;
  /** Why each refused instance was refused; the caller may surface it. */
  refused: Map<string, string>;
}

/**
 * Which instances of ONE account are trusted. Every non-root instance's
 * `approvalSignature` is verified over `enrollmentApprovalMessage` with its
 * published `enrollmentChallenge` under its approver's key, and the approver
 * must itself be trusted, recursively up to the bootstrap root. An approver
 * that is not in the listing cannot be verified and its approvals are
 * refused: the listing the caller holds is the whole evidence.
 */
export function verifyInstanceChain(instances: ChainInstance[]): ChainVerdict {
  const trusted = new Set<string>();
  const refused = new Map<string, string>();
  const active = instances.filter((i) => i.status === "active");
  for (const i of instances) if (i.status !== "active") refused.set(i.id, `status is ${i.status}`);
  if (active.length === 0) return { trusted, refused };

  const accountId = active[0].accountId;
  const ordered = [...active].sort((a, b) => {
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return 0;
  });
  // Approvers may be revoked and still in an own-account listing: their keys count, their status does not.
  const byId = new Map(instances.map((i) => [i.id, i] as const));

  let rootSeen = false;
  for (const i of ordered) {
    if (i.accountId !== accountId) {
      refused.set(i.id, "belongs to another account");
      continue;
    }
    if (i.approvedByInstanceId === null) {
      if (rootSeen) refused.set(i.id, "a second unapproved instance");
      else {
        rootSeen = true;
        trusted.add(i.id);
      }
    }
  }

  // Non-roots: iterate to a fixpoint so listing order does not matter.
  const verified = new Set<string>(trusted); // instances whose own approval is verified (roots by definition)
  const chainRefused = new Set<string>(); // refused for a chain reason, as opposed to merely not active
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const i of ordered) {
      if (trusted.has(i.id) || refused.has(i.id) || i.approvedByInstanceId === null) continue;
      const refuse = (why: string) => {
        refused.set(i.id, why);
        chainRefused.add(i.id);
      };
      if (i.approvedByInstanceId === i.id) {
        refuse("approved by itself");
        continue;
      }
      if (i.approvalSignature === null || i.enrollmentChallenge === null) {
        refuse("approved without a signature or a challenge");
        continue;
      }
      const approver = byId.get(i.approvedByInstanceId);
      if (!approver) {
        refuse(`approver ${i.approvedByInstanceId} is not in the listing`);
        continue;
      }
      if (approver.accountId !== accountId) {
        refuse("approved by another account's instance");
        continue;
      }
      if (chainRefused.has(approver.id)) {
        refuse(`approver ${approver.id} is refused`);
        continue;
      }
      if (!verified.has(approver.id)) continue; // approver not decided yet
      const ok = verifyEd25519(
        approver.signingPublicKey,
        enrollmentApprovalMessage({ accountId, newInstanceId: i.id, newSigningPublicKey: i.signingPublicKey, challenge: i.enrollmentChallenge }),
        i.approvalSignature,
      );
      if (!ok) {
        refuse("approval signature does not verify");
        continue;
      }
      verified.add(i.id);
      trusted.add(i.id);
      progressed = true;
    }
    // A revoked approver with a verified chain lets its approvals through: verify revoked ones too, without trusting them.
    for (const i of instances) {
      if (i.status === "active" || verified.has(i.id) || i.approvedByInstanceId === null || i.accountId !== accountId) continue;
      const approver = byId.get(i.approvedByInstanceId);
      if (!approver || !verified.has(approver.id) || i.approvalSignature === null || i.enrollmentChallenge === null) continue;
      const ok = verifyEd25519(
        approver.signingPublicKey,
        enrollmentApprovalMessage({ accountId, newInstanceId: i.id, newSigningPublicKey: i.signingPublicKey, challenge: i.enrollmentChallenge }),
        i.approvalSignature,
      );
      if (ok) {
        verified.add(i.id);
        progressed = true;
      }
    }
    for (const i of instances) {
      // a revoked bootstrap root is verified (not trusted) so what it approved can still chain to it
      if (i.status !== "active" && i.approvedByInstanceId === null && i.accountId === accountId && !verified.has(i.id) && !rootSeen) {
        verified.add(i.id);
        rootSeen = true;
        progressed = true;
      }
    }
  }
  for (const i of ordered) {
    if (!trusted.has(i.id) && !refused.has(i.id)) {
      const approver = i.approvedByInstanceId ? byId.get(i.approvedByInstanceId) : undefined;
      refused.set(i.id, approver && chainRefused.has(approver.id) ? `approver ${approver.id} is refused` : "approval chain does not reach a verified root");
    }
  }
  return { trusted, refused };
}
