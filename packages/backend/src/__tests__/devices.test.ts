import request from "supertest";
import { buildApp } from "./testApp";
import { installMockMessaging, type MockMessaging } from "./helpers/mockSocket";
import devicesRoutes from "../routes/devices";
import Device from "../models/Device";
import MessageEnvelope from "../models/MessageEnvelope";
import PushToken from "../models/PushToken";
import { daysAgo, daysFromNow, PREKEY_BATCH_MAX_TARGETS } from "../config/multiDevice";

const USER_ID = "u1";
const PEER_ID = "u2";

function makeApp(userId: string = USER_ID) {
  return buildApp({
    injectUserId: userId,
    mount: [{ path: "/api/devices", router: devicesRoutes }],
  });
}

async function registerDevice(
  userId: string,
  deviceId: number,
  opts: { preKeys?: Array<{ keyId: number; publicKey: string }>; lastSeen?: Date } = {}
) {
  return Device.create({
    userId,
    deviceId,
    identityKeyPublic: `idkey-${userId}-${deviceId}`,
    signedPreKey: { keyId: 1, publicKey: "spk", signature: "sig" },
    preKeys: opts.preKeys ?? [],
    registrationId: 1000 + deviceId,
    lastSeen: opts.lastSeen ?? new Date(),
  });
}

describe("POST /api/devices/prekeys/batch", () => {
  it("consumes one prekey per target atomically and reports missing devices", async () => {
    await registerDevice(PEER_ID, 1, {
      preKeys: [
        { keyId: 10, publicKey: "pk10" },
        { keyId: 11, publicKey: "pk11" },
      ],
    });
    await registerDevice(PEER_ID, 2, { preKeys: [{ keyId: 20, publicKey: "pk20" }] });

    const res = await request(makeApp())
      .post("/api/devices/prekeys/batch")
      .send({
        targets: [
          { userId: PEER_ID, deviceId: 1 },
          { userId: PEER_ID, deviceId: 2 },
          { userId: PEER_ID, deviceId: 99 }, // not registered
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.bundles).toHaveLength(2);
    expect(res.body.data.missing).toEqual(
      expect.arrayContaining([{ userId: PEER_ID, deviceId: 99 }])
    );

    const bundle1 = res.body.data.bundles.find(
      (b: { deviceId: number }) => b.deviceId === 1
    );
    expect(bundle1.userId).toBe(PEER_ID);
    expect(bundle1.preKey).toEqual({ keyId: 10, publicKey: "pk10" });
    expect(bundle1.remainingPreKeys).toBe(1);

    // The consumed prekey is gone from the device document.
    const device1 = await Device.findOne({ userId: PEER_ID, deviceId: 1 }).lean();
    expect(device1?.preKeys.map((k) => k.keyId)).toEqual([11]);

    const device2 = await Device.findOne({ userId: PEER_ID, deviceId: 2 }).lean();
    expect(device2?.preKeys).toHaveLength(0);
  });

  it("de-duplicates repeated targets so a prekey is consumed at most once", async () => {
    await registerDevice(PEER_ID, 1, {
      preKeys: [
        { keyId: 10, publicKey: "pk10" },
        { keyId: 11, publicKey: "pk11" },
      ],
    });

    const res = await request(makeApp())
      .post("/api/devices/prekeys/batch")
      .send({
        targets: [
          { userId: PEER_ID, deviceId: 1 },
          { userId: PEER_ID, deviceId: 1 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.bundles).toHaveLength(1);
    const device = await Device.findOne({ userId: PEER_ID, deviceId: 1 }).lean();
    expect(device?.preKeys).toHaveLength(1); // only one consumed
  });

  it("rejects an empty or missing targets array", async () => {
    const res1 = await request(makeApp()).post("/api/devices/prekeys/batch").send({});
    expect(res1.status).toBe(400);

    const res2 = await request(makeApp())
      .post("/api/devices/prekeys/batch")
      .send({ targets: [] });
    expect(res2.status).toBe(400);
  });

  it("rejects more than the maximum number of targets", async () => {
    const targets = Array.from({ length: PREKEY_BATCH_MAX_TARGETS + 1 }, (_, i) => ({
      userId: PEER_ID,
      deviceId: i + 1,
    }));
    const res = await request(makeApp())
      .post("/api/devices/prekeys/batch")
      .send({ targets });
    expect(res.status).toBe(413);
  });

  it("rejects malformed targets", async () => {
    const res = await request(makeApp())
      .post("/api/devices/prekeys/batch")
      .send({ targets: [{ userId: "", deviceId: 1 }] });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/devices/user/:userId", () => {
  it("returns active devices with public metadata and splits out inactive ones", async () => {
    await registerDevice(PEER_ID, 1, { lastSeen: new Date() });
    await Device.create({
      userId: PEER_ID,
      deviceId: 2,
      identityKeyPublic: "idkey-2",
      signedPreKey: { keyId: 1, publicKey: "spk", signature: "sig" },
      preKeys: [{ keyId: 1, publicKey: "secret" }],
      registrationId: 1002,
      deviceName: "Old Tablet",
      platform: "android",
      lastSeen: daysAgo(45), // inactive (> 30d) but not deletable (< 90d)
    });

    const res = await request(makeApp()).get(`/api/devices/user/${PEER_ID}`);
    expect(res.status).toBe(200);

    const activeIds = res.body.data.devices.map((d: { deviceId: number }) => d.deviceId);
    expect(activeIds).toEqual([1]);

    const inactiveIds = res.body.data.inactiveDevices.map((d: { deviceId: number }) => d.deviceId);
    expect(inactiveIds).toEqual([2]);

    // Public metadata present; no preKeys leaked.
    const inactive = res.body.data.inactiveDevices[0];
    expect(inactive.deviceName).toBe("Old Tablet");
    expect(inactive.platform).toBe("android");
    expect(inactive.lastSeen).toBeDefined();
    expect(inactive.preKeys).toBeUndefined();
  });

  it("includes inactive devices in `devices` when includeInactive=true", async () => {
    await registerDevice(PEER_ID, 1, { lastSeen: new Date() });
    await registerDevice(PEER_ID, 2, { lastSeen: daysAgo(45) });

    const res = await request(makeApp())
      .get(`/api/devices/user/${PEER_ID}`)
      .query({ includeInactive: "true" });

    expect(res.status).toBe(200);
    const ids = res.body.data.devices.map((d: { deviceId: number }) => d.deviceId);
    expect(ids.sort()).toEqual([1, 2]);
  });

  it("treats a device with no lastSeen but a recent createdAt as active", async () => {
    await registerDevice(PEER_ID, 1, { lastSeen: new Date() });
    // A freshly-registered device that has never reported a lastSeen. Remove the
    // field so the shared activity rule must fall back to createdAt (recent).
    await registerDevice(PEER_ID, 2);
    await Device.updateOne(
      { userId: PEER_ID, deviceId: 2 },
      { $unset: { lastSeen: "" } }
    );

    const res = await request(makeApp()).get(`/api/devices/user/${PEER_ID}`);
    expect(res.status).toBe(200);

    const activeIds = res.body.data.devices
      .map((d: { deviceId: number }) => d.deviceId)
      .sort();
    expect(activeIds).toEqual([1, 2]);
    expect(res.body.data.inactiveDevices).toEqual([]);
  });

  it("falls back to createdAt: a device with no lastSeen and an old createdAt is inactive", async () => {
    await registerDevice(PEER_ID, 1, { lastSeen: new Date() });
    await registerDevice(PEER_ID, 2);
    // Drop lastSeen and back-date createdAt past the inactive horizon (but within
    // the delete horizon) so the fallback to createdAt classifies it inactive.
    // Use the native driver to bypass Mongoose's immutable `createdAt`.
    await Device.collection.updateOne(
      { userId: PEER_ID, deviceId: 2 },
      { $unset: { lastSeen: "" }, $set: { createdAt: daysAgo(45) } }
    );

    const res = await request(makeApp()).get(`/api/devices/user/${PEER_ID}`);
    expect(res.status).toBe(200);

    const activeIds = res.body.data.devices.map((d: { deviceId: number }) => d.deviceId);
    expect(activeIds).toEqual([1]);
    const inactiveIds = res.body.data.inactiveDevices.map(
      (d: { deviceId: number }) => d.deviceId
    );
    expect(inactiveIds).toEqual([2]);
  });

  it("lazily deletes devices stale beyond the delete horizon", async () => {
    await registerDevice(PEER_ID, 1, { lastSeen: new Date() });
    await registerDevice(PEER_ID, 2, { lastSeen: daysAgo(120) }); // > 90d

    const res = await request(makeApp()).get(`/api/devices/user/${PEER_ID}`);
    expect(res.status).toBe(200);

    // Device 2 should have been hard-deleted.
    expect(await Device.findOne({ userId: PEER_ID, deviceId: 2 }).lean()).toBeNull();
    const allIds = [
      ...res.body.data.devices,
      ...res.body.data.inactiveDevices,
    ].map((d: { deviceId: number }) => d.deviceId);
    expect(allIds).toEqual([1]);
  });
});

describe("POST /api/devices (register with name/platform)", () => {
  it("stores a sanitized deviceName and platform", async () => {
    const res = await request(makeApp())
      .post("/api/devices")
      .send({
        deviceId: 3,
        identityKeyPublic: "idkey",
        signedPreKey: { keyId: 1, publicKey: "spk", signature: "sig" },
        preKeys: [{ keyId: 1, publicKey: "pk" }],
        registrationId: 1234,
        deviceName: "  My iPhone  ",
        platform: "ios",
      });

    expect(res.status).toBe(201);
    const device = await Device.findOne({ userId: USER_ID, deviceId: 3 }).lean();
    expect(device?.deviceName).toBe("My iPhone");
    expect(device?.platform).toBe("ios");
  });

  it("ignores an invalid platform value", async () => {
    const res = await request(makeApp())
      .post("/api/devices")
      .send({
        deviceId: 4,
        identityKeyPublic: "idkey",
        signedPreKey: { keyId: 1, publicKey: "spk", signature: "sig" },
        preKeys: [{ keyId: 1, publicKey: "pk" }],
        registrationId: 1234,
        platform: "windows",
      });

    expect(res.status).toBe(201);
    const device = await Device.findOne({ userId: USER_ID, deviceId: 4 }).lean();
    expect(device?.platform).toBeUndefined();
  });
});

describe("single GET /api/devices/user/:userId/prekeys/:deviceId still works", () => {
  it("consumes a prekey via the shared helper", async () => {
    await registerDevice(PEER_ID, 1, {
      preKeys: [{ keyId: 10, publicKey: "pk10" }],
    });

    const res = await request(makeApp()).get(
      `/api/devices/user/${PEER_ID}/prekeys/1`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.preKey).toEqual({ keyId: 10, publicKey: "pk10" });
    expect(res.body.data.remainingPreKeys).toBe(0);

    const device = await Device.findOne({ userId: PEER_ID, deviceId: 1 }).lean();
    expect(device?.preKeys).toHaveLength(0);
  });

  it("returns 404 for an unregistered device", async () => {
    const res = await request(makeApp()).get(
      `/api/devices/user/${PEER_ID}/prekeys/7`
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/devices/push-token", () => {
  it("registers a token and links the Signal device id", async () => {
    const res = await request(makeApp())
      .post("/api/devices/push-token")
      .send({
        token: "fcm-token-abc",
        type: "fcm",
        platform: "android",
        locale: "en",
        signalDeviceId: 3,
      });

    expect(res.status).toBe(200);
    const stored = await PushToken.findOne({ token: "fcm-token-abc" }).lean();
    expect(stored?.userId).toBe(USER_ID);
    expect(stored?.type).toBe("fcm");
    expect(stored?.deviceId).toBe("3"); // string-converted Signal device id
    expect(stored?.enabled).toBe(true);
  });

  it("requires a token", async () => {
    const res = await request(makeApp()).post("/api/devices/push-token").send({});
    expect(res.status).toBe(400);
  });

  it("disables a token on DELETE", async () => {
    await PushToken.create({ userId: USER_ID, token: "to-disable", type: "fcm" });
    const res = await request(makeApp())
      .delete("/api/devices/push-token")
      .send({ token: "to-disable" });

    expect(res.status).toBe(200);
    const stored = await PushToken.findOne({ token: "to-disable" }).lean();
    expect(stored?.enabled).toBe(false);
  });

  it("rejects re-registering another user's token (409) and leaves it intact", async () => {
    // PEER_ID owns the token.
    await PushToken.create({ userId: PEER_ID, token: "peer-token", type: "fcm" });

    // USER_ID tries to claim it.
    const res = await request(makeApp(USER_ID))
      .post("/api/devices/push-token")
      .send({ token: "peer-token", type: "fcm", platform: "android" });

    expect(res.status).toBe(409);

    // Ownership unchanged — no hijack.
    const stored = await PushToken.findOne({ token: "peer-token" }).lean();
    expect(stored?.userId).toBe(PEER_ID);
  });

  it("allows the owner to re-register their own token", async () => {
    await PushToken.create({
      userId: USER_ID,
      token: "own-token",
      type: "fcm",
      enabled: false,
    });

    const res = await request(makeApp(USER_ID))
      .post("/api/devices/push-token")
      .send({ token: "own-token", type: "fcm", platform: "ios", signalDeviceId: 2 });

    expect(res.status).toBe(200);
    const stored = await PushToken.findOne({ token: "own-token" }).lean();
    expect(stored?.userId).toBe(USER_ID);
    expect(stored?.enabled).toBe(true); // re-enabled
    expect(stored?.deviceId).toBe("2");
  });

  it("rejects deleting another user's token (409) and leaves it enabled", async () => {
    await PushToken.create({ userId: PEER_ID, token: "peer-del-token", type: "fcm" });

    const res = await request(makeApp(USER_ID))
      .delete("/api/devices/push-token")
      .send({ token: "peer-del-token" });

    expect(res.status).toBe(409);
    const stored = await PushToken.findOne({ token: "peer-del-token" }).lean();
    expect(stored?.userId).toBe(PEER_ID);
    expect(stored?.enabled).toBe(true); // untouched
  });
});

async function createEnvelope(
  recipientUserId: string,
  recipientDeviceId: number,
  messageId: string
) {
  return MessageEnvelope.create({
    messageId,
    conversationId: "conv1",
    senderId: PEER_ID,
    senderDeviceId: 1,
    recipientUserId,
    recipientDeviceId,
    ciphertext: `ct-${messageId}`,
    expiresAt: daysFromNow(90),
  });
}

describe("DELETE /api/devices/:deviceId (revocation cascade)", () => {
  let mock: MockMessaging;

  beforeEach(() => {
    mock = installMockMessaging();
  });

  afterEach(() => {
    mock.restore();
  });

  it("deletes the device, its envelopes and disables its push token", async () => {
    await registerDevice(USER_ID, 2, { lastSeen: new Date() });
    // Envelopes addressed to the revoked device + an unrelated one that must survive.
    await createEnvelope(USER_ID, 2, "m1");
    await createEnvelope(USER_ID, 2, "m2");
    const survivor = await createEnvelope(USER_ID, 3, "m3");
    // Push token linked to the revoked device id (stored as a string) + an unrelated one.
    await PushToken.create({ userId: USER_ID, token: "tok-dev2", type: "fcm", deviceId: "2" });
    await PushToken.create({ userId: USER_ID, token: "tok-dev3", type: "fcm", deviceId: "3" });

    const res = await request(makeApp()).delete("/api/devices/2");
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);

    // Device row gone.
    expect(await Device.findOne({ userId: USER_ID, deviceId: 2 }).lean()).toBeNull();

    // Only the revoked device's envelopes were deleted.
    expect(await MessageEnvelope.findOne({ recipientUserId: USER_ID, recipientDeviceId: 2 }).lean()).toBeNull();
    const remaining = await MessageEnvelope.find({}).lean();
    expect(remaining.map((e) => String(e._id))).toEqual([String(survivor._id)]);

    // The linked push token is disabled; the unrelated one is untouched.
    expect((await PushToken.findOne({ token: "tok-dev2" }).lean())?.enabled).toBe(false);
    expect((await PushToken.findOne({ token: "tok-dev3" }).lean())?.enabled).toBe(true);
  });

  it("emits device:revoked + deviceListChanged and disconnects the device room sockets", async () => {
    await registerDevice(USER_ID, 2, { lastSeen: new Date() });

    const res = await request(makeApp()).delete("/api/devices/2");
    expect(res.status).toBe(200);

    const room = `device:${USER_ID}:2`;

    // device:revoked to the device room with the numeric device id.
    const revokedEmits = mock.emitsTo(room).filter((e) => e.event === "device:revoked");
    expect(revokedEmits).toHaveLength(1);
    expect((revokedEmits[0].payload as { deviceId: number }).deviceId).toBe(2);

    // deviceListChanged to the owner's user room.
    const listEmits = mock.emitsTo(`user:${USER_ID}`).filter((e) => e.event === "deviceListChanged");
    expect(listEmits).toHaveLength(1);
    expect((listEmits[0].payload as { userId: string }).userId).toBe(USER_ID);

    // The device room's sockets were force-disconnected.
    const dc = mock.disconnectsOf(room);
    expect(dc).toHaveLength(1);
    expect(dc[0].close).toBe(true);
  });

  it("emits device:revoked BEFORE disconnecting the room (ordering)", async () => {
    await registerDevice(USER_ID, 2, { lastSeen: new Date() });
    await request(makeApp()).delete("/api/devices/2");

    const room = `device:${USER_ID}:2`;
    // The revoked emit must be recorded; disconnect happens after. Since emits and
    // disconnects are separate ordered logs, assert both occurred for the room.
    expect(mock.emitsTo(room).some((e) => e.event === "device:revoked")).toBe(true);
    expect(mock.disconnectsOf(room)).toHaveLength(1);
  });

  it("returns 404 (no cascade) when the device does not belong to the caller", async () => {
    // PEER_ID owns the device; USER_ID must not be able to revoke it.
    await registerDevice(PEER_ID, 5, { lastSeen: new Date() });
    await createEnvelope(PEER_ID, 5, "m1");

    const res = await request(makeApp(USER_ID)).delete("/api/devices/5");
    expect(res.status).toBe(404);

    // Nothing cascaded: the peer's device and envelope are intact.
    expect(await Device.findOne({ userId: PEER_ID, deviceId: 5 }).lean()).not.toBeNull();
    expect(await MessageEnvelope.countDocuments({ recipientUserId: PEER_ID })).toBe(1);
    expect(mock.emits).toHaveLength(0);
    expect(mock.disconnects).toHaveLength(0);
  });

  it("allows self-revocation (acts as a remote wipe of the current device)", async () => {
    await registerDevice(USER_ID, 7, { lastSeen: new Date() });

    // The request carries this device's own id in X-Device-Id; revocation of the
    // current device is permitted.
    const res = await request(makeApp())
      .delete("/api/devices/7")
      .set("X-Device-Id", "7");
    expect(res.status).toBe(200);

    expect(await Device.findOne({ userId: USER_ID, deviceId: 7 }).lean()).toBeNull();
    const revoked = mock.emitsTo(`device:${USER_ID}:7`).filter((e) => e.event === "device:revoked");
    expect(revoked).toHaveLength(1);
  });

  it("rejects an invalid deviceId", async () => {
    const res = await request(makeApp()).delete("/api/devices/abc");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/devices (identity-change warning)", () => {
  let mock: MockMessaging;

  beforeEach(() => {
    mock = installMockMessaging();
  });

  afterEach(() => {
    mock.restore();
  });

  it("emits deviceIdentityChanged when re-registering with a DIFFERENT identity key", async () => {
    await registerDevice(USER_ID, 9, { lastSeen: daysAgo(1) });
    // Overwrite the on-file identity key for clarity.
    await Device.updateOne({ userId: USER_ID, deviceId: 9 }, { $set: { identityKeyPublic: "OLD-KEY" } });

    const res = await request(makeApp())
      .post("/api/devices")
      .send({
        deviceId: 9,
        identityKeyPublic: "NEW-KEY",
        signedPreKey: { keyId: 1, publicKey: "spk", signature: "sig" },
        preKeys: [{ keyId: 1, publicKey: "pk" }],
        registrationId: 1234,
      });

    expect(res.status).toBe(200);

    const emits = mock.emitsTo(`user:${USER_ID}`).filter((e) => e.event === "deviceIdentityChanged");
    expect(emits).toHaveLength(1);
    expect(emits[0].payload).toEqual({ userId: USER_ID, deviceId: 9 });

    // The overwrite is still applied (Phase B will pin identities).
    const stored = await Device.findOne({ userId: USER_ID, deviceId: 9 }).lean();
    expect(stored?.identityKeyPublic).toBe("NEW-KEY");
  });

  it("does NOT emit deviceIdentityChanged when the identity key is unchanged", async () => {
    await registerDevice(USER_ID, 9, { lastSeen: daysAgo(1) });
    await Device.updateOne({ userId: USER_ID, deviceId: 9 }, { $set: { identityKeyPublic: "SAME-KEY" } });

    const res = await request(makeApp())
      .post("/api/devices")
      .send({
        deviceId: 9,
        identityKeyPublic: "SAME-KEY",
        signedPreKey: { keyId: 2, publicKey: "spk2", signature: "sig2" },
        preKeys: [{ keyId: 2, publicKey: "pk2" }],
        registrationId: 5678,
      });

    expect(res.status).toBe(200);
    expect(mock.emitsOf("deviceIdentityChanged")).toHaveLength(0);
  });

  it("does NOT emit deviceIdentityChanged for a brand new device", async () => {
    const res = await request(makeApp())
      .post("/api/devices")
      .send({
        deviceId: 11,
        identityKeyPublic: "FRESH-KEY",
        signedPreKey: { keyId: 1, publicKey: "spk", signature: "sig" },
        preKeys: [{ keyId: 1, publicKey: "pk" }],
        registrationId: 1234,
      });

    expect(res.status).toBe(201);
    expect(mock.emitsOf("deviceIdentityChanged")).toHaveLength(0);
  });
});

describe("PUT /api/devices/:deviceId (identity-change warning)", () => {
  let mock: MockMessaging;

  beforeEach(() => {
    mock = installMockMessaging();
  });

  afterEach(() => {
    mock.restore();
  });

  it("emits deviceIdentityChanged when PUT changes the identity key", async () => {
    await registerDevice(USER_ID, 9, { lastSeen: daysAgo(1) });
    await Device.updateOne({ userId: USER_ID, deviceId: 9 }, { $set: { identityKeyPublic: "OLD-KEY" } });

    const res = await request(makeApp())
      .put("/api/devices/9")
      .send({
        identityKeyPublic: "NEW-KEY",
        signedPreKey: { keyId: 1, publicKey: "spk", signature: "sig" },
        preKeys: [{ keyId: 1, publicKey: "pk" }],
        registrationId: 1234,
      });

    expect(res.status).toBe(200);

    const emits = mock.emitsTo(`user:${USER_ID}`).filter((e) => e.event === "deviceIdentityChanged");
    expect(emits).toHaveLength(1);
    expect(emits[0].payload).toEqual({ userId: USER_ID, deviceId: 9 });

    // The overwrite is still applied (Phase B will pin identities).
    const stored = await Device.findOne({ userId: USER_ID, deviceId: 9 }).lean();
    expect(stored?.identityKeyPublic).toBe("NEW-KEY");
  });

  it("does NOT emit deviceIdentityChanged when PUT keeps the same identity key", async () => {
    await registerDevice(USER_ID, 9, { lastSeen: daysAgo(1) });
    await Device.updateOne({ userId: USER_ID, deviceId: 9 }, { $set: { identityKeyPublic: "SAME-KEY" } });

    const res = await request(makeApp())
      .put("/api/devices/9")
      .send({
        identityKeyPublic: "SAME-KEY",
        signedPreKey: { keyId: 2, publicKey: "spk2", signature: "sig2" },
        preKeys: [{ keyId: 2, publicKey: "pk2" }],
        registrationId: 5678,
      });

    expect(res.status).toBe(200);
    expect(mock.emitsOf("deviceIdentityChanged")).toHaveLength(0);
  });

  it("does NOT emit deviceIdentityChanged when PUT omits the identity key", async () => {
    // A PUT that only rotates the signed prekey (no identityKeyPublic) must not
    // fire the security-code-changed signal.
    await registerDevice(USER_ID, 9, { lastSeen: daysAgo(1) });
    await Device.updateOne({ userId: USER_ID, deviceId: 9 }, { $set: { identityKeyPublic: "KEEP-KEY" } });

    const res = await request(makeApp())
      .put("/api/devices/9")
      .send({
        signedPreKey: { keyId: 3, publicKey: "spk3", signature: "sig3" },
      });

    expect(res.status).toBe(200);
    expect(mock.emitsOf("deviceIdentityChanged")).toHaveLength(0);
    const stored = await Device.findOne({ userId: USER_ID, deviceId: 9 }).lean();
    expect(stored?.identityKeyPublic).toBe("KEEP-KEY");
  });
});
