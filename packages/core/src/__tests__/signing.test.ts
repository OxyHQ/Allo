import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { enrollmentApprovalMessage, signedRequestMessage, type PublicInstance } from "@allo/shared-types";
import { generateSigningKey, publicKeyBase64, signEnrollmentApproval, signRequest, verifyInstanceChain, type ChainInstance } from "../crypto/signing";
import { base64Decode, sha256Hex, utf8Encode } from "../util/bytes";

describe("request signing", () => {
  it("produces a signature a verifier built from shared-types accepts, byte for byte", () => {
    const key = generateSigningKey();
    const body = utf8Encode(JSON.stringify({ hello: "world" }));
    const input = { method: "post", pathWithQuery: "/v1/sync?cursor=MA&limit=50", timestampMs: 1_700_000_000_000, bodySha256Hex: sha256Hex(body) };
    const sig = signRequest(key, input);
    const expectedMessage = "allo-v1\nPOST\n/v1/sync?cursor=MA&limit=50\n1700000000000\n" + sha256Hex(body);
    expect(signedRequestMessage(input)).toBe(expectedMessage);
    expect(ed25519.verify(base64Decode(sig), utf8Encode(expectedMessage), key.publicKey)).toBe(true);
    // a different path does not verify
    expect(ed25519.verify(base64Decode(sig), utf8Encode(expectedMessage.replace("limit=50", "limit=51")), key.publicKey)).toBe(false);
  });
});

function instance(p: Partial<ChainInstance> & { id: string }): ChainInstance {
  return {
    accountId: "acc",
    signingPublicKey: publicKeyBase64(generateSigningKey()),
    status: "active",
    approvedByInstanceId: null,
    approvalSignature: null,
    enrollmentChallenge: null,
    ...p,
  };
}

function approve(approverKey: ReturnType<typeof generateSigningKey>, approverId: string, id: string, p: Partial<ChainInstance> = {}): { inst: ChainInstance; key: ReturnType<typeof generateSigningKey> } {
  const key = generateSigningKey();
  const challenge = `chal-${id}`;
  const sig = signEnrollmentApproval(approverKey, { accountId: "acc", newInstanceId: id, newSigningPublicKey: publicKeyBase64(key), challenge });
  return { inst: instance({ id, signingPublicKey: publicKeyBase64(key), approvedByInstanceId: approverId, approvalSignature: sig, enrollmentChallenge: challenge, ...p }), key };
}

describe("approval chain", () => {
  it("verifies every signature up to the root; refuses forged, unsigned, self-approved, second-root and dangling instances", () => {
    const rootKey = generateSigningKey();
    const root = instance({ id: "i1", signingPublicKey: publicKeyBase64(rootKey), createdAt: "2026-01-01T00:00:00.000Z" });
    const second = approve(rootKey, "i1", "i2", { createdAt: "2026-01-02T00:00:00.000Z" });
    const third = approve(second.key, "i2", "i3", { createdAt: "2026-01-03T00:00:00.000Z" }); // depth 3
    expect(enrollmentApprovalMessage({ accountId: "acc", newInstanceId: "i2", newSigningPublicKey: second.inst.signingPublicKey, challenge: "chal-i2" })).toBe(
      `allo-enroll-v1\nacc\ni2\n${second.inst.signingPublicKey}\nchal-i2`,
    );
    const forged = approve(generateSigningKey(), "i1", "i4"); // signed by a key that is not the approver's
    const unsigned = instance({ id: "i5", approvedByInstanceId: "i1", approvalSignature: null, enrollmentChallenge: "c" });
    const noChallenge = instance({ id: "i6", approvedByInstanceId: "i1", approvalSignature: "A".repeat(88), enrollmentChallenge: null });
    const secondRoot = instance({ id: "i7", approvedByInstanceId: null, createdAt: "2026-01-07T00:00:00.000Z" });
    const selfApproved = instance({ id: "i8", approvedByInstanceId: "i8", approvalSignature: "A".repeat(88), enrollmentChallenge: "c" });
    const dangling = approve(generateSigningKey(), "i-gone", "i9");
    const viaForged = approve(forged.key, "i4", "i10"); // a valid signature under a refused approver
    const revoked = approve(rootKey, "i1", "i11", { status: "revoked" });
    const verdict = verifyInstanceChain([viaForged.inst, secondRoot, third.inst, forged.inst, second.inst, root, unsigned, noChallenge, selfApproved, dangling.inst, revoked.inst]);
    expect([...verdict.trusted].sort()).toEqual(["i1", "i2", "i3"]);
    expect(verdict.refused.get("i4")).toBe("approval signature does not verify");
    expect(verdict.refused.get("i5")).toBe("approved without a signature or a challenge");
    expect(verdict.refused.get("i6")).toBe("approved without a signature or a challenge");
    expect(verdict.refused.get("i7")).toBe("a second unapproved instance");
    expect(verdict.refused.get("i8")).toBe("approved by itself");
    expect(verdict.refused.get("i9")).toBe("approver i-gone is not in the listing");
    expect(verdict.refused.get("i10")).toBe("approver i4 is refused");
    expect(verdict.refused.get("i11")).toBe("status is revoked");
  });

  it("an instance approved by a since-revoked approver stays trusted when the approver is in the listing (own account), and is refused when it is not (another account's active-only listing)", () => {
    const rootKey = generateSigningKey();
    const root = instance({ id: "i1", signingPublicKey: publicKeyBase64(rootKey), status: "revoked" });
    const second = approve(rootKey, "i1", "i2");
    expect([...verifyInstanceChain([root, second.inst]).trusted]).toEqual(["i2"]);
    const outside = verifyInstanceChain([second.inst]);
    expect(outside.trusted.size).toBe(0);
    expect(outside.refused.get("i2")).toBe("approver i1 is not in the listing");
    // a revoked mid-chain approver: root → revoked i2 → i3 stays trusted
    const third = approve(second.key, "i2", "i3");
    const activeRoot = instance({ id: "i1", signingPublicKey: publicKeyBase64(rootKey) });
    expect([...verifyInstanceChain([activeRoot, { ...second.inst, status: "revoked" }, third.inst]).trusted].sort()).toEqual(["i1", "i3"]);
  });

  it("a third party must see a bootstrap root: an active-only listing with no unapproved instance trusts nothing", () => {
    const rootKey = generateSigningKey();
    const second = approve(rootKey, "i1", "i2");
    const verdict = verifyInstanceChain([second.inst] as PublicInstance[]);
    expect(verdict.trusted.size).toBe(0);
  });
});
