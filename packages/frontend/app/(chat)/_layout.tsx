import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Slot, Stack, usePathname, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { useTotalUnread } from '@allo/react';
import { ChatSplitLayout } from '@oxy.so/bloom/chat-screen';
import { RiChat3Fill, RiChat3Line, RiSettings3Fill, RiSettings3Line, RiUser3Fill, RiUserLine } from '@oxy.so/bloom/icons';
import { Sidebar } from '@oxy.so/bloom/sidebar';
import { useTheme } from '@oxy.so/bloom/theme';

import { LogoIcon } from '@/assets/logo';
import { ConversationInfo } from '@/components/chat/info/ConversationInfo';
import { ConversationList } from '@/components/chat/list/ConversationList';
import { SettingsMenu } from '@/components/settings/SettingsMenu';
import { SPLIT_FROM, useInfoPane, useSplitLayout } from '@/hooks/useSplitLayout';
import { profileHref } from '@/lib/profile/handle';
import { useChatPaneStore } from '@/stores/chatPaneStore';
import { conversationIdFromPath, isSettingsPath } from '@/utils/routeUtils';

/**
 * The signed-in app. On a phone, a stack: the list, and each screen pushed over
 * it. From `SPLIT_FROM` up, the navigation rail flush against Bloom's
 * `ChatSplitLayout` — list pane, the route as the conversation pane, and a
 * conversation's info beside it once a third column fits.
 */
export default function ChatLayout() {
  const split = useSplitLayout();
  return split ? <SplitShell /> : <Stack screenOptions={{ headerShown: false }} />;
}

function SplitShell() {
  const router = useRouter();
  const pathname = usePathname();
  const theme = useTheme();
  const { t } = useTranslation();
  const { user } = useOxy();
  const unread = useTotalUnread();
  const infoBeside = useInfoPane();
  const infoOpen = useChatPaneStore((state) => state.infoOpen);
  const closeInfo = useChatPaneStore((state) => state.closeInfo);

  const inSettings = isSettingsPath(pathname);
  const conversationId = conversationIdFromPath(pathname);

  const ownProfile = profileHref(user?.username);
  const onProfile = Boolean(ownProfile) && pathname === ownProfile;

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
    ],
    [router, t, unread],
  );

  const secondaryItems = useMemo(
    () => [
      ...(ownProfile
        ? [{ key: 'profile', label: t('profile.view'), icon: RiUserLine, activeIcon: RiUser3Fill, onPress: () => router.push(ownProfile) }]
        : []),
      {
        key: 'settings',
        label: t('settings.title'),
        icon: RiSettings3Line,
        activeIcon: RiSettings3Fill,
        onPress: () => router.push('/settings'),
      },
    ],
    [ownProfile, router, t],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <Sidebar
        variant="rail"
        logo={{ icon: <LogoIcon size={28} color={theme.colors.primary} />, accessibilityLabel: 'Allo' }}
        items={items}
        secondaryItems={secondaryItems}
        selected={inSettings ? 'settings' : onProfile ? 'profile' : 'chats'}
        style={{ borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.colors.border }}
      />
      <ChatSplitLayout
        style={styles.root}
        breakpoint={SPLIT_FROM}
        list={inSettings ? <SettingsMenu /> : <ConversationList />}
        info={
          conversationId && infoOpen && infoBeside ? (
            <ConversationInfo conversationId={conversationId} variant="pane" onClose={closeInfo} />
          ) : undefined
        }
        resizeLabel={t('chat.resize')}
      >
        <Slot />
      </ChatSplitLayout>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, flexDirection: 'row' },
});
