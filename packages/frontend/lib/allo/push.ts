/**
 * PUSH, on the platform path: the device token goes to the SDK, which hands it
 * to the backend as this instance's pusher. Nothing about the token is stored
 * in the app.
 *
 * Two moments matter. On start, if permission is already granted, the token
 * is registered (a reinstall or a token rotation is picked up here). When the
 * permission sheet is accepted, `NotificationPermissionGate` calls
 * `announcePushPermissionGranted()` and whichever `AlloRoot` is mounted
 * registers then. On sign-out `clearPushToken` removes it, so a phone that
 * signs out stops ringing.
 *
 * Where a token cannot be had — the web, a simulator, an Expo Go client — this
 * does nothing and says nothing: there is no pusher to register and no error
 * a user could act on.
 */
import { Platform } from 'react-native';
import type { AlloClient } from '@allo/core';
import { getDevicePushToken, hasNotificationPermission } from '@/utils/notifications';
import { logger } from '@/utils/logger';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Called by the permission gate once the OS said yes. */
export function announcePushPermissionGranted(): void {
  for (const listener of [...listeners]) listener();
}

/** Subscribes to {@link announcePushPermissionGranted}. Returns the unsubscribe. */
export function onPushPermissionGranted(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Registers this device's token with the SDK when permission allows it. Resolves `true` when a token was sent. */
export async function registerPushToken(client: AlloClient): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    if (!(await hasNotificationPermission())) return false;
    const device = await getDevicePushToken();
    if (!device || device.type === 'unknown') return false;
    await client.instance.setPushToken(device.type, device.token);
    return true;
  } catch (error) {
    logger.warn('[allo] push token could not be registered', error);
    return false;
  }
}

/** Removes this device's pusher, best effort. */
export async function clearPushToken(client: AlloClient): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await client.instance.clearPushToken();
  } catch (error) {
    logger.warn('[allo] push token could not be cleared', error);
  }
}
