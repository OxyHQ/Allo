import { describe, expect, it } from "vitest";
import {
  claimKeyPackagesRequestSchema,
  claimKeyPackagesResponseSchema,
  keyPackageUploadSchema,
  MAX_KEY_PACKAGE_CLAIMS,
  MAX_KEY_PACKAGES_PER_UPLOAD,
  uploadKeyPackagesRequestSchema,
  uploadKeyPackagesResponseSchema,
} from "../keyPackages";
import { B64, UUID_V7 } from "./fixtures";

const pkg = { ciphersuite: 1, ref: B64, data: B64 };

describe("keyPackageUploadSchema", () => {
  it("accepts suite 1 and suite 65535", () => {
    expect(keyPackageUploadSchema.safeParse(pkg).success).toBe(true);
    expect(keyPackageUploadSchema.safeParse({ ...pkg, ciphersuite: 65535 }).success).toBe(true);
  });
  it("rejects suite 0, 65536, a non-integer, and over-long ref/data", () => {
    expect(keyPackageUploadSchema.safeParse({ ...pkg, ciphersuite: 0 }).success).toBe(false);
    expect(keyPackageUploadSchema.safeParse({ ...pkg, ciphersuite: 65536 }).success).toBe(false);
    expect(keyPackageUploadSchema.safeParse({ ...pkg, ciphersuite: 1.5 }).success).toBe(false);
    expect(keyPackageUploadSchema.safeParse({ ...pkg, ref: "A".repeat(132) }).success).toBe(false);
    expect(keyPackageUploadSchema.safeParse({ ...pkg, data: "A".repeat(8196) }).success).toBe(false);
  });
});

describe("upload request/response", () => {
  it("takes 1..50 packages", () => {
    expect(uploadKeyPackagesRequestSchema.safeParse({ keyPackages: [pkg] }).success).toBe(true);
    expect(uploadKeyPackagesRequestSchema.safeParse({ keyPackages: Array(MAX_KEY_PACKAGES_PER_UPLOAD).fill(pkg) }).success).toBe(true);
    expect(uploadKeyPackagesRequestSchema.safeParse({ keyPackages: [] }).success).toBe(false);
    expect(uploadKeyPackagesRequestSchema.safeParse({ keyPackages: Array(51).fill(pkg) }).success).toBe(false);
  });
  it("answers with a count", () => {
    expect(uploadKeyPackagesResponseSchema.safeParse({ available: 12 }).success).toBe(true);
    expect(uploadKeyPackagesResponseSchema.safeParse({ available: -1 }).success).toBe(false);
  });
});

describe("claim request/response", () => {
  it("takes 1..100 instance ids", () => {
    expect(claimKeyPackagesRequestSchema.safeParse({ instanceIds: [UUID_V7] }).success).toBe(true);
    expect(claimKeyPackagesRequestSchema.safeParse({ instanceIds: Array(MAX_KEY_PACKAGE_CLAIMS).fill(UUID_V7) }).success).toBe(true);
    expect(claimKeyPackagesRequestSchema.safeParse({ instanceIds: [] }).success).toBe(false);
    expect(claimKeyPackagesRequestSchema.safeParse({ instanceIds: Array(101).fill(UUID_V7) }).success).toBe(false);
  });
  it("answers with claimed packages and the missing list", () => {
    expect(
      claimKeyPackagesResponseSchema.safeParse({ keyPackages: [{ ...pkg, instanceId: UUID_V7 }], missing: [UUID_V7] }).success,
    ).toBe(true);
    expect(claimKeyPackagesResponseSchema.safeParse({ keyPackages: [pkg], missing: [] }).success).toBe(false);
    expect(claimKeyPackagesResponseSchema.safeParse({ keyPackages: [] }).success).toBe(false);
  });
});
