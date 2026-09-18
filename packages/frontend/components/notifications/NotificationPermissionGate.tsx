import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { BottomSheet, type BottomSheetRef } from '@oxy.so/bloom/bottom-sheet';
import { Button } from '@oxy.so/bloom/button';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { RiNotification3Line } from '@oxy.so/bloom/icons';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';

import { announcePushPermissionGranted } from '@/lib/allo/push';
import { INITIALIZATION_TIMEOUT } from '@/lib/constants';
import { hasNotificationPermission, requestNotificationPermissions } from '@/utils/notifications';

/**
 * Asks for notification permission once the app is on screen, if it has not
 * been granted. Native only; mounted by the root layout once the app is ready.
 */
export function NotificationPermissionGate() {
  const { t } = useTranslation();
  const theme = useTheme();
  const sheet = useRef<BottomSheetRef>(null);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Held back past the splash fade so the sheet is not the first thing that moves.
    const timeout = setTimeout(async () => {
      const granted = await hasNotificationPermission();
      if (!cancelled && !granted) sheet.current?.present();
    }, INITIALIZATION_TIMEOUT.SPLASH_FADE_DELAY);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, []);

  const enable = async () => {
    setRequesting(true);
    try {
      // The messaging client registers the push token on this signal; see `lib/allo/push.ts`.
      if (await requestNotificationPermissions()) announcePushPermissionGranted();
    } finally {
      setRequesting(false);
      sheet.current?.dismiss();
    }
  };

  return (
    <BottomSheet ref={sheet}>
      <View style={styles.content}>
        <IconCircle icon={RiNotification3Line} />
        <View style={styles.copy}>
          <Text variant="title-3-semibold" accessibilityRole="header" style={styles.centered}>
            {t('permission.notifications.title')}
          </Text>
          <Text variant="body-regular" style={[styles.centered, { color: theme.colors.textSecondary }]}>
            {t('permission.notifications.body')}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button size="large" loading={requesting} onPress={() => void enable()}>
            {t('permission.notifications.enable')}
          </Button>
          <Button size="large" variant="secondary" onPress={() => sheet.current?.dismiss()}>
            {t('permission.notifications.later')}
          </Button>
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: { alignItems: 'center', gap: 20, paddingHorizontal: 24, paddingTop: 8, paddingBottom: 24 },
  copy: { gap: 6 },
  centered: { textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: 10 },
});
