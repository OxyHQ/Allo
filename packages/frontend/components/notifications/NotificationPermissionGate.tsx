/**
 * NotificationPermissionGate Component
 * Extracted from _layout.tsx for better organization
 */

import React, { useContext, useEffect } from 'react';
import { Platform } from 'react-native';

import { BottomSheetContext } from '@/context/BottomSheetContext';
import { matrixRuntime } from '@/lib/chat/matrixRuntime';
import { NotificationPermissionSheet } from '@/components/notifications/NotificationPermissionSheet';
import {
  hasNotificationPermission,
  requestNotificationPermissions,
} from '@/utils/notifications';
import { INITIALIZATION_TIMEOUT } from '@/lib/constants';

interface NotificationPermissionGateProps {
  appIsReady: boolean;
  initializationComplete: boolean;
}

/**
 * Shows notification permission prompt when needed (native only)
 */
export function NotificationPermissionGate({
  appIsReady,
  initializationComplete,
}: NotificationPermissionGateProps) {
  const bs = useContext(BottomSheetContext);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    let didCancel = false;

    const run = async () => {
      if (!appIsReady || !initializationComplete) {
        return;
      }

      const hasPerm = await hasNotificationPermission();
      if (didCancel || hasPerm) {
        return;
      }

      bs.setBottomSheetContent(
        <NotificationPermissionSheet
          onLater={() => bs.openBottomSheet(false)}
          onEnable={async () => {
            const granted = await requestNotificationPermissions();
            bs.openBottomSheet(false);
            if (granted) {
              // Permission is only half of it. What actually makes the phone ring
              // is a pusher on the homeserver, and this is the moment the user
              // asked for one — see `lib/chat/pushRegistration.ts`. A no-op until
              // there is a signed-in Matrix session, which is why it is safe to
              // call here without knowing whether there is.
              await matrixRuntime.syncPushRegistration();
            }
          }}
        />
      );
      bs.openBottomSheet(true);
    };

    const timeout = setTimeout(run, INITIALIZATION_TIMEOUT.SPLASH_FADE_DELAY);

    return () => {
      didCancel = true;
      clearTimeout(timeout);
    };
  }, [bs, appIsReady, initializationComplete]);

  return null;
}

