import { Button } from '@oxy.so/bloom/button';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { present, type SurfaceControls } from '@oxy.so/bloom/surfaces';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { announcePushPermissionGranted } from '@/lib/allo/push';
import { INITIALIZATION_TIMEOUT } from '@/lib/constants';
import { hasNotificationPermission, requestNotificationPermissions } from '@/utils/notifications';

/**
 * Asks for notification permission once the app is on screen, if it has not
 * been granted: a Bloom sheet on the app's one surface stack. Native only;
 * mounted by the root layout once the app is ready.
 */
export function NotificationPermissionGate() {
  useEffect(() => {
    let cancelled = false;
    // Held back a moment so the sheet is not the first thing that moves.
    const timeout = setTimeout(async () => {
      const granted = await hasNotificationPermission();
      if (cancelled || granted) return;
      // Bloom's own content padding stays: the drag handle is drawn over the
      // top of the content, and that padding is what keeps the bell clear of it.
      void present((surface) => <NotificationPermissionSheet surface={surface} />, {
        placement: 'bottom',
      });
    }, INITIALIZATION_TIMEOUT.SPLASH_FADE_DELAY);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, []);
  return null;
}

function NotificationPermissionSheet({ surface }: { surface: SurfaceControls }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [requesting, setRequesting] = useState(false);

  const enable = async () => {
    setRequesting(true);
    try {
      // The messaging client registers the push token on this signal; see `lib/allo/push.ts`.
      if (await requestNotificationPermissions()) announcePushPermissionGranted();
    } finally {
      setRequesting(false);
      surface.dismiss();
    }
  };

  return (
    <View style={styles.content}>
      <IconCircle icon={RiNotification3Line} />
      <View style={styles.copy}>
        <Text variant="title-3-semibold" accessibilityRole="header" style={styles.centered}>
          {t('permission.notifications.title')}
        </Text>
        <Text
          variant="body-regular"
          style={[styles.centered, { color: theme.colors.textSecondary }]}
        >
          {t('permission.notifications.body')}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button size="lg" loading={requesting} onPress={() => void enable()}>
          {t('permission.notifications.enable')}
        </Button>
        <Button size="lg" onPress={() => surface.dismiss()} tone="neutral" appearance="outline">
          {t('permission.notifications.later')}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The surface pads the sheet (20 on every side); this adds a little air
  // under the drag handle before the bell.
  content: { alignItems: 'center', gap: 20, paddingTop: 8, paddingBottom: 4 },
  copy: { gap: 6 },
  centered: { textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: 10 },
});
