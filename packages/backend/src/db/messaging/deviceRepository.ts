/**
 * The Signal Protocol device registry, as Postgres.
 *
 * Ported from what `routes/devices.ts` asks `models/Device.ts` for — eight call
 * sites, no more.
 *
 * ## `deviceId` means two different things and they must not be confused
 *
 * `devices.id` is this table's own text primary key. `devices.deviceId` is
 * SIGNAL's device number, 1-based and unique only WITHIN a user — it is what
 * every route path parameter carries, and what `device_pre_keys.deviceId` does
 * NOT reference (that column points at `devices.id`). Every function here takes
 * the pair `(userId, signalDeviceId)`, because Signal's number alone does not
 * identify a device.
 *
 * ## Protected columns are opted into BY NAME, here
 *
 * `devices` registers its three key-material columns and `device_pre_keys`
 * registers `publicKey`. Handing out public key material IS what a key-exchange
 * endpoint does, so the selections below name those columns explicitly — the
 * registry's sanctioned opt-in — and the one projection that must NOT carry them
 * ({@link listDeviceBundlesForUser}'s caller-facing bundle) is a separate,
 * narrower selection rather than the same one filtered later.
 *
 * ## What replaced `.select("-preKeys")`
 *
 * Mongo stored one-time pre-keys as an array on the device and the list route
 * excluded them by name. They are a child table now, so nothing joins them by
 * accident: {@link listDevicesForUser} cannot leak them because it never reads
 * them, and only {@link findDevicePreKeys} and {@link findDevice} do.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { uuidv7, type SelectedRow } from "@oxyhq/db";
import type { PreKey, SignedPreKey } from "@allo/shared-types";
import type { AlloDatabase } from "../index";
import { devicePreKeys, devices } from "../schema/devices";

/**
 * A device with its key material — the shape both the owner's own views and the
 * key-exchange views are built from.
 */
const DEVICE_COLUMNS = {
  id: devices.id,
  userId: devices.userId,
  deviceId: devices.deviceId,
  identityKeyPublic: devices.identityKeyPublic,
  signedPreKeyId: devices.signedPreKeyId,
  signedPreKeyPublic: devices.signedPreKeyPublic,
  signedPreKeySignature: devices.signedPreKeySignature,
  registrationId: devices.registrationId,
  lastSeen: devices.lastSeen,
  createdAt: devices.createdAt,
  updatedAt: devices.updatedAt,
} as const;

const PRE_KEY_COLUMNS = {
  keyId: devicePreKeys.keyId,
  publicKey: devicePreKeys.publicKey,
} as const;

type DeviceRow = SelectedRow<typeof DEVICE_COLUMNS>;

export interface DeviceRecord {
  readonly id: string;
  readonly userId: string;
  /** Signal's own device number, 1-based. */
  readonly deviceId: number;
  readonly identityKeyPublic: string;
  /** Re-assembled from the three columns the embedded document flattened into. */
  readonly signedPreKey: SignedPreKey;
  readonly registrationId: number;
  readonly lastSeen: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A device plus its one-time pre-keys, for the two paths that may see them. */
export interface DeviceWithPreKeys extends DeviceRecord {
  readonly preKeys: readonly PreKey[];
}

/**
 * What a STRANGER gets for key exchange: no `userId`, no timestamps, no
 * one-time pre-keys. Mongo spelled it `.select("deviceId identityKeyPublic
 * signedPreKey registrationId")`, and it is a narrower selection here rather
 * than a filtered {@link DEVICE_COLUMNS} so the projection cannot silently
 * widen when a column is added to the table.
 */
const DEVICE_BUNDLE_COLUMNS = {
  id: devices.id,
  deviceId: devices.deviceId,
  identityKeyPublic: devices.identityKeyPublic,
  signedPreKeyId: devices.signedPreKeyId,
  signedPreKeyPublic: devices.signedPreKeyPublic,
  signedPreKeySignature: devices.signedPreKeySignature,
  registrationId: devices.registrationId,
} as const;

export interface DeviceBundle {
  readonly id: string;
  readonly deviceId: number;
  readonly identityKeyPublic: string;
  readonly signedPreKey: SignedPreKey;
  readonly registrationId: number;
}

function toDeviceRecord(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    identityKeyPublic: row.identityKeyPublic,
    signedPreKey: {
      keyId: row.signedPreKeyId,
      publicKey: row.signedPreKeyPublic,
      signature: row.signedPreKeySignature,
    },
    registrationId: row.registrationId,
    lastSeen: row.lastSeen,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDeviceBundle(row: SelectedRow<typeof DEVICE_BUNDLE_COLUMNS>): DeviceBundle {
  return {
    id: row.id,
    deviceId: row.deviceId,
    identityKeyPublic: row.identityKeyPublic,
    signedPreKey: {
      keyId: row.signedPreKeyId,
      publicKey: row.signedPreKeyPublic,
      signature: row.signedPreKeySignature,
    },
    registrationId: row.registrationId,
  };
}

/**
 * The caller's own devices, WITHOUT one-time pre-keys.
 *
 * Ordered by Signal's device number, as the route did — the numbers are what a
 * user sees ("this phone is device 2"), so ordering by insertion time would
 * shuffle a list whose labels are stable.
 */
export async function listDevicesForUser(
  db: AlloDatabase,
  userId: string,
): Promise<DeviceRecord[]> {
  const rows = await db
    .select(DEVICE_COLUMNS)
    .from(devices)
    .where(eq(devices.userId, userId))
    .orderBy(asc(devices.deviceId));
  return rows.map(toDeviceRecord);
}

/** One of the caller's own devices, pre-keys included — `GET /api/devices/:deviceId`. */
export async function findDevice(
  db: AlloDatabase,
  userId: string,
  signalDeviceId: number,
): Promise<DeviceWithPreKeys | null> {
  const rows = await db
    .select(DEVICE_COLUMNS)
    .from(devices)
    .where(and(eq(devices.userId, userId), eq(devices.deviceId, signalDeviceId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const preKeys = await db
    .select(PRE_KEY_COLUMNS)
    .from(devicePreKeys)
    .where(eq(devicePreKeys.deviceId, row.id))
    .orderBy(asc(devicePreKeys.keyId));

  return { ...toDeviceRecord(row), preKeys };
}

/**
 * Somebody else's devices, as public bundles for key exchange — no one-time
 * pre-keys, which are handed out one at a time by {@link findDevicePreKeys}.
 */
export async function listDeviceBundlesForUser(
  db: AlloDatabase,
  userId: string,
): Promise<DeviceBundle[]> {
  const rows = await db
    .select(DEVICE_BUNDLE_COLUMNS)
    .from(devices)
    .where(eq(devices.userId, userId))
    .orderBy(asc(devices.deviceId));
  return rows.map(toDeviceBundle);
}

/**
 * A device's one-time pre-keys.
 *
 * `null` distinguishes "no such device" from a device that HAS no pre-keys left
 * — an exhausted bundle and a wrong device id are different answers, and the
 * route turns only the first into a 404.
 */
export async function findDevicePreKeys(
  db: AlloDatabase,
  userId: string,
  signalDeviceId: number,
): Promise<PreKey[] | null> {
  const rows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.userId, userId), eq(devices.deviceId, signalDeviceId)))
    .limit(1);

  const device = rows[0];
  if (!device) return null;

  return db
    .select(PRE_KEY_COLUMNS)
    .from(devicePreKeys)
    .where(eq(devicePreKeys.deviceId, device.id))
    .orderBy(asc(devicePreKeys.keyId));
}

export interface RegisterDeviceInput {
  readonly userId: string;
  /** Signal's own device number. */
  readonly deviceId: number;
  readonly identityKeyPublic: string;
  readonly signedPreKey: SignedPreKey;
  readonly preKeys: readonly PreKey[];
  readonly registrationId: number;
}

export interface RegisterDeviceResult {
  readonly device: DeviceWithPreKeys;
  /** `true` for a first registration (201), `false` for a re-registration (200). */
  readonly created: boolean;
}

/**
 * Register a device, or re-register an existing one — one statement, no race.
 *
 * The route read the device, branched on whether it found one, and then either
 * inserted or updated. Two registrations of the same device racing there both
 * saw nothing and both inserted, and the loser got a duplicate-key 409 for a
 * request that was perfectly valid. `ON CONFLICT (user_id, device_id) DO UPDATE`
 * has no such window.
 *
 * `created` comes from `xmax = 0`, the system column that distinguishes the two
 * branches of an upsert: it is zero on a row this statement inserted and
 * non-zero on one it updated. Re-deriving it by comparing `created_at` to
 * `updated_at` would be a guess, and re-reading first would restore the race
 * this statement exists to close.
 *
 * Pre-keys are REPLACED wholesale, which is what the route's `preKeys = preKeys`
 * assignment did. That is a genuine part of the contract — a client rotating its
 * bundle is not merging with what the server held — so the delete and the insert
 * commit with the device in one transaction, and a failure cannot leave a device
 * advertising a bundle it no longer has.
 */
export async function registerDevice(
  db: AlloDatabase,
  input: RegisterDeviceInput,
): Promise<RegisterDeviceResult> {
  return db.transaction(async (tx) => {
    const upserted = await tx
      .insert(devices)
      .values({
        id: uuidv7(),
        userId: input.userId,
        deviceId: input.deviceId,
        identityKeyPublic: input.identityKeyPublic,
        signedPreKeyId: input.signedPreKey.keyId,
        signedPreKeyPublic: input.signedPreKey.publicKey,
        signedPreKeySignature: input.signedPreKey.signature,
        registrationId: input.registrationId,
        lastSeen: new Date(),
      })
      .onConflictDoUpdate({
        target: [devices.userId, devices.deviceId],
        set: {
          identityKeyPublic: input.identityKeyPublic,
          signedPreKeyId: input.signedPreKey.keyId,
          signedPreKeyPublic: input.signedPreKey.publicKey,
          signedPreKeySignature: input.signedPreKey.signature,
          registrationId: input.registrationId,
          lastSeen: new Date(),
        },
      })
      .returning({ ...DEVICE_COLUMNS, inserted: sql<boolean>`xmax = 0` });

    const row = upserted[0];
    if (!row) throw new Error(`Device ${input.userId}/${String(input.deviceId)} produced no row`);

    await tx.delete(devicePreKeys).where(eq(devicePreKeys.deviceId, row.id));
    if (input.preKeys.length > 0) {
      await tx.insert(devicePreKeys).values(
        input.preKeys.map((preKey) => ({
          id: uuidv7(),
          deviceId: row.id,
          keyId: preKey.keyId,
          publicKey: preKey.publicKey,
        })),
      );
    }

    return {
      device: { ...toDeviceRecord(row), preKeys: [...input.preKeys] },
      created: row.inserted,
    };
  });
}

/**
 * The four fields `PUT /api/devices/:deviceId` may change, each applied only
 * when the caller sends it.
 *
 * `preKeys` is the whole bundle or nothing — `undefined` leaves the stored keys
 * alone, an array REPLACES them, and an empty array really does mean "I have
 * none left". That three-way distinction is why this is not a nullable field.
 */
export interface DeviceKeysPatch {
  readonly identityKeyPublic?: string;
  readonly signedPreKey?: SignedPreKey;
  readonly registrationId?: number;
  readonly preKeys?: readonly PreKey[];
}

/**
 * Update a device's keys. `lastSeen` moves on every update, as it did before —
 * the request is itself evidence the device is alive.
 */
export async function updateDeviceKeys(
  db: AlloDatabase,
  userId: string,
  signalDeviceId: number,
  patch: DeviceKeysPatch,
): Promise<DeviceWithPreKeys | null> {
  return db.transaction(async (tx) => {
    const values: {
      identityKeyPublic?: string;
      signedPreKeyId?: number;
      signedPreKeyPublic?: string;
      signedPreKeySignature?: string;
      registrationId?: number;
      lastSeen: Date;
    } = { lastSeen: new Date() };

    if (patch.identityKeyPublic !== undefined) {
      values.identityKeyPublic = patch.identityKeyPublic;
    }
    if (patch.signedPreKey !== undefined) {
      values.signedPreKeyId = patch.signedPreKey.keyId;
      values.signedPreKeyPublic = patch.signedPreKey.publicKey;
      values.signedPreKeySignature = patch.signedPreKey.signature;
    }
    if (patch.registrationId !== undefined) {
      values.registrationId = patch.registrationId;
    }

    const rows = await tx
      .update(devices)
      .set(values)
      .where(and(eq(devices.userId, userId), eq(devices.deviceId, signalDeviceId)))
      .returning(DEVICE_COLUMNS);

    const row = rows[0];
    if (!row) return null;

    if (patch.preKeys !== undefined) {
      await tx.delete(devicePreKeys).where(eq(devicePreKeys.deviceId, row.id));
      if (patch.preKeys.length > 0) {
        await tx.insert(devicePreKeys).values(
          patch.preKeys.map((preKey) => ({
            id: uuidv7(),
            deviceId: row.id,
            keyId: preKey.keyId,
            publicKey: preKey.publicKey,
          })),
        );
      }
    }

    const preKeys = await tx
      .select(PRE_KEY_COLUMNS)
      .from(devicePreKeys)
      .where(eq(devicePreKeys.deviceId, row.id))
      .orderBy(asc(devicePreKeys.keyId));

    return { ...toDeviceRecord(row), preKeys };
  });
}

/**
 * Remove a device. Its one-time pre-keys go with it through
 * `ON DELETE CASCADE`, which is the relationship Mongo's embedded array had by
 * accident and this schema has on purpose.
 */
export async function deleteDevice(
  db: AlloDatabase,
  userId: string,
  signalDeviceId: number,
): Promise<boolean> {
  const rows = await db
    .delete(devices)
    .where(and(eq(devices.userId, userId), eq(devices.deviceId, signalDeviceId)))
    .returning({ id: devices.id });
  return rows.length > 0;
}
