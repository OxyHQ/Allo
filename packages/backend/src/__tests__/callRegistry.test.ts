import {
  __resetCallRegistryForTests,
  addOnlineDevice,
  getActiveCall,
  getOnlineDeviceIds,
  getUserCallIds,
  isUserBusy,
  registerActiveCall,
  removeActiveCall,
  removeOnlineDevice,
  updateActiveCallStatus,
} from "../utils/callRegistry";

const A = "userA";
const B = "userB";

beforeEach(() => {
  __resetCallRegistryForTests();
});

describe("callRegistry — busy detection", () => {
  it("reports a user as not busy with no calls", () => {
    expect(isUserBusy(A)).toBe(false);
  });

  it("reports both participants busy once a call is registered as ringing", () => {
    registerActiveCall("c1", A, B, "ringing");
    expect(isUserBusy(A)).toBe(true);
    expect(isUserBusy(B)).toBe(true);
  });

  it("keeps a connected call counted as busy", () => {
    registerActiveCall("c1", A, B, "ringing");
    updateActiveCallStatus("c1", "connected");
    expect(isUserBusy(A)).toBe(true);
  });

  it("clears busy state once the call is removed", () => {
    registerActiveCall("c1", A, B, "ringing");
    removeActiveCall("c1");
    expect(isUserBusy(A)).toBe(false);
    expect(isUserBusy(B)).toBe(false);
    expect(getUserCallIds(A)).toEqual([]);
  });

  it("tracks all of a user's live call ids", () => {
    registerActiveCall("c1", A, B, "ringing");
    registerActiveCall("c2", A, "userC", "connected");
    expect(getUserCallIds(A).sort()).toEqual(["c1", "c2"]);
  });

  it("exposes the active call entry with participants", () => {
    registerActiveCall("c1", A, B, "ringing");
    expect(getActiveCall("c1")).toEqual({
      callId: "c1",
      callerId: A,
      calleeId: B,
      status: "ringing",
    });
    expect(getActiveCall("missing")).toBeUndefined();
  });
});

describe("callRegistry — online devices", () => {
  it("tracks and untracks a user's online device ids", () => {
    addOnlineDevice(A, 1);
    addOnlineDevice(A, 2);
    expect(getOnlineDeviceIds(A).sort()).toEqual([1, 2]);

    removeOnlineDevice(A, 1);
    expect(getOnlineDeviceIds(A)).toEqual([2]);

    removeOnlineDevice(A, 2);
    expect(getOnlineDeviceIds(A)).toEqual([]);
  });

  it("reports a device once even with multiple sockets on it", () => {
    addOnlineDevice(A, 1);
    addOnlineDevice(A, 1);
    expect(getOnlineDeviceIds(A)).toEqual([1]);
  });

  it("keeps a device online until its LAST socket disconnects (ref-counted)", () => {
    // Two sockets (e.g. messaging + call signaling) on the same device.
    addOnlineDevice(A, 1);
    addOnlineDevice(A, 1);

    // One socket drops — device is still online via the other.
    removeOnlineDevice(A, 1);
    expect(getOnlineDeviceIds(A)).toEqual([1]);

    // The last socket drops — now offline.
    removeOnlineDevice(A, 1);
    expect(getOnlineDeviceIds(A)).toEqual([]);
  });

  it("ignores an over-removal without going negative", () => {
    addOnlineDevice(A, 1);
    removeOnlineDevice(A, 1);
    removeOnlineDevice(A, 1); // extra remove, should be a no-op
    expect(getOnlineDeviceIds(A)).toEqual([]);
    // Re-adding still works correctly.
    addOnlineDevice(A, 1);
    expect(getOnlineDeviceIds(A)).toEqual([1]);
  });
});
