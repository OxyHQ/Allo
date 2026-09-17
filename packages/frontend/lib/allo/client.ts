/**
 * THE ONE PLACE THE APP CONSTRUCTS AN `AlloClient`.
 *
 * Everything platform-specific the SDK needs is assembled here and nowhere
 * else: which storage (SQLite on a phone, IndexedDB in a browser), which
 * secret store (Keychain/Keystore, or IndexedDB with its documented caveat),
 * how the Oxy session is read, and how a person is named. A screen never
 * imports `@allo/core` for a value; it reaches the client through
 * `@allo/react`'s provider, which `AlloRoot` mounts with what this returns.
 *
 * One client per signed-in account. `AlloRoot` builds a new one when the
 * account changes; the per-account namespace is inside core, so two accounts
 * on one device never see each other's rows.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { createAlloClient, type AlloClient } from '@allo/core';
import type { Platform as AlloPlatform } from '@allo/shared-types';
import { ALLO_PLATFORM_URL } from '@/config';
import { logger } from '@/utils/logger';
import { people } from './people';
import { createSecrets } from './secrets';
import { createSessionAdapter, type OxySessionSource } from './session';
import { createStorage } from './storage';

export const APP_ID = 'allo';

/** `Platform.OS` in the SDK's vocabulary. Anything else React Native might report is `web`'s cousin, `desktop`. */
export function alloPlatform(os: string = Platform.OS): AlloPlatform {
  switch (os) {
    case 'ios':
      return 'ios';
    case 'android':
      return 'android';
    case 'web':
      return 'web';
    default:
      return 'desktop';
  }
}

/**
 * What this installation is called in the devices list.
 *
 * The device's own name where the platform reports one ("Nate's iPhone"), and
 * the platform otherwise: a browser has no name, and "Web" is what a person
 * approving it from their phone expects to read.
 */
export function deviceDisplayName(os: string = Platform.OS, deviceName: string | null | undefined = Constants.deviceName): string {
  const trimmed = deviceName?.trim();
  if (trimmed) return trimmed;
  switch (os) {
    case 'ios':
      return 'iPhone';
    case 'android':
      return 'Android';
    case 'web':
      return 'Web';
    default:
      return os;
  }
}

export interface AppAlloClientOptions {
  /** The `OxyServices` instance `useOxy()` provides: the session authority. */
  oxy: OxySessionSource;
}

export async function createAppAlloClient({ oxy }: AppAlloClientOptions): Promise<AlloClient> {
  const storage = await createStorage();
  return createAlloClient({
    baseUrl: ALLO_PLATFORM_URL,
    appId: APP_ID,
    platform: alloPlatform(),
    displayName: deviceDisplayName(),
    session: createSessionAdapter(oxy),
    storage,
    secrets: createSecrets(),
    people,
    logger: {
      debug: (message, fields) => logger.debug(`[allo] ${message}`, fields),
      info: (message, fields) => logger.info(`[allo] ${message}`, fields),
      warn: (message, fields) => logger.warn(`[allo] ${message}`, fields),
      error: (message, fields) => logger.error(`[allo] ${message}`, fields),
    },
  });
}
