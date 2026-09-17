/**
 * Client instances: one per installation, each an independent Ed25519
 * signer and an independent MLS leaf. There is no primary device.
 *
 * Enrollment: the first instance on an account is active at once; every
 * later one is `pending` until an active instance signs
 * {@link enrollmentApprovalMessage} over the server-issued challenge.
 */
import { z } from "zod";
import {
  accountIdSchema,
  appIdSchema,
  base64UrlSchema,
  ed25519PublicKeySchema,
  ed25519SignatureSchema,
  instanceIdSchema,
  isoDateSchema,
  platformSchema,
  x25519PublicKeySchema,
} from "./common";

export const INSTANCE_STATUSES = ["pending", "active", "revoked"] as const;
export const instanceStatusSchema = z.enum(INSTANCE_STATUSES);
export type InstanceStatus = z.infer<typeof instanceStatusSchema>;

export const displayNameSchema = z.string().min(1).max(80);

/** The enrollment challenge: 32 random bytes, base64url (43 chars). */
export const enrollmentChallengeSchema = base64UrlSchema(64);

/**
 * An instance as its OWN account sees it. Nullable fields are always present
 * on the wire and `null` until set, mirroring the columns behind them.
 */
export const clientInstanceSchema = z.object({
  id: instanceIdSchema,
  accountId: accountIdSchema,
  appId: appIdSchema,
  platform: platformSchema,
  displayName: displayNameSchema,
  /** Raw 32-byte Ed25519 public key, base64. */
  signingPublicKey: ed25519PublicKeySchema,
  /**
   * Raw 32-byte X25519 public key, base64: what a donor instance seals an
   * archive key to when it offers this instance its history. `null` on an
   * instance registered before the field existed, until it calls
   * `PUT /v1/instances/me/transfer-key`; an offer to such an instance is
   * refused with `transfer_key_missing`.
   */
  transferPublicKey: x25519PublicKeySchema.nullable(),
  status: instanceStatusSchema,
  enrolledAt: isoDateSchema.nullable(),
  revokedAt: isoDateSchema.nullable(),
  lastSeenAt: isoDateSchema.nullable(),
  /** `null` for the bootstrap instance, which nobody approved. */
  approvedByInstanceId: instanceIdSchema.nullable(),
  approvalSignature: ed25519SignatureSchema.nullable(),
  /**
   * The challenge the approval signature was made over, published once the
   * instance is approved so that ANY client can verify the chain
   * (`enrollmentApprovalMessage` needs it). `null` for the bootstrap instance
   * and while an enrollment is still pending: the challenge is secret only
   * until it has been signed. Without it a verifier would have to trust the
   * server's word that an instance was approved, which is the one thing the
   * chain exists to make unnecessary.
   */
  enrollmentChallenge: enrollmentChallengeSchema.nullable(),
  createdAt: isoDateSchema,
});
export type ClientInstance = z.infer<typeof clientInstanceSchema>;

/**
 * An instance as OTHER accounts see it: what they need to verify its
 * enrollment chain and address it as an MLS leaf, and nothing personal.
 */
export const publicInstanceSchema = clientInstanceSchema.pick({
  id: true,
  accountId: true,
  appId: true,
  platform: true,
  signingPublicKey: true,
  transferPublicKey: true,
  approvedByInstanceId: true,
  approvalSignature: true,
  enrollmentChallenge: true,
  status: true,
});
export type PublicInstance = z.infer<typeof publicInstanceSchema>;

/** `POST /v1/instances` */
export const registerInstanceRequestSchema = z.object({
  appId: appIdSchema,
  platform: platformSchema,
  displayName: displayNameSchema,
  signingPublicKey: ed25519PublicKeySchema,
  /** Required: every instance registered from now on can receive history. */
  transferPublicKey: x25519PublicKeySchema,
});
export type RegisterInstanceRequest = z.infer<typeof registerInstanceRequestSchema>;

export const ENROLLMENT_OUTCOMES = ["active", "pending"] as const;
export const enrollmentOutcomeSchema = z.enum(ENROLLMENT_OUTCOMES);
export type EnrollmentOutcome = z.infer<typeof enrollmentOutcomeSchema>;

export const registerInstanceResponseSchema = z
  .object({
    instance: clientInstanceSchema,
    enrollment: enrollmentOutcomeSchema,
    /** Present exactly when `enrollment === "pending"`. */
    challenge: enrollmentChallengeSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.enrollment === "pending" && v.challenge === undefined) {
      ctx.addIssue({ code: "custom", path: ["challenge"], message: "a pending enrollment carries a challenge" });
    }
    if (v.enrollment === "active" && v.challenge !== undefined) {
      ctx.addIssue({ code: "custom", path: ["challenge"], message: "an active enrollment has no challenge" });
    }
  });
export type RegisterInstanceResponse = z.infer<typeof registerInstanceResponseSchema>;

/** `POST /v1/instances/:id/approve` */
export const approveInstanceRequestSchema = z.object({
  approvalSignature: ed25519SignatureSchema,
});
export type ApproveInstanceRequest = z.infer<typeof approveInstanceRequestSchema>;

/** `GET /v1/instances` */
export const listInstancesResponseSchema = z.object({
  instances: z.array(clientInstanceSchema),
});
export type ListInstancesResponse = z.infer<typeof listInstancesResponseSchema>;

/** `GET /v1/accounts/:accountId/instances` */
export const listAccountInstancesResponseSchema = z.object({
  instances: z.array(publicInstanceSchema),
});
export type ListAccountInstancesResponse = z.infer<typeof listAccountInstancesResponseSchema>;

export const pendingEnrollmentSchema = z.object({
  instance: clientInstanceSchema,
  challenge: enrollmentChallengeSchema,
});
export type PendingEnrollment = z.infer<typeof pendingEnrollmentSchema>;

/** `GET /v1/instances/pending` */
export const listPendingEnrollmentsResponseSchema = z.object({
  pending: z.array(pendingEnrollmentSchema),
});
export type ListPendingEnrollmentsResponse = z.infer<typeof listPendingEnrollmentsResponseSchema>;

/** `GET /v1/instances/:id`, `POST …/approve` — the one instance, after. */
export const instanceResponseSchema = z.object({
  instance: clientInstanceSchema,
});
export type InstanceResponse = z.infer<typeof instanceResponseSchema>;

export const PUSH_PROVIDERS = ["fcm", "apns"] as const;
export const pushProviderSchema = z.enum(PUSH_PROVIDERS);
export type PushProvider = z.infer<typeof pushProviderSchema>;

/** `PUT /v1/instances/me/push` */
export const setPushTokenRequestSchema = z.object({
  provider: pushProviderSchema,
  token: z.string().min(1).max(1024),
});
export type SetPushTokenRequest = z.infer<typeof setPushTokenRequestSchema>;

/**
 * `PUT /v1/instances/me/transfer-key` — for an instance registered before
 * `transferPublicKey` existed. Answers with the instance, after.
 */
export const setTransferKeyRequestSchema = z.object({
  transferPublicKey: x25519PublicKeySchema,
});
export type SetTransferKeyRequest = z.infer<typeof setTransferKeyRequestSchema>;

/**
 * Domain separator of the enrollment approval signature. Its presence is what
 * stops an approval signature being replayed as a request signature or the
 * other way round: the two messages never share a first line.
 */
export const ENROLLMENT_SIGNING_CONTEXT = "allo-enroll-v1";

export interface EnrollmentApprovalInput {
  accountId: string;
  newInstanceId: string;
  /** The NEW instance's raw Ed25519 public key, base64 — exactly as registered. */
  newSigningPublicKey: string;
  /** The challenge the server issued at registration, base64url — exactly as issued. */
  challenge: string;
}

/**
 * The bytes (as a UTF-8 string) an approving instance signs and the server
 * verifies. ONE definition, used on both sides:
 *
 *     "allo-enroll-v1\n" + accountId + "\n" + newInstanceId + "\n" + newSigningPublicKey + "\n" + challenge
 */
export function enrollmentApprovalMessage(input: EnrollmentApprovalInput): string {
  return (
    ENROLLMENT_SIGNING_CONTEXT +
    "\n" +
    input.accountId +
    "\n" +
    input.newInstanceId +
    "\n" +
    input.newSigningPublicKey +
    "\n" +
    input.challenge
  );
}
