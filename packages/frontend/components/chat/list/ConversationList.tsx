import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { FlashList, type ListRenderItem } from '@shopify/flash-list';
import { useConversationActions, useSyncState } from '@allo/react';
import {
  ChatListItem,
  ChatListItemSkeleton,
  ChatSearchField,
  NewChatButton,
  type ChatSummary,
} from '@oxy.so/bloom/chat-list';
import { ChatEmptyState } from '@oxy.so/bloom/chat-screen';
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
 * Every conversation, newest first. The whole screen on a phone; the list pane
 * beside the open conversation on a wide layout.
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

  const selectedId = split ? conversationIdFromPath(pathname) : null;

  const leaveAction = useMemo(
    () => ({ right: [{ key: LEAVE, label: t('chat.leave.action'), icon: RiDeleteBinLine, tone: 'negative' as const }] }),
    [t],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matching = needle ? summaries.filter((chat) => chat.name.toLocaleLowerCase().includes(needle)) : summaries;
    return matching.map((chat) => ({ ...chat, swipeActions: leaveAction }));
  }, [summaries, query, leaveAction]);

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

  const renderItem = useCallback<ListRenderItem<ChatSummary>>(
    ({ item }) => {
      const { id, ...row } = item;
      return (
        <ChatListItem
          {...row}
          selected={id === selectedId}
          onPress={() => router.push(`/c/${id}`)}
          onAction={(key) => {
            if (key === LEAVE) void confirmLeave(id);
          }}
        />
      );
    },
    [confirmLeave, router, selectedId],
  );

  const loading = summaries.length === 0 && sync === 'syncing';

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <PageHeader
        title={t('chat.title')}
        safeArea={!split}
        border="none"
        actions={
          <View style={styles.actions}>
            {!split && (
              <ComposerIconButton
                icon={RiSettings3Line}
                accessibilityLabel={t('settings.title')}
                onPress={() => router.push('/settings')}
              />
            )}
            {split && (
              <ComposerIconButton
                icon={RiEditBoxLine}
                accessibilityLabel={t('chat.new.title')}
                onPress={() => router.push('/new')}
              />
            )}
          </View>
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
      {loading ? (
        <ChatListItemSkeleton count={8} />
      ) : (
        <FlashList
          data={rows}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          extraData={selectedId}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <ChatEmptyState
              title={query ? t('chat.search.empty') : t('chat.empty.title')}
              description={query ? undefined : t('chat.empty.description')}
            />
          }
        />
      )}
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
  actions: { flexDirection: 'row', gap: 4 },
  search: { paddingHorizontal: 12, paddingBottom: 8 },
  notice: { paddingHorizontal: 16, paddingBottom: 8 },
});
