import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useConversationActions, useSyncState } from '@allo/react';
import {
  ChatList,
  ChatSearchField,
  ChatSearchResults,
  NewChatButton,
  type ChatSummary,
} from '@oxy.so/bloom/chat-list';
import { ComposerIconButton } from '@oxy.so/bloom/chat-composer';
import { RiDeleteBinLine, RiEditBoxLine, RiSettings3Line } from '@oxy.so/bloom/icons';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';

import { HistoryTransferBanner } from '@/components/conversation/HistoryTransferBanner';
import { useChatSummaries } from '@/hooks/useChatSummaries';
import { useSplitLayout } from '@/hooks/useSplitLayout';
import { confirmDialog } from '@/utils/alerts';
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
  const split = useSplitLayout();
  const theme = useTheme();
  const { t } = useTranslation();
  const sync = useSyncState();
  const { leave } = useConversationActions();
  const summaries = useChatSummaries();
  const [query, setQuery] = useState('');

  const selectedId = split ? (conversationIdFromPath(pathname) ?? undefined) : undefined;
  const searching = query.trim().length > 0;

  const chats = useMemo<ChatSummary[]>(
    () =>
      summaries.map((chat) => ({
        ...chat,
        swipeActions: {
          right: [{ key: LEAVE, label: t('chat.leave.action'), icon: RiDeleteBinLine, tone: 'negative' as const }],
        },
      })),
    [summaries, t],
  );

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
      const ok = await confirmDialog({
        title: t('chat.leave.conversation'),
        message: t('chat.leave.confirm'),
        okText: t('chat.leave.action'),
        cancelText: t('common.cancel'),
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

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <PageHeader
        title={t('chat.title')}
        safeArea={!split}
        border="none"
        actions={
          <ComposerIconButton
            icon={split ? RiEditBoxLine : RiSettings3Line}
            accessibilityLabel={split ? t('chat.new.title') : t('settings.title')}
            onPress={() => router.push(split ? '/new' : '/settings')}
          />
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
      {!split && (
        <NewChatButton
          accessibilityLabel={t('chat.new.title')}
          onPress={() => router.push('/new')}
          placement="bottom-right"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  search: { paddingHorizontal: 12, paddingBottom: 8 },
  notice: { paddingHorizontal: 16, paddingBottom: 8 },
  content: { paddingBottom: 24 },
});
