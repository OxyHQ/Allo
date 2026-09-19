import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { useConversationActions, useSyncState } from '@allo/react';
import {
  ChatFolderTabs,
  ChatList,
  ChatSearchField,
  ChatSearchResults,
  NewChatButton,
  type ChatSummary,
} from '@oxy.so/bloom/chat-list';
import { ComposerIconButton } from '@oxy.so/bloom/chat-composer';
import { RiDeleteBinLine, RiPhoneLine, RiSettings3Line, RiSlideshow3Line } from '@oxy.so/bloom/icons';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';

import { HistoryTransferBanner } from '@/components/conversation/HistoryTransferBanner';
import { StoriesStrip } from '@/components/phase2/StoriesStrip';
import { useChatSummaries } from '@/hooks/useChatSummaries';
import { useSplitLayout } from '@/hooks/useSplitLayout';
import { confirm } from '@oxy.so/bloom/surfaces';
import { logger } from '@/utils/logger';
import { conversationIdFromPath } from '@/utils/routeUtils';

const LEAVE = 'leave';

/**
 * Every conversation, newest first — Bloom's `ChatList`, with the search field
 * as its header the way Bloom's own conversations screen composes it. The whole
 * screen on a phone; the list pane beside the open conversation on a wide one.
 */
export function ConversationList() {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useOxy();
  const split = useSplitLayout();
  const theme = useTheme();
  const { t } = useTranslation();
  const sync = useSyncState();
  const { leave } = useConversationActions();
  const summaries = useChatSummaries();
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState('all');

  const selectedId = split ? (conversationIdFromPath(pathname) ?? undefined) : undefined;
  const searching = query.trim().length > 0;

  const chats = useMemo<ChatSummary[]>(
    () =>
      summaries
        .filter((chat) =>
          folder === 'unread' ? (chat.unreadCount ?? 0) > 0 : folder === 'groups' ? chat.kind === 'group' : true,
        )
        .map((chat) => ({
          ...chat,
          swipeActions: {
            right: [{ key: LEAVE, label: t('chat.leave.action'), icon: RiDeleteBinLine, tone: 'negative' as const }],
          },
        })),
    [folder, summaries, t],
  );

  /** Only offered once there is something to filter: two rows need no folders. */
  const folders = useMemo(() => {
    const unread = summaries.reduce((total, chat) => total + ((chat.unreadCount ?? 0) > 0 ? 1 : 0), 0);
    const groups = summaries.filter((chat) => chat.kind === 'group').length;
    if (summaries.length < 5 && unread === 0) return [];
    return [
      { key: 'all', label: t('chat.folder.all') },
      { key: 'unread', label: t('chat.folder.unread'), unreadCount: unread || undefined },
      ...(groups > 0 ? [{ key: 'groups', label: t('chat.folder.groups') }] : []),
    ];
  }, [summaries, t]);

  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    return summaries
      .filter((chat) => chat.name.toLocaleLowerCase().includes(needle))
      .map((chat) => ({
        id: chat.id,
        kind: 'chat' as const,
        name: chat.name,
        avatar: chat.avatar,
        faces: chat.faces,
        chatKind: chat.kind,
        detail: chat.preview?.text ?? chat.preview?.attachment?.label,
        time: chat.time,
      }));
  }, [query, summaries]);

  const confirmLeave = useCallback(
    async (id: string) => {
      const ok = await confirm({
        title: t('chat.leave.conversation'),
        description: t('chat.leave.confirm'),
        confirmLabel: t('chat.leave.action'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await leave(id);
        toast.success(t('chat.leave.done'));
        if (selectedId === id) router.replace('/');
      } catch (error) {
        logger.error('[ConversationList] leave failed', error);
        toast.error(t('chat.leave.failed'));
      }
    },
    [leave, router, selectedId, t],
  );

  const open = useCallback((id: string) => router.push(`/c/${id}`), [router]);
  const me = user?.id;
  const openStory = useCallback((accountId: string) => router.push(`/updates?story=${accountId}`), [router]);
  const openUpdates = useCallback(() => router.push('/updates'), [router]);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <PageHeader
        title={t('chat.title')}
        safeArea={!split}
        actions={
          // The rail carries these on a wide window; a phone has no rail, so the
          // header does. Starting a conversation is the FAB below, which is where
          // Bloom's own conversations screen puts it.
          split ? undefined : (
            <View style={styles.actions}>
              <ComposerIconButton
                icon={RiPhoneLine}
                accessibilityLabel={t('calls.title')}
                onPress={() => router.push('/calls')}
              />
              <ComposerIconButton
                icon={RiSlideshow3Line}
                accessibilityLabel={t('stories.title')}
                onPress={openUpdates}
              />
              <ComposerIconButton
                icon={RiSettings3Line}
                accessibilityLabel={t('settings.title')}
                onPress={() => router.push('/settings')}
              />
            </View>
          )
        }
      />
      <View style={styles.search}>
        <ChatSearchField
          value={query}
          onChangeText={setQuery}
          onClear={() => setQuery('')}
          placeholder={t('chat.search.placeholder')}
        />
      </View>
      {folders.length > 0 && (
        <ChatFolderTabs
          folders={folders}
          value={folder}
          onValueChange={setFolder}
          accessibilityLabel={t('chat.folder.label')}
          divider
        />
      )}
      <HistoryTransferBanner />
      {sync === 'offline' && (
        <Text style={[styles.notice, { color: theme.colors.textSecondary }]}>{t('chat.sync.offline')}</Text>
      )}
      <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {searching ? (
          <ChatSearchResults
            query={query}
            results={results}
            onResultPress={open}
            labels={{ chat: t('chat.title'), empty: t('chat.search.empty') }}
          />
        ) : (
          <ChatList
            chats={chats}
            // Where Bloom's own list puts the stories row.
            header={<StoriesStrip ownAccountId={me} onStoryPress={openStory} onOwnPress={openUpdates} />}
            selectedId={selectedId}
            loading={summaries.length === 0 && sync === 'syncing'}
            onChatPress={open}
            onChatAction={(action, id) => {
              if (action === LEAVE) void confirmLeave(id);
            }}
            labels={{ emptyTitle: t('chat.empty.title'), emptyDescription: t('chat.empty.description') }}
          />
        )}
      </ScrollView>
      <NewChatButton
        accessibilityLabel={t('chat.new.title')}
        onPress={() => router.push('/new')}
        placement="bottom-right"
        // The brand's own accent: Bloom's Fab defaults to the tertiary one,
        // which under a green preset is a magenta nobody asked for.
        variant="primary"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  search: { paddingHorizontal: 12, paddingBottom: 8 },
  actions: { flexDirection: 'row', alignItems: 'center' },
  notice: { paddingHorizontal: 16, paddingBottom: 8 },
  content: { paddingBottom: 24 },
});
