import { verifyDeviceHandshake } from "../utils/deviceHandshake";

const USER_ID = "u1";

describe("verifyDeviceHandshake", () => {
  it("rejects an unauthenticated socket", async () => {
    const result = await verifyDeviceHandshake(undefined, 5, async () => true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unauthorized");
  });

  it("allows a connection that claims NO device id (legacy client)", async () => {
    const exists = jest.fn();
    for (const raw of [undefined, null, ""]) {
      const result = await verifyDeviceHandshake(USER_ID, raw, exists);
      expect(result.ok).toBe(true);
      expect(result.deviceId).toBeUndefined();
    }
    // Legacy path never queries the device store.
    expect(exists).not.toHaveBeenCalled();
  });

  it("allows a connection whose claimed device is registered to the user", async () => {
    const exists = jest.fn(async (userId: string, deviceId: number) => {
      expect(userId).toBe(USER_ID);
      expect(deviceId).toBe(5);
      return true;
    });
    const result = await verifyDeviceHandshake(USER_ID, 5, exists);
    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe(5);
  });

  it("coerces a string device id and verifies it", async () => {
    const result = await verifyDeviceHandshake(USER_ID, "5", async () => true);
    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe(5);
  });

  it("rejects a claimed device that is NOT registered (revoked / unknown)", async () => {
    const result = await verifyDeviceHandshake(USER_ID, 99, async () => false);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unregistered_device");
    expect(result.deviceId).toBeUndefined();
  });

  it("rejects a malformed (non-positive / non-integer) device id without querying", async () => {
    const exists = jest.fn();
    for (const raw of [0, -1, 1.5, "abc", {}]) {
      const result = await verifyDeviceHandshake(USER_ID, raw, exists);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("unregistered_device");
    }
    expect(exists).not.toHaveBeenCalled();
  });

  it("rejects with device_verification_failed when the lookup throws", async () => {
    const result = await verifyDeviceHandshake(USER_ID, 5, async () => {
      throw new Error("db down");
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("device_verification_failed");
  });
});
