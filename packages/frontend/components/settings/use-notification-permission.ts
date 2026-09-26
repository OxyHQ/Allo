import { announcePushPermissionGranted } from '@/lib/allo/push';
import { hasNotificationPermission, requestNotificationPermissions } from '@/utils/notifications';
import { alert } from '@oxy.so/bloom/surfaces';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function useNotificationPermission() {
  const { t } = useTranslation();
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    void hasNotificationPermission().then((value) => {
      if (mounted) setGranted(value);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const request = useCallback(async () => {
    const allowed = await requestNotificationPermissions();
    setGranted(allowed);
    if (allowed) {
      // The messaging client registers the push token on this signal.
      announcePushPermissionGranted();
    } else {
      alert(t('settings.preferences.notifications'), t('notification.permission.denied'));
    }
  }, [t]);

  return { granted, request: () => void request() };
}
