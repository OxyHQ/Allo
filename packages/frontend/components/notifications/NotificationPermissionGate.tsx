import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { present, type SurfaceControls } from '@oxy.so/bloom/surfaces';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { announcePushPermissionGranted } from '@/lib/allo/push';
import { INITIALIZATION_TIMEOUT } from '@/lib/constants';
import { hasNotificationPermission, requestNotificationPermissions } from '@/utils/notifications';

import {
  Button as LButton,
  IconCircle as LIconCircle,
  Text,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

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

  return toElement(
    VStack(
      LIconCircle(RiNotification3Line),
      VStack(
        Text(t('permission.notifications.title'))
          .font('title-3')
          .weight('semibold')
          .role('header')
          .textAlign('center'),
        Text(t('permission.notifications.body'))
          .font('body')
          .foreground('muted')
          .textAlign('center'),
      ).spacing('6'),
      VStack(
        LButton(Text(t('permission.notifications.enable')))
          .size('lg')
          .loading(requesting)
          .onPress(() => void enable()),
        LButton(Text(t('permission.notifications.later')))
          .size('lg')
          .onPress(() => surface.dismiss())
          .tint('neutral')
          .style('outline'),
      )
        .alignSelf('stretch')
        .spacing('10'),
    )
      .padding('top', 'sm')
      .padding('bottom', 'xs')
      .align('center')
      .spacing('xl'),
  );
}
