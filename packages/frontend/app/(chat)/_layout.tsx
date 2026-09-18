import React, { useMemo } from 'react';
import { Slot, Stack, usePathname, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { useTotalUnread } from '@allo/react';
import { AppShell } from '@oxy.so/bloom/app-shell';
import { RiChat3Fill, RiChat3Line, RiSettings3Fill, RiSettings3Line } from '@oxy.so/bloom/icons';
import type { SidebarProps } from '@oxy.so/bloom/sidebar';

import { ConversationInfo } from '@/components/chat/info/ConversationInfo';
import { ConversationList } from '@/components/chat/list/ConversationList';
import { SettingsMenu } from '@/components/settings/SettingsMenu';
import { INFO_FROM, SPLIT_FROM, useSplitLayout } from '@/hooks/useSplitLayout';
import { profileHref } from '@/lib/profile/handle';
import { useChatPaneStore } from '@/stores/chatPaneStore';
import { conversationIdFromPath, isSettingsPath } from '@/utils/routeUtils';

/**
 * The signed-in app. On a phone, a stack: the list, and each screen pushed over
 * it. From `SPLIT_FROM` up, Bloom's split shell: the navigation rail, the list
 * pane (conversations, or the settings menu inside settings), the route as the
 * detail pane, and a conversation's info beside it when asked for.
 */
export default function ChatLayout() {
  const split = useSplitLayout();
  return split ? <SplitShell /> : <Stack screenOptions={{ headerShown: false }} />;
}

function SplitShell() {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const { user } = useOxy();
  const unread = useTotalUnread();
  const infoOpen = useChatPaneStore((state) => state.infoOpen);
  const closeInfo = useChatPaneStore((state) => state.closeInfo);

  const inSettings = isSettingsPath(pathname);
  const conversationId = conversationIdFromPath(pathname);

  const sidebar = useMemo<Omit<SidebarProps, 'mobile' | 'onClose'>>(() => {
    const ownProfile = profileHref(user?.username);
    return {
      variant: 'rail',
      surface: 'docked',
      selected: inSettings ? 'settings' : 'chats',
      items: [
        {
          key: 'chats',
          label: t('chat.title'),
          icon: RiChat3Line,
          activeIcon: RiChat3Fill,
          badge: unread > 0 ? unread : undefined,
          onPress: () => router.push('/'),
        },
        {
          key: 'settings',
          label: t('settings.title'),
          icon: RiSettings3Line,
          activeIcon: RiSettings3Fill,
          onPress: () => router.push('/settings'),
        },
      ],
      account: user
        ? {
            name: user.name?.displayName || user.username,
            avatar: { source: user.avatar ?? undefined },
            manageLabel: t('profile.view'),
            onManage: ownProfile ? () => router.push(ownProfile) : undefined,
          }
        : undefined,
    };
  }, [inSettings, router, t, unread, user]);

  return (
    <AppShell
      variant="split"
      scroll="fixed"
      header={null}
      paneScroll={false}
      splitFrom={SPLIT_FROM}
      infoFrom={INFO_FROM}
      sidebar={sidebar}
      list={inSettings ? <SettingsMenu /> : <ConversationList />}
      info={
        conversationId && infoOpen ? (
          <ConversationInfo conversationId={conversationId} variant="pane" onClose={closeInfo} />
        ) : undefined
      }
      pane="detail"
      resizeLabel={t('chat.resize')}
    >
      <Slot />
    </AppShell>
  );
}
