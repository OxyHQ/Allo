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
    ...p,
  };
}

describe("approval chain", () => {
  it("trusts the bootstrap root and instances it approved; refuses forged signatures and second roots", () => {
    const rootKey = generateSigningKey();
    const root = instance({ id: "i1", signingPublicKey: publicKeyBase64(rootKey), createdAt: "2026-01-01T00:00:00.000Z" });
    const secondKey = generateSigningKey();
    const challenge = "Y2hhbGxlbmdl";
    const secondPub = publicKeyBase64(secondKey);
    const sig = signEnrollmentApproval(rootKey, { accountId: "acc", newInstanceId: "i2", newSigningPublicKey: secondPub, challenge });
    expect(enrollmentApprovalMessage({ accountId: "acc", newInstanceId: "i2", newSigningPublicKey: secondPub, challenge })).toBe(`allo-enroll-v1\nacc\ni2\n${secondPub}\n${challenge}`);
    const second = instance({ id: "i2", signingPublicKey: secondPub, approvedByInstanceId: "i1", approvalSignature: sig, createdAt: "2026-01-02T00:00:00.000Z" });
    const forgedSig = signEnrollmentApproval(generateSigningKey(), { accountId: "acc", newInstanceId: "i3", newSigningPublicKey: "x", challenge });
    const forged = instance({ id: "i3", approvedByInstanceId: "i1", approvalSignature: forgedSig, createdAt: "2026-01-03T00:00:00.000Z" });
    const secondRoot = instance({ id: "i4", approvedByInstanceId: null, createdAt: "2026-01-04T00:00:00.000Z" });
    const selfApproved = instance({ id: "i5", approvedByInstanceId: "i5", approvalSignature: sig, createdAt: "2026-01-05T00:00:00.000Z" });
    const revoked = instance({ id: "i6", status: "revoked", approvedByInstanceId: "i1", approvalSignature: sig });
    const challenges = new Map([
      ["i2", challenge],
      ["i3", challenge],
    ]);
    const verdict = verifyInstanceChain([secondRoot, forged, second, root, selfApproved, revoked], challenges);
    expect([...verdict.trusted].sort()).toEqual(["i1", "i2"]);
    expect(verdict.refused.get("i3")).toBe("approval signature does not verify");
    expect(verdict.refused.get("i4")).toBe("a second unapproved instance");
    expect(verdict.refused.get("i5")).toBe("approved by itself");
    expect(verdict.refused.get("i6")).toBe("status is revoked");
  });

  it("without the challenge a third party accepts the server's attestation; a dangling approver is a refusal only when no root is reached", () => {
    const root = instance({ id: "i1" });
    const approved = instance({ id: "i2", approvedByInstanceId: "i1", approvalSignature: "A".repeat(88) });
    const chained = instance({ id: "i3", approvedByInstanceId: "i2", approvalSignature: "A".repeat(88) });
    const orphan = instance({ id: "i9", approvedByInstanceId: "i7", approvalSignature: "A".repeat(88) });
    const verdict = verifyInstanceChain([root, approved, chained, orphan] as PublicInstance[]);
    expect([...verdict.trusted].sort()).toEqual(["i1", "i2", "i3", "i9"]);
  });

  it("an instance approved by a since-revoked approver stays trusted (trust flows from the approval, not the approver's status)", () => {
    const rootKey = generateSigningKey();
    const root = instance({ id: "i1", signingPublicKey: publicKeyBase64(rootKey), status: "revoked" });
    const k2 = generateSigningKey();
    const sig = signEnrollmentApproval(rootKey, { accountId: "acc", newInstanceId: "i2", newSigningPublicKey: publicKeyBase64(k2), challenge: "c" });
    const second = instance({ id: "i2", signingPublicKey: publicKeyBase64(k2), approvedByInstanceId: "i1", approvalSignature: sig });
    const verdict = verifyInstanceChain([root, second], new Map([["i2", "c"], ["key:i1", publicKeyBase64(rootKey)]]));
    expect([...verdict.trusted]).toEqual(["i2"]);
    // and with the approver's key known, a wrong signature is still refused
    const bad = { ...second, approvalSignature: signEnrollmentApproval(generateSigningKey(), { accountId: "acc", newInstanceId: "i2", newSigningPublicKey: publicKeyBase64(k2), challenge: "c" }) };
    expect(verifyInstanceChain([root, bad], new Map([["i2", "c"], ["key:i1", publicKeyBase64(rootKey)]])).trusted.size).toBe(0);
  });
});
