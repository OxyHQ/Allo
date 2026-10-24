import { useTotalUnread } from '@allo/react';
import { RiChat3Fill } from '@oxy.so/bloom/icons/RiChat3Fill';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiPhoneFill } from '@oxy.so/bloom/icons/RiPhoneFill';
import { RiPhoneLine } from '@oxy.so/bloom/icons/RiPhoneLine';
import { RiSlideshow3Line } from '@oxy.so/bloom/icons/RiSlideshow3Line';
import type { AppDestination } from '@oxy.so/bloom/tab-pager';
import { TabPagerProvider } from '@oxy.so/bloom/tab-pager/expo-router';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Every place Allo's navigation leads, declared once. Bloom draws the rest from
 * it: the pages (swiped between on a phone), the bottom bar with the unread
 * badge, and the app shell's sidebar rows with their selection.
 *
 * The three pages are the route files in `app/(chat)/(tabs)/`. The person's
 * own profile and Settings are the sidebar's foot items (`app/(chat)/_layout.tsx`),
 * not destinations: neither is a page, and Settings is a dialog.
 */
export function useAlloDestinations(): AppDestination[] {
  const { t } = useTranslation();
  const unread = useTotalUnread();
  return useMemo<AppDestination[]>(
    () => [
      {
        name: 'index',
        href: '/',
        bar: true,
        preload: true,
        label: t('chat.title'),
        icon: RiChat3Line,
        activeIcon: RiChat3Fill,
        badge: unread > 0 ? unread : undefined,
      },
      {
        name: 'updates',
        href: '/updates',
        bar: true,
        preload: true,
        label: t('stories.title'),
        icon: RiSlideshow3Line,
      },
      {
        name: 'calls',
        href: '/calls',
        bar: true,
        preload: true,
        label: t('calls.title'),
        icon: RiPhoneLine,
        activeIcon: RiPhoneFill,
      },
    ],
    [t, unread],
  );
}

/** Bloom's navigation over Allo's destinations; mounted above the app shell. */
export function AlloNavigation({ children }: { children: ReactNode }) {
  return <TabPagerProvider destinations={useAlloDestinations()}>{children}</TabPagerProvider>;
}
