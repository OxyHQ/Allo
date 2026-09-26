import { useTotalUnread } from '@allo/react';
import { AppShell } from '@oxy.so/bloom/app-shell';
import { RiChat3Fill } from '@oxy.so/bloom/icons/RiChat3Fill';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiPhoneFill } from '@oxy.so/bloom/icons/RiPhoneFill';
import { RiPhoneLine } from '@oxy.so/bloom/icons/RiPhoneLine';
import { RiSettings3Fill } from '@oxy.so/bloom/icons/RiSettings3Fill';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiSlideshow3Line } from '@oxy.so/bloom/icons/RiSlideshow3Line';
import { RiUser3Fill } from '@oxy.so/bloom/icons/RiUser3Fill';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { useOxy } from '@oxy.so/services';
import { Slot, Stack, usePathname, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { NavigationTheme } from '@/components/providers/NavigationTheme';
import { LogoIcon } from '@/assets/logo';
import { ConversationInfo } from '@/components/chat/info/ConversationInfo';
import { ConversationList } from '@/components/chat/list/ConversationList';
import { CallPill } from '@/components/phase2/CallPill';
import { AlloSettingsProvider } from '@/components/settings/AlloSettingsProvider';
import { useAlloSettings } from '@/components/settings/context';
import { SPLIT_FROM, useInfoPane, useSplitLayout } from '@/hooks/useSplitLayout';
import { profileHref } from '@/lib/profile/handle';
import { useChatPaneStore } from '@/stores/chatPaneStore';
import { conversationIdFromPath } from '@/utils/routeUtils';

/**
 * The signed-in app. On a phone, a stack: the list, and each screen pushed over
 * it. From `SPLIT_FROM` up, the navigation rail flush against Bloom's
 * `AppShell` split layout — list pane, the route as the conversation pane, and a
 * conversation's info beside it once a third column fits.
 */
export default function ChatLayout() {
  const split = useSplitLayout();
  return (
    // The pill draws nothing unless a call is minimised, and it lives here so a
    // minimised call survives walking around the app.
    <AlloSettingsProvider>
      <View style={styles.app}>
        <SplitShell split={split} />
        <CallPill />
      </View>
    </AlloSettingsProvider>
  );
}

function SplitShell({ split }: { split: boolean }) {
  const settings = useAlloSettings();
  const router = useRouter();
  const pathname = usePathname();
  const theme = useTheme();
  const { t } = useTranslation();
  const { user } = useOxy();
  const unread = useTotalUnread();
  const infoBeside = useInfoPane();
  const infoOpen = useChatPaneStore((state) => state.infoOpen);
  const closeInfo = useChatPaneStore((state) => state.closeInfo);

  const conversationId = conversationIdFromPath(pathname);

  const ownProfile = profileHref(user?.username);
  const onProfile = Boolean(ownProfile) && pathname === ownProfile;
  const selected = onProfile ? 'profile' : pathname.startsWith('/calls') ? 'calls' : pathname.startsWith('/updates') ? 'updates' : 'chats';

  // The rail carries navigation only (an account block belongs to the panel
  // variant), so the person's own profile is a foot item rather than a card.
  const items = useMemo(
    () => [
      {
        key: 'chats',
        label: t('chat.title'),
        icon: RiChat3Line,
        activeIcon: RiChat3Fill,
        badge: unread > 0 ? unread : undefined,
        onPress: () => router.push('/'),
      },
      {
        key: 'calls',
        label: t('calls.title'),
        icon: RiPhoneLine,
        activeIcon: RiPhoneFill,
        onPress: () => router.push('/calls'),
      },
      {
        key: 'updates',
        label: t('stories.title'),
        icon: RiSlideshow3Line,
        onPress: () => router.push('/updates'),
      },
    ],
    [router, t, unread],
  );

  const secondaryItems = useMemo(
    () => [
      ...(ownProfile
        ? [
            {
              key: 'profile',
              label: t('profile.view'),
              icon: RiUserLine,
              activeIcon: RiUser3Fill,
              onPress: () => router.push(ownProfile),
            },
          ]
        : []),
      {
        key: 'settings',
        label: t('settings.title'),
        icon: RiSettings3Line,
        activeIcon: RiSettings3Fill,
        onPress: () => settings.open(),
      },
    ],
    [ownProfile, router, settings, t],
  );

  return (
    <AppShell
      variant="split"
      scroll="fixed"
      header={null}
      navFrom={SPLIT_FROM}
      splitFrom={SPLIT_FROM}
      infoFrom={1100}
      paneScroll={false}
      sidebar={{
        variant: 'rail',
        showSearch: false,
        logo: {
          icon: <LogoIcon size={28} color={theme.colors.primary} />,
          accessibilityLabel: 'Allo',
        },
        items,
        secondaryItems,
        selected,
      }}
      pane="detail"
      list={split ? <ConversationList /> : undefined}
      info={
        conversationId && infoOpen && infoBeside ? (
          <ConversationInfo conversationId={conversationId} variant="pane" onClose={closeInfo} />
        ) : undefined
      }
      resizeLabel={t('chat.resize')}
    >
      <NavigationTheme transparent>
        {split ? (
          <Slot />
        ) : (
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: 'transparent' },
            }}
          />
        )}
      </NavigationTheme>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, minHeight: 0 },
});
