import { AppShell, AppShellPanel, AppShellPanels } from '@oxy.so/bloom/app-shell';
import { RiChatNewLine } from '@oxy.so/bloom/icons/RiChatNewLine';
import { RiImageAddLine } from '@oxy.so/bloom/icons/RiImageAddLine';
import { RiPhoneLine } from '@oxy.so/bloom/icons/RiPhoneLine';
import { RiSettings3Fill } from '@oxy.so/bloom/icons/RiSettings3Fill';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiUser3Fill } from '@oxy.so/bloom/icons/RiUser3Fill';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { stackSceneLayout } from '@oxy.so/bloom/panel-routing/expo-router';
import { useTabPager } from '@oxy.so/bloom/tab-pager';
import { useTheme } from '@oxy.so/bloom/theme';
import { useOxy } from '@oxy.so/services/ui/client';
import { Slot, Stack, usePathname, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { LogoIcon } from '@/assets/logo';
import { ConversationInfo } from '@/components/chat/info/ConversationInfo';
import { ConversationList } from '@/components/chat/list/ConversationList';
import { AlloNavigation } from '@/components/navigation/AlloNavigation';
import { CallPill } from '@/components/phase2/CallPill';
import { NavigationTheme } from '@/components/providers/NavigationTheme';
import { AlloSettingsProvider } from '@/components/settings/AlloSettingsProvider';
import { useAlloSettings } from '@/components/settings/context';
import { usePostStatus } from '@/hooks/usePostStatus';
import { SPLIT_FROM, useInfoPane, useSplitLayout } from '@/hooks/useSplitLayout';
import { pageActionFor } from '@/lib/navigation/pageAction';
import { profileHref } from '@/lib/profile/handle';
import { useChatPaneStore } from '@/stores/chatPaneStore';
import { conversationIdFromPath } from '@/utils/routeUtils';

/**
 * The signed-in app: Bloom's app shell over Allo's destinations
 * (`AlloNavigation`). On a phone, a stack: the pages (chats, updates, calls)
 * under Bloom's bottom bar, and each screen pushed over them. From `SPLIT_FROM`
 * up, the navigation rail flush against Bloom's `AppShellPanels` layout — list
 * pane, the route as the conversation pane, and a conversation's info beside it
 * once a third column fits.
 */
export default function ChatLayout() {
  return (
    // The pill draws nothing unless a call is minimised, and it lives here so a
    // minimised call survives walking around the app.
    <AlloSettingsProvider>
      <AlloNavigation>
        <View style={styles.app}>
          <SplitShell split={useSplitLayout()} />
          <CallPill />
        </View>
      </AlloNavigation>
    </AlloSettingsProvider>
  );
}

function SplitShell({ split }: { split: boolean }) {
  const settings = useAlloSettings();
  const [listWidth, setListWidth] = useState(360);
  const router = useRouter();
  const pathname = usePathname();
  const theme = useTheme();
  const { t } = useTranslation();
  const { user } = useOxy();
  const { activePage } = useTabPager();
  const infoBeside = useInfoPane();
  const infoOpen = useChatPaneStore((state) => state.infoOpen);
  const closeInfo = useChatPaneStore((state) => state.closeInfo);

  const conversationId = conversationIdFromPath(pathname);

  const ownProfile = profileHref(user?.username);
  // The destination a pushed route belongs to: a conversation is a chat. On a
  // page, Bloom selects the page itself.
  const selected =
    ownProfile && pathname === ownProfile ? 'profile' : conversationId ? 'index' : undefined;

  // The rail's rows are the destinations; its foot carries the person's own
  // profile (an account block belongs to the panel variant) and Settings.
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

  const newChat = useMemo(
    () => ({
      label: t('chat.new.title'),
      icon: RiChatNewLine,
      onPress: () => router.push('/new'),
    }),
    [router, t],
  );
  const postStatus = usePostStatus();
  const action = pageActionFor(activePage);
  const primaryAction = useMemo(() => {
    if (action === 'add-status')
      return {
        icon: RiImageAddLine,
        accessibilityLabel: t('stories.add'),
        onPress: () => void postStatus(),
      };
    if (action === 'new-call')
      return {
        icon: RiPhoneLine,
        accessibilityLabel: t('calls.new.title'),
        // Picks somebody, then pushes `/c/:id/call`, the one dialler.
        onPress: () => router.push('/new?call=voice'),
      };
    return {
      icon: RiChatNewLine,
      accessibilityLabel: t('chat.new.title'),
      onPress: () => router.push('/new'),
    };
  }, [action, postStatus, router, t]);

  return (
    <AppShell
      panels
      variant="dashboard"
      contentMaxWidth="none"
      scroll="fixed"
      header={null}
      navFrom={SPLIT_FROM}
      // The bar's FAB is the action of the page in front (`pageActionFor`).
      primaryAction={primaryAction}
      // The bar belongs to the pages; a conversation or a pushed screen has the
      // whole height (and the composer the bottom edge).
      bottomBar={activePage ? undefined : null}
      // The bar FLOATS over the page. Reserving its height left the pane
      // short of the bottom edge and showed the shell's own background in the
      // gap — a darker band across the whole width under the pill. Every page
      // scrolls in a Bloom scroller (`ScreenScrollView`), which clears the bar
      // by itself (`useBottomEdgeInset`), so the last row still scrolls clear.
      reserveBottomBarSpace={false}
      sidebar={{
        variant: 'rail',
        showSearch: false,
        logo: {
          icon: <LogoIcon size={28} color={theme.colors.primary} />,
          accessibilityLabel: 'Allo',
        },
        secondaryItems,
        selected,
        // The rail's compose row stays "new chat" whatever page is in front:
        // it is the app's action, not a page's.
        primaryAction: newChat,
      }}
    >
      <AppShellPanels appearance="joined">
        {split ? (
          <AppShellPanel
            key="list"
            id="list"
            width={listWidth}
            onWidthChange={setListWidth}
            minWidth={280}
            maxWidth={520}
            resizable
            resizeLabel={t('chat.resize')}
          >
            <ConversationList />
          </AppShellPanel>
        ) : null}
        <AppShellPanel key="detail" id="detail">
          <NavigationTheme transparent>
            {split ? (
              <Slot />
            ) : (
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: 'transparent' },
                }}
                // A covered scene's Screens go inactive (reselect, status bar,
                // floating action and visibility yield to the one on top) and
                // leave the accessibility tree.
                screenLayout={stackSceneLayout}
              />
            )}
          </NavigationTheme>
        </AppShellPanel>
        {conversationId && infoOpen && infoBeside ? (
          <AppShellPanel key="info" id="info" width={320}>
            <ConversationInfo conversationId={conversationId} variant="pane" onClose={closeInfo} />
          </AppShellPanel>
        ) : null}
      </AppShellPanels>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, minHeight: 0 },
});
