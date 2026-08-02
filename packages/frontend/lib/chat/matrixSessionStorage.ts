import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { MatrixStoreUnavailableError } from '@/lib/matrix/errors';

/**
 * Where the Matrix session is kept between launches.
 *
 * One value, one key, and a deliberately small interface: what is stored here is
 * a set of credentials, and the fewer things that can be done to it the fewer
 * ways it can leak. Reading and writing are the app's; interpreting the string is
 * `matrixSession.ts`'s.
 *
 * `lib/secureStorage.ts` is not reused, and the reason is its fallback: it
 * answers a SecureStore that refuses a write by writing to AsyncStorage instead,
 * which on a phone means moving an access token out of the keychain and into
 * plain application storage without telling anyone. That trade is right for the
 * things it holds and wrong for this one, so a failure here is a failure.
 */

/**
 * The one key. Only characters SecureStore accepts on both platforms: letters,
 * digits, `.`, `-` and `_`.
 */
export const SESSION_KEY = 'allo.matrix.session';

/**
 * Keychain entries stay on the phone they were made on.
 *
 * `THIS_DEVICE_ONLY` is not caution for its own sake. A session is half of an
 * installation's identity and the crypto store on disk is the other half; an
 * encrypted iCloud backup restored onto a new phone would carry the session
 * across and leave the keys behind, and the new phone would come up holding a
 * device id whose encryption keys do not exist. `AFTER_FIRST_UNLOCK`, rather
 * than `WHEN_UNLOCKED`, so that a launch into the background — a notification, a
 * scheduled sync — can still restore the session on a locked phone.
 */
const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * The session's home, as little of it as the runtime needs.
 *
 * An interface rather than three functions because the runtime takes it as a
 * dependency: the whole state machine around persisting and restoring sessions is
 * then exercisable without a keychain, a browser, or either platform.
 */
export interface MatrixSessionStorage {
  /** The stored session, or `undefined` if nothing has been stored. */
  read(): Promise<string | undefined>;
  /** Replaces the stored session. Throws if it could not be written. */
  write(value: string): Promise<void>;
  /** Removes it. Removing what is not there is not an error. */
  clear(): Promise<void>;
}

/**
 * The keychain, on iOS and Android.
 *
 * SecureStore's documented guidance is that values over 2048 bytes may fail on
 * Android. A Matrix session is four short strings and the SDK's OIDC data, which
 * is well inside that — but "well inside" is not "guaranteed", so a write that
 * fails is raised rather than swallowed. The caller's answer is to tell the user
 * their session will not survive the app closing, which is true and actionable;
 * a swallowed failure would instead show up a day later as a device that appeared
 * from nowhere.
 */
const keychainStorage: MatrixSessionStorage = {
  read: async () => (await SecureStore.getItemAsync(SESSION_KEY, KEYCHAIN_OPTIONS)) ?? undefined,
  write: (value) => SecureStore.setItemAsync(SESSION_KEY, value, KEYCHAIN_OPTIONS),
  clear: () => SecureStore.deleteItemAsync(SESSION_KEY, KEYCHAIN_OPTIONS),
};

/**
 * `localStorage`, on web.
 *
 * There is no keychain in a browser and nothing that behaves like one: anything
 * the page can read, script running on the page can read. `localStorage` is what
 * the session lives in, and the protection it has is the origin — the same
 * protection the crypto store in IndexedDB already relies on, so this adds no
 * exposure that Allo on web did not already have.
 *
 * A browser with no `localStorage` is refused at the first read rather than
 * worked around. The alternative is an app that signs the user in on every
 * launch and mints a Matrix device each time, which is the failure this whole
 * change exists to remove — and it is the same answer the port already gives for
 * a browser with no IndexedDB, for the same reason.
 */
const browserStorage: MatrixSessionStorage = {
  read: async () => requireLocalStorage('read').getItem(SESSION_KEY) ?? undefined,
  write: async (value) => {
    requireLocalStorage('write').setItem(SESSION_KEY, value);
  },
  clear: async () => {
    requireLocalStorage('clear').removeItem(SESSION_KEY);
  },
};

function requireLocalStorage(operation: string): Storage {
  const storage: Storage | undefined = globalThis.localStorage;
  if (storage === undefined) {
    throw new MatrixStoreUnavailableError(
      `it cannot ${operation} the session because this browser exposes no ` +
        'localStorage. Private browsing modes and some embedded webviews ' +
        'refuse it.',
    );
  }
  return storage;
}

/** The session storage for the platform this build runs on. */
export const matrixSessionStorage: MatrixSessionStorage =
  Platform.OS === 'web' ? browserStorage : keychainStorage;
