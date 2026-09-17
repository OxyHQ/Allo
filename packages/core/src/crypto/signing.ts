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
 *  - when the verifier KNOWS the approval challenge (it approved the instance
 *    itself, or it is the instance) the signature is verified under the
 *    approver's key and a mismatch is refused. The challenge is not on the
 *    wire for third parties (`PublicInstance` has no such field), so across
 *    accounts the signature is attested by the server rather than checked
 *    here. That is a contract limitation and it is reported as such;
 *  - a REVOKED approver invalidates nothing already approved: revocation is
 *    not in the listing, and an instance that was legitimately approved does
 *    not become illegitimate because its approver was later lost. Trust flows
 *    from the approval event, not from the approver's current status.
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

export function verifyEd25519(publicKeyB64: string, message: string, signatureB64: string): boolean {
  try {
    return ed25519.verify(base64Decode(signatureB64), utf8Encode(message), base64Decode(publicKeyB64));
  } catch {
    return false;
  }
}

/** The subset of an instance listing the chain check reads; both `ClientInstance` and `PublicInstance` satisfy it. */
export type ChainInstance = Pick<PublicInstance, "id" | "accountId" | "signingPublicKey" | "status" | "approvedByInstanceId" | "approvalSignature"> & {
  createdAt?: string;
};

export interface ChainVerdict {
  trusted: Set<string>;
  /** Why each refused instance was refused; the caller may surface it. */
  refused: Map<string, string>;
}

/**
 * Which instances of ONE account are trusted. `knownChallenges` maps an
 * instance id to the enrollment challenge the verifier holds for it.
 */
export function verifyInstanceChain(instances: ChainInstance[], knownChallenges?: Map<string, string>): ChainVerdict {
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
  const byId = new Map(ordered.map((i) => [i.id, i] as const));

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
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const i of ordered) {
      if (trusted.has(i.id) || refused.has(i.id) || i.approvedByInstanceId === null) continue;
      if (i.approvedByInstanceId === i.id) {
        refused.set(i.id, "approved by itself");
        continue;
      }
      if (i.approvalSignature === null) {
        refused.set(i.id, "approved without a signature");
        continue;
      }
      const approver = byId.get(i.approvedByInstanceId);
      if (approver && !trusted.has(approver.id)) {
        if (refused.has(approver.id)) {
          refused.set(i.id, `approver ${approver.id} is refused`);
        }
        continue; // approver not decided yet
      }
      const challenge = knownChallenges?.get(i.id);
      if (challenge !== undefined) {
        const approverKey = approver?.signingPublicKey ?? knownChallenges?.get(`key:${i.approvedByInstanceId}`);
        if (approverKey === undefined) {
          // Approver revoked and its key unknown: attested only (see the header).
        } else {
          const ok = verifyEd25519(
            approverKey,
            enrollmentApprovalMessage({ accountId, newInstanceId: i.id, newSigningPublicKey: i.signingPublicKey, challenge }),
            i.approvalSignature,
          );
          if (!ok) {
            refused.set(i.id, "approval signature does not verify");
            continue;
          }
        }
      }
      trusted.add(i.id);
      progressed = true;
    }
  }
  for (const i of ordered) {
    if (!trusted.has(i.id) && !refused.has(i.id)) refused.set(i.id, "approval chain does not reach a root");
  }
  return { trusted, refused };
}
