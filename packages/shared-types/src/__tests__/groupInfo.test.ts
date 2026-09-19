import { describe, expect, it } from "vitest";
import { GROUP_INFO_MAX_BASE64 } from "../events";
import { groupInfoResponseSchema, putGroupInfoRequestSchema, storedGroupInfoSchema, type StoredGroupInfo } from "../groupInfo";
import { GROUP_INFO, ISO, UUID_V7 } from "./fixtures";

const stored: StoredGroupInfo = { epoch: 7, signerInstanceId: UUID_V7, data: GROUP_INFO, createdAt: ISO };

describe("storedGroupInfoSchema", () => {
  it("accepts epoch, signer, data and createdAt", () => {
    expect(storedGroupInfoSchema.safeParse(stored).success).toBe(true);
    expect(storedGroupInfoSchema.safeParse({ ...stored, epoch: 0 }).success).toBe(true);
  });
  it("rejects a negative or string epoch, a missing signer, empty or non-base64 data, an over-long data and a bad date", () => {
    expect(storedGroupInfoSchema.safeParse({ ...stored, epoch: -1 }).success).toBe(false);
    expect(storedGroupInfoSchema.safeParse({ ...stored, epoch: "7" }).success).toBe(false);
    const { signerInstanceId: _omit, ...unsigned } = stored;
    expect(storedGroupInfoSchema.safeParse(unsigned).success).toBe(false);
    expect(storedGroupInfoSchema.safeParse({ ...stored, data: "" }).success).toBe(false);
    expect(storedGroupInfoSchema.safeParse({ ...stored, data: "not base64!" }).success).toBe(false);
    expect(storedGroupInfoSchema.safeParse({ ...stored, data: "A".repeat(GROUP_INFO_MAX_BASE64 + 4) }).success).toBe(false);
    expect(storedGroupInfoSchema.safeParse({ ...stored, createdAt: "yesterday" }).success).toBe(false);
  });
});

describe("groupInfoResponseSchema", () => {
  it("wraps a stored group info, and accepts null for a conversation that has none", () => {
    expect(groupInfoResponseSchema.safeParse({ groupInfo: stored }).success).toBe(true);
    expect(groupInfoResponseSchema.safeParse({ groupInfo: null }).success).toBe(true);
    expect(groupInfoResponseSchema.parse({ groupInfo: null })).toEqual({ groupInfo: null });
  });
  it("rejects an absent key and a bare stored shape", () => {
    expect(groupInfoResponseSchema.safeParse({}).success).toBe(false);
    expect(groupInfoResponseSchema.safeParse(stored).success).toBe(false);
  });
});

describe("putGroupInfoRequestSchema", () => {
  it("carries epoch and data, and nothing else is needed", () => {
    expect(putGroupInfoRequestSchema.safeParse({ epoch: 7, data: GROUP_INFO }).success).toBe(true);
    expect(putGroupInfoRequestSchema.safeParse({ epoch: 7, data: "A".repeat(GROUP_INFO_MAX_BASE64) }).success).toBe(true);
  });
  it("rejects a missing epoch, a missing data, non-base64 data and data over the bound", () => {
    expect(putGroupInfoRequestSchema.safeParse({ data: GROUP_INFO }).success).toBe(false);
    expect(putGroupInfoRequestSchema.safeParse({ epoch: 7 }).success).toBe(false);
    expect(putGroupInfoRequestSchema.safeParse({ epoch: 7, data: "not base64!" }).success).toBe(false);
    expect(putGroupInfoRequestSchema.safeParse({ epoch: 7, data: "A".repeat(GROUP_INFO_MAX_BASE64 + 4) }).success).toBe(false);
  });
});
