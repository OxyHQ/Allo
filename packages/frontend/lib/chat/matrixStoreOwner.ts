import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AlloSession } from '@/lib/matrix/types';

/**
 * Who the client's store on disk belongs to.
 *
 * The store holds one identity's synced state and, on native, that identity's
 * encryption keys. Nothing inside it says whose it is in a form the app can read
 * without opening it, and opening it is the thing that has to be decided first —
 * so the answer is kept outside it, here, and written the moment a session takes
 * the store over.
 *
 * ## Why this exists
 *
 * The store's name is fixed. `matrix-js-sdk:allo-matrix` on web and one directory
 * on native, the same strings whichever session is running, because the SDKs need
 * a path before there is a session to name one after: a login has to have
 * somewhere to write the device it is about to mint. A fixed name is safe only if
 * a store never outlives the session it was made for, and *"the launch found no
 * session, so it erased the store"* — which is what `matrixRuntime.ts` used to
 * decide on — is not the same statement. It misses the case that matters:
 *
 * > there IS a session in storage, and the store on disk is not its store.
 *
 * That is what an account switch looks like from here, and it is what let one
 * account's client come up holding the previous account's synced state and its
 * crypto store. Recording the owner turns the question into one the app can
 * actually answer before it opens anything.
 *
 * ## Why AsyncStorage and not the keychain
 *
 * Nothing here is a credential. A Matrix user id and a device id are published
 * by the homeserver to everyone in a room; the session's tokens stay in
 * `matrixSessionStorage.ts` and never come near this. Keeping the marker out of
 * the keychain also fixes something on iOS that the keychain causes: keychain
 * items can survive the app being deleted and reinstalled, while the app's
 * documents directory cannot. A reinstalled Allo would find a valid session for a
 * device whose keys no longer exist anywhere. It now finds a session whose store
 * is not recorded as anyone's, which is a state {@link matrixRuntime} knows what
 * to do with.
 *
 * ## An unrecorded store is nobody's, and is never adopted
 *
 * Every store written before this module existed has no owner. It is not given to
 * whichever identity signs in next — that is precisely the defect — and it is not
 * guessed at from the session that happens to be in storage beside it, because
 * the two being beside each other is exactly what the old code assumed and what
 * was not true. An unowned store is erased, and the session that was sitting next
 * to it goes with it. The cost is one sign-in, once, for anyone already using the
 * Matrix backend.
 */

/**
 * The identity a store belongs to.
 *
 * Three fields and not one: the device id alone repeats across accounts on a
 * homeserver that recycles them, the user id alone does not distinguish this
 * installation's device from the same person's other device, and the homeserver
 * is what makes both of the others mean anything. Comparing all three is the
 * cheapest way to be exactly right.
 */
export interface MatrixStoreOwner {
  /** The Matrix user id the store's session belongs to. */
  readonly userId: string;
  /** The Matrix device the store's keys belong to. */
  readonly deviceId: string;
  /** The homeserver both of the above are names on. */
  readonly homeserverUrl: string;
}

/**
 * Bumped when {@link MatrixStoreOwner} changes shape.
 *
 * A record this build cannot read is treated as no record at all, which erases
 * the store. That is the safe direction and the only one available: a marker
 * that cannot be read cannot prove anything about what is on disk.
 */
export const STORE_OWNER_VERSION = 1;

/** The one key. Namespaced so it cannot collide with anything else on the origin. */
export const STORE_OWNER_KEY = 'allo.matrix.store.owner';

/** The owner a session would be, if it took the store over. */
export function storeOwnerOf(session: AlloSession): MatrixStoreOwner {
  return {
    userId: session.userId,
    deviceId: session.deviceId,
    homeserverUrl: session.homeserverUrl,
  };
}

/**
 * Whether two owners are the same identity.
 *
 * `undefined` is not equal to anything, including itself. An unrecorded store and
 * a launch with no session are both "nobody", and treating those as a match would
 * mean skipping the erase in the one case where there is most likely to be
 * something left over.
 */
export function sameStoreOwner(
  left: MatrixStoreOwner | undefined,
  right: MatrixStoreOwner | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }
  return (
    left.userId === right.userId &&
    left.deviceId === right.deviceId &&
    left.homeserverUrl === right.homeserverUrl
  );
}

export function encodeStoreOwner(owner: MatrixStoreOwner): string {
  return JSON.stringify({ version: STORE_OWNER_VERSION, ...owner });
}

/**
 * Reads back what {@link encodeStoreOwner} wrote.
 *
 * Every failure answers `undefined` rather than throwing, and they all mean the
 * same thing to the caller: this store cannot be proven to belong to anybody, so
 * it belongs to nobody. There is nothing to repair and nothing worth
 * distinguishing — a damaged marker and a missing one lead to the same erase.
 */
export function decodeStoreOwner(raw: string | undefined | null): MatrixStoreOwner | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const fields: Record<string, unknown> = { ...parsed };
  if (fields.version !== STORE_OWNER_VERSION) {
    return undefined;
  }

  const userId = readRequired(fields.userId);
  const deviceId = readRequired(fields.deviceId);
  const homeserverUrl = readRequired(fields.homeserverUrl);
  if (userId === undefined || deviceId === undefined || homeserverUrl === undefined) {
    return undefined;
  }

  return { userId, deviceId, homeserverUrl };
}

/** A non-empty string, or `undefined` if it is anything else. */
function readRequired(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Where the marker is kept between launches.
 *
 * The same three-method shape as {@link
 * import('./matrixSessionStorage').MatrixSessionStorage}, and an interface for
 * the same reason: the runtime takes it as a dependency, so the whole decision
 * about whose store is on disk can be exercised without a device.
 */
export interface MatrixStoreOwnerStorage {
  /** The recorded owner, or `undefined` if the store is nobody's. */
  read(): Promise<MatrixStoreOwner | undefined>;
  /** Records a new owner. Throws if it could not be written. */
  write(owner: MatrixStoreOwner): Promise<void>;
  /** Makes the store nobody's. Removing what is not there is not an error. */
  clear(): Promise<void>;
}

/**
 * AsyncStorage, on every platform.
 *
 * A write that fails is raised rather than swallowed, and the runtime treats it
 * as fatal. The alternative reads worse than it sounds: an unrecorded store is
 * erased on the next launch, so a marker that quietly failed to be written means
 * a device that mints itself again on every launch — the exact failure the
 * session storage exists to prevent, arriving by a different door.
 */
export const matrixStoreOwnerStorage: MatrixStoreOwnerStorage = {
  read: async () => decodeStoreOwner(await AsyncStorage.getItem(STORE_OWNER_KEY)),
  write: (owner) => AsyncStorage.setItem(STORE_OWNER_KEY, encodeStoreOwner(owner)),
  clear: () => AsyncStorage.removeItem(STORE_OWNER_KEY),
};
