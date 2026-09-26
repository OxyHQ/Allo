import { useConversationActions, useSyncState } from '@allo/react';
import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { ChatFolderTabs, ChatList, ChatSearchField, ChatSearchResults, NewChatButton, type ChatSummary } from '@oxy.so/bloom/chat-list';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiLogoutBoxRLine } from '@oxy.so/bloom/icons/RiLogoutBoxRLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '@oxy.so/services';
import { usePathname, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';

import { askDeleteConversation } from '@/components/chat/DeleteConversationDialog';
import { HistoryTransferBanner } from '@/components/conversation/HistoryTransferBanner';
import { StoriesStrip } from '@/components/phase2/StoriesStrip';
import { useChatSummaries } from '@/hooks/useChatSummaries';
import { useSplitLayout } from '@/hooks/useSplitLayout';
import { logger } from '@/utils/logger';
import { conversationIdFromPath } from '@/utils/routeUtils';
import { confirm } from '@oxy.so/bloom/surfaces';

/**
 * What the swipe offers, and it is not the same thing in both cases.
 *
 * A GROUP is left: you stop receiving it and the others are told. A DM is
 * DELETED — its history goes from this device and, if you ask, from theirs —
 * because leaving a conversation with one other person is not a thing any
 * messenger offers, and the row used to say "Delete conversation" over a
 * button that said "Leave" and did neither of the two honestly.
 */
const LEAVE = 'leave';
const DELETE = 'delete';

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
  const { leave, clearHistory } = useConversationActions();
  const summaries = useChatSummaries();
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState('all');

  const selectedId = split ? (conversationIdFromPath(pathname) ?? undefined) : undefined;
  const searching = query.trim().length > 0;

  const chats = useMemo<ChatSummary[]>(
    () =>
      summaries
        .filter((chat) => (folder === 'unread' ? (chat.unreadCount ?? 0) > 0 : folder === 'groups' ? chat.kind === 'group' : true))
        .map((chat) => ({
          ...chat,
          swipeActions: {
            right: [
              chat.kind === 'group'
                ? { key: LEAVE, label: t('chat.leave.action'), icon: RiLogoutBoxRLine, tone: 'negative' as const }
                : { key: DELETE, label: t('chat.delete.action'), icon: RiDeleteBinLine, tone: 'negative' as const },
            ],
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

  const confirmDelete = useCallback(
    async (id: string) => {
      const name = summaries.find((chat) => chat.id === id)?.name ?? t('chat.someone');
      const answer = await askDeleteConversation({
        title: t('chat.delete.title'),
        description: t('chat.delete.confirm'),
        // The honest label: it asks their app, which is all an E2EE system can do.
        alsoForThemLabel: t('chat.delete.alsoFor', { name }),
        confirmLabel: t('chat.delete.action'),
        cancelLabel: t('common.cancel'),
      });
      if (!answer.confirmed) return;
      try {
        await clearHistory(id, { forEveryone: answer.forEveryone });
        toast.success(t('chat.delete.done'));
        if (selectedId === id) router.replace('/');
      } catch (error) {
        logger.error('[ConversationList] delete failed', error);
        toast.error(t('chat.delete.failed'));
      }
    },
    [clearHistory, router, selectedId, summaries, t],
  );

  const open = useCallback((id: string) => router.push(`/c/${id}`), [router]);
  const me = user?.id;
  const openStory = useCallback((accountId: string) => router.push(`/updates?story=${accountId}`), [router]);
  const openUpdates = useCallback(() => router.push('/updates'), [router]);

  return (
    <View style={styles.root}>
      <PageHeader title={t('chat.title')} safeArea={!split} leading={<AppShellMenuButton accessibilityLabel={t('navigation.open')} />} />
      <View style={styles.search}>
        <ChatSearchField value={query} onChangeText={setQuery} onClear={() => setQuery('')} placeholder={t('chat.search.placeholder')} />
      </View>
      {folders.length > 0 && (
        <ChatFolderTabs folders={folders} value={folder} onValueChange={setFolder} accessibilityLabel={t('chat.folder.label')} divider />
      )}
      <HistoryTransferBanner />
      {sync === 'offline' && <Text style={[styles.notice, { color: theme.colors.textSecondary }]}>{t('chat.sync.offline')}</Text>}
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
              if (action === DELETE) void confirmDelete(id);
            }}
            labels={{ emptyTitle: t('chat.empty.title'), emptyDescription: t('chat.empty.description') }}
          />
        )}
      </ScrollView>
      <NewChatButton accessibilityLabel={t('chat.new.title')} onPress={() => router.push('/new')} placement="bottom-right" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  search: { paddingHorizontal: 12, paddingBottom: 8 },
  notice: { paddingHorizontal: 16, paddingBottom: 8 },
  content: { paddingBottom: 24 },
});
