import { describe, expect, it } from "vitest";
import {
  approveInstanceRequestSchema,
  clientInstanceSchema,
  ENROLLMENT_SIGNING_CONTEXT,
  enrollmentApprovalMessage,
  listInstancesResponseSchema,
  listPendingEnrollmentsResponseSchema,
  publicInstanceSchema,
  registerInstanceRequestSchema,
  registerInstanceResponseSchema,
  setPushTokenRequestSchema,
  type ClientInstance,
  type PublicInstance,
} from "../instances";
import { CHALLENGE, ISO, OBJECT_ID, PUBKEY, SIGNATURE, UUID_V7 } from "./fixtures";

const instance: ClientInstance = {
  id: UUID_V7,
  accountId: OBJECT_ID,
  appId: "allo",
  platform: "ios",
  displayName: "Nate's phone",
  signingPublicKey: PUBKEY,
  status: "active",
  enrolledAt: ISO,
  revokedAt: null,
  lastSeenAt: null,
  approvedByInstanceId: null,
  approvalSignature: null,
  createdAt: ISO,
};

describe("clientInstanceSchema", () => {
  it("accepts a bootstrap instance and one approved by another", () => {
    expect(clientInstanceSchema.safeParse(instance).success).toBe(true);
    expect(
      clientInstanceSchema.safeParse({ ...instance, approvedByInstanceId: UUID_V7, approvalSignature: SIGNATURE }).success,
    ).toBe(true);
  });
  it("rejects a missing nullable field, a bad status and a short key", () => {
    const { revokedAt: _omit, ...missing } = instance;
    expect(clientInstanceSchema.safeParse(missing).success).toBe(false);
    expect(clientInstanceSchema.safeParse({ ...instance, status: "enabled" }).success).toBe(false);
    expect(clientInstanceSchema.safeParse({ ...instance, signingPublicKey: "AAAA" }).success).toBe(false);
  });
});

describe("publicInstanceSchema", () => {
  it("strips displayName and timestamps from a full instance", () => {
    const parsed = publicInstanceSchema.parse(instance);
    expect(Object.keys(parsed).sort()).toEqual(
      ["accountId", "appId", "approvalSignature", "approvedByInstanceId", "id", "platform", "signingPublicKey", "status"].sort(),
    );
    const _typed: PublicInstance = parsed;
    expect("displayName" in parsed).toBe(false);
  });
  it("rejects when the key is missing", () => {
    const { signingPublicKey: _omit, ...rest } = instance;
    expect(publicInstanceSchema.safeParse(rest).success).toBe(false);
  });
});

describe("registerInstanceRequestSchema", () => {
  const body = { appId: "allo", platform: "web", displayName: "Firefox", signingPublicKey: PUBKEY };
  it("accepts a well-formed registration", () => {
    expect(registerInstanceRequestSchema.safeParse(body).success).toBe(true);
  });
  it("rejects an empty or 81-char display name and an unknown platform", () => {
    expect(registerInstanceRequestSchema.safeParse({ ...body, displayName: "" }).success).toBe(false);
    expect(registerInstanceRequestSchema.safeParse({ ...body, displayName: "x".repeat(81) }).success).toBe(false);
    expect(registerInstanceRequestSchema.safeParse({ ...body, platform: "watch" }).success).toBe(false);
  });
});

describe("registerInstanceResponseSchema", () => {
  it("pending carries a challenge, active does not", () => {
    expect(registerInstanceResponseSchema.safeParse({ instance, enrollment: "active" }).success).toBe(true);
    expect(
      registerInstanceResponseSchema.safeParse({ instance: { ...instance, status: "pending" }, enrollment: "pending", challenge: CHALLENGE })
        .success,
    ).toBe(true);
  });
  it("rejects pending without a challenge and active with one", () => {
    expect(registerInstanceResponseSchema.safeParse({ instance, enrollment: "pending" }).success).toBe(false);
    expect(registerInstanceResponseSchema.safeParse({ instance, enrollment: "active", challenge: CHALLENGE }).success).toBe(false);
  });
});

describe("approve / list / pending / push", () => {
  it("approve needs an 88-char signature", () => {
    expect(approveInstanceRequestSchema.safeParse({ approvalSignature: SIGNATURE }).success).toBe(true);
    expect(approveInstanceRequestSchema.safeParse({ approvalSignature: PUBKEY }).success).toBe(false);
  });
  it("list wraps instances; pending wraps instance+challenge", () => {
    expect(listInstancesResponseSchema.safeParse({ instances: [instance] }).success).toBe(true);
    expect(listInstancesResponseSchema.safeParse([instance]).success).toBe(false);
    expect(listPendingEnrollmentsResponseSchema.safeParse({ pending: [{ instance, challenge: CHALLENGE }] }).success).toBe(true);
    expect(listPendingEnrollmentsResponseSchema.safeParse({ pending: [{ instance }] }).success).toBe(false);
  });
  it("push token takes fcm|apns and 1..1024 chars", () => {
    expect(setPushTokenRequestSchema.safeParse({ provider: "fcm", token: "t" }).success).toBe(true);
    expect(setPushTokenRequestSchema.safeParse({ provider: "apns", token: "t".repeat(1024) }).success).toBe(true);
    expect(setPushTokenRequestSchema.safeParse({ provider: "expo", token: "t" }).success).toBe(false);
    expect(setPushTokenRequestSchema.safeParse({ provider: "fcm", token: "" }).success).toBe(false);
    expect(setPushTokenRequestSchema.safeParse({ provider: "fcm", token: "t".repeat(1025) }).success).toBe(false);
  });
});

describe("enrollmentApprovalMessage", () => {
  it("is byte-exact: context, accountId, newInstanceId, key, challenge joined by LF", () => {
    expect(ENROLLMENT_SIGNING_CONTEXT).toBe("allo-enroll-v1");
    const message = enrollmentApprovalMessage({
      accountId: "acc",
      newInstanceId: "inst",
      newSigningPublicKey: "KEY=",
      challenge: "chal",
    });
    expect(message).toBe("allo-enroll-v1\nacc\ninst\nKEY=\nchal");
    expect(message.split("\n")).toHaveLength(5);
  });
});
