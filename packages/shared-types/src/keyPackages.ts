/**
 * MLS key packages: the public half an instance publishes so that others can
 * add it to a group without it being online. The server stores them opaque
 * and hands each out at most once.
 */
import { z } from "zod";
import { base64Schema, instanceIdSchema, nonNegativeIntSchema } from "./common";

/** An MLS ciphersuite id (RFC 9420 §17.1), a uint16 excluding 0. */
export const ciphersuiteSchema = z.number().int().min(1).max(65535);

export const MAX_KEY_PACKAGES_PER_UPLOAD = 50;
export const MAX_KEY_PACKAGE_CLAIMS = 100;

export const keyPackageUploadSchema = z.object({
  ciphersuite: ciphersuiteSchema,
  /** The KeyPackageRef (hash), base64. Unique per package. */
  ref: base64Schema(128),
  /** The serialised KeyPackage, base64. */
  data: base64Schema(8192),
});
export type KeyPackageUpload = z.infer<typeof keyPackageUploadSchema>;

/** `PUT /v1/key-packages` */
export const uploadKeyPackagesRequestSchema = z.object({
  keyPackages: z.array(keyPackageUploadSchema).min(1).max(MAX_KEY_PACKAGES_PER_UPLOAD),
});
export type UploadKeyPackagesRequest = z.infer<typeof uploadKeyPackagesRequestSchema>;

export const uploadKeyPackagesResponseSchema = z.object({
  /** Unconsumed packages this instance now has on the server. */
  available: nonNegativeIntSchema,
});
export type UploadKeyPackagesResponse = z.infer<typeof uploadKeyPackagesResponseSchema>;

/** `POST /v1/key-packages/claim` */
export const claimKeyPackagesRequestSchema = z.object({
  instanceIds: z.array(instanceIdSchema).min(1).max(MAX_KEY_PACKAGE_CLAIMS),
});
export type ClaimKeyPackagesRequest = z.infer<typeof claimKeyPackagesRequestSchema>;

export const claimedKeyPackageSchema = keyPackageUploadSchema.extend({
  instanceId: instanceIdSchema,
});
export type ClaimedKeyPackage = z.infer<typeof claimedKeyPackageSchema>;

export const claimKeyPackagesResponseSchema = z.object({
  keyPackages: z.array(claimedKeyPackageSchema),
  /** Instances that had nothing left to claim. The caller decides what that means. */
  missing: z.array(instanceIdSchema),
});
export type ClaimKeyPackagesResponse = z.infer<typeof claimKeyPackagesResponseSchema>;
