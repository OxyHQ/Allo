import {
  resolveSignalingRoute,
  isValidDeviceId,
} from "../utils/p2pSignaling";

const USER_A = "userA";
const USER_B = "userB";

describe("isValidDeviceId", () => {
  it("accepts positive integers", () => {
    expect(isValidDeviceId(1)).toBe(true);
    expect(isValidDeviceId(42)).toBe(true);
  });

  it("rejects zero, negatives, non-integers and non-numbers", () => {
    for (const v of [0, -1, 1.5, "5", null, undefined, {}, NaN]) {
      expect(isValidDeviceId(v)).toBe(false);
    }
  });
});

describe("resolveSignalingRoute", () => {
  describe("cross-user (legacy, no toDeviceId)", () => {
    it("routes to the recipient user room", () => {
      const route = resolveSignalingRoute(USER_A, 3, USER_B, undefined);
      expect(route).toEqual({ room: `user:${USER_B}`, fromDeviceId: 3 });
    });

    it("echoes no fromDeviceId when the sender has none (legacy client)", () => {
      const route = resolveSignalingRoute(USER_A, undefined, USER_B, undefined);
      expect(route).toEqual({ room: `user:${USER_B}`, fromDeviceId: undefined });
    });

    it("rejects same-user signaling without a device address", () => {
      expect(resolveSignalingRoute(USER_A, 3, USER_A, undefined)).toBeNull();
    });

    it("rejects an empty or non-string target", () => {
      expect(resolveSignalingRoute(USER_A, 3, "", undefined)).toBeNull();
      expect(resolveSignalingRoute(USER_A, 3, 123, undefined)).toBeNull();
      expect(resolveSignalingRoute(USER_A, 3, null, undefined)).toBeNull();
    });
  });

  describe("device-addressed (Fase 1C, with toDeviceId)", () => {
    it("routes same-user signaling to the target device room", () => {
      // Old device (deviceId 1) → new device (deviceId 2) of the SAME user.
      const route = resolveSignalingRoute(USER_A, 1, USER_A, 2);
      expect(route).toEqual({ room: `device:${USER_A}:2`, fromDeviceId: 1 });
    });

    it("routes cross-user signaling to the target device room", () => {
      const route = resolveSignalingRoute(USER_A, 1, USER_B, 5);
      expect(route).toEqual({ room: `device:${USER_B}:5`, fromDeviceId: 1 });
    });

    it("rejects a device signaling itself (same user AND same device)", () => {
      expect(resolveSignalingRoute(USER_A, 2, USER_A, 2)).toBeNull();
    });

    it("rejects device-addressed signaling from a sender with NO device id (same user)", () => {
      // Without a resolved sender device id the self-signal guard cannot fire, so
      // an unidentified sender must not be allowed to reach a specific device room.
      expect(resolveSignalingRoute(USER_A, undefined, USER_A, 2)).toBeNull();
    });

    it("rejects device-addressed signaling from a sender with NO device id (cross user)", () => {
      // The core authorization gap: a legacy/unidentified client must not be able
      // to target ANY other user's private device room.
      expect(resolveSignalingRoute(USER_A, undefined, USER_B, 5)).toBeNull();
    });

    it("rejects an invalid (non-positive / non-integer) toDeviceId", () => {
      for (const bad of [0, -1, 1.5]) {
        expect(resolveSignalingRoute(USER_A, 1, USER_A, bad)).toBeNull();
      }
    });

    it("rejects an empty target even with a valid device id", () => {
      expect(resolveSignalingRoute(USER_A, 1, "", 2)).toBeNull();
    });
  });
});
