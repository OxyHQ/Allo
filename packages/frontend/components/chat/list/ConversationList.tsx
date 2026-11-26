import { useMessagingSupervision } from '@/lib/allo/MessagingSupervision';
import { useAlloClient, useConversationActions, useSyncState } from '@allo/react';
import { GemieAskProvider, useAskGemie } from '@gemies/sdk/ask';
import { GemieAvatarIcon } from '@gemies/sdk/avatar';
import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import type { ChatSummary } from '@oxy.so/bloom/chat-list';
import { ListSelectionBar } from '@oxy.so/bloom/list';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiLogoutBoxRLine } from '@oxy.so/bloom/icons/RiLogoutBoxRLine';
import { Screen } from '@oxy.so/bloom/screen';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services/ui/client';
import { usePathname, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { askDeleteConversation } from '@/components/chat/DeleteConversationDialog';
import { HistoryTransferBanner } from '@/components/conversation/HistoryTransferBanner';
import { StoriesStrip } from '@/components/phase2/StoriesStrip';
import { useChatSummaries } from '@/hooks/useChatSummaries';
import { useSplitLayout } from '@/hooks/useSplitLayout';
import { logger } from '@/utils/logger';
import { conversationIdFromPath } from '@/utils/routeUtils';
import { confirm } from '@oxy.so/bloom/surfaces';

import {
  Button as LButton,
  ChatEmptyState as LChatEmptyState,
  ChatFolderTabs as LChatFolderTabs,
  ChatSearchField as LChatSearchField,
  ChatSearchResults as LChatSearchResults,
  Embed,
  Header,
  Icon,
  List as LList,
  ScrollView,
  Text as LText,
  VStack,
  toElement,
  view,
} from '@oxy.so/bloom-language';

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
 * Every conversation, newest first — Bloom's `List`, with the search field
 * as its header the way Bloom's own conversations screen composes it. The whole
 * screen on a phone; the list pane beside the open conversation on a wide one.
 */
export function ConversationList() {
  const supervised = useMessagingSupervision();
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useOxy();
  const split = useSplitLayout();
  const { t } = useTranslation();
  const sync = useSyncState();
  const client = useAlloClient();
  const { leave, clearHistory } = useConversationActions();
  const summaries = useChatSummaries();
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState('all');
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());

  const selectedId = split ? (conversationIdFromPath(pathname) ?? undefined) : undefined;
  const searching = query.trim().length > 0;

  const chats = useMemo<ChatSummary[]>(
    () =>
      summaries
        .filter((chat) =>
          folder === 'unread'
            ? (chat.unreadCount ?? 0) > 0
            : folder === 'groups'
              ? chat.kind === 'group'
              : true,
        )
        .map((chat) => ({
          ...chat,
          swipeActions: {
            right: [
              chat.kind === 'group'
                ? {
                    key: LEAVE,
                    label: t('chat.leave.action'),
                    icon: RiLogoutBoxRLine,
                    tone: 'negative' as const,
                  }
                : {
                    key: DELETE,
                    label: t('chat.delete.action'),
                    icon: RiDeleteBinLine,
                    tone: 'negative' as const,
                  },
            ],
          },
        })),
    [folder, summaries, t],
  );

  const checkedChats = chats.filter((chat) => checkedIds.has(chat.id));
  const singleChecked = checkedChats.length === 1 ? checkedChats[0] : undefined;
  const setChecked = useCallback((id: string, checked: boolean) => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const unread = useMemo(
    () => summaries.reduce((total, chat) => total + ((chat.unreadCount ?? 0) > 0 ? 1 : 0), 0),
    [summaries],
  );

  /** Only offered once there is something to filter: two rows need no folders. */
  const folders = useMemo(() => {
    const groups = summaries.filter((chat) => chat.kind === 'group').length;
    if (summaries.length < 5 && unread === 0) return [];
    return [
      { key: 'all', label: t('chat.folder.all') },
      { key: 'unread', label: t('chat.folder.unread'), unreadCount: unread || undefined },
      ...(groups > 0 ? [{ key: 'groups', label: t('chat.folder.groups') }] : []),
    ];
  }, [summaries, t, unread]);

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
        setChecked(id, false);
        toast.success(t('chat.leave.done'));
        if (selectedId === id) router.replace('/');
      } catch (error) {
        logger.error('[ConversationList] leave failed', error);
        toast.error(t('chat.leave.failed'));
      }
    },
    [leave, router, selectedId, setChecked, t],
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
        setChecked(id, false);
        toast.success(t('chat.delete.done'));
        if (selectedId === id) router.replace('/');
      } catch (error) {
        logger.error('[ConversationList] delete failed', error);
        toast.error(t('chat.delete.failed'));
      }
    },
    [clearHistory, router, selectedId, setChecked, summaries, t],
  );

  const aliaWelcomeSuggestions = useMemo(
    () => [
      { id: 'write', text: t('chat.aliaSuggestion.write') },
      { id: 'private', text: t('chat.aliaSuggestion.private') },
      { id: 'group', text: t('chat.aliaSuggestion.group') },
    ],
    [t],
  );

  const open = useCallback((id: string) => router.push(`/c/${id}`), [router]);
  const me = user?.id;
  const openStory = useCallback(
    (accountId: string) => router.push(`/updates/${accountId}`),
    [router],
  );
  const openUpdates = useCallback(() => router.push('/updates'), [router]);

  // Pressing Chats again: back to the top, then a fresh look at the server.
  const reselect = useMemo(() => ({ refresh: () => client.conversations.refresh() }), [client]);

  // The search, the folders and the stories are the list's header, so the
  // whole screen scrolls as one. The new-conversation button is the app
  // shell's floating action.
  const list = (
    <Screen
      scroll="content"
      reselect={reselect}
      header={toElement(
        Header(t('chat.title'))
          .onBack(null)
          .toolbarLeading(Embed(<AppShellMenuButton accessibilityLabel={t('navigation.open')} />))
          .toolbar(
            !supervised && checkedChats.length === 0
              ? AskAliaButton({ label: t('chat.askAlia') })
              : null,
          )
          .accessory(
            Embed(
              checkedChats.length > 0 ? (
                <ListSelectionBar
                  testID="conversation-selection"
                  count={checkedChats.length}
                  total={chats.length}
                  onClear={() => setCheckedIds(new Set())}
                  onSelectAll={(checked) =>
                    setCheckedIds(new Set(checked ? chats.map((chat) => chat.id) : []))
                  }
                  actions={singleChecked?.swipeActions?.right}
                  onAction={(action) => {
                    if (!singleChecked) return;
                    if (action === LEAVE) void confirmLeave(singleChecked.id);
                    if (action === DELETE) void confirmDelete(singleChecked.id);
                  }}
                />
              ) : undefined,
            ),
          )
          .inPage(),
      )}
    >
      {toElement(
        ScrollView(
          VStack(
            LChatSearchField(
              [
                query,
                (value) => {
                  setQuery(value);
                  setCheckedIds(new Set());
                },
              ],
              { placeholder: t('chat.search.placeholder'), onClear: () => setQuery('') },
            ),
          )
            .padding('horizontal', 'md')
            .padding('bottom', 'sm'),
          folders.length > 0
            ? LChatFolderTabs(folders)
                .value([
                  folder,
                  (value) => {
                    setFolder(value);
                    setCheckedIds(new Set());
                  },
                ])
                .label(t('chat.folder.label'))
                .dividers()
            : null,
          Embed(!supervised && <HistoryTransferBanner />),
          sync === 'offline'
            ? LText(t('chat.sync.offline'))
                .padding('horizontal', 'lg')
                .padding('bottom', 'sm')
                .foreground('muted')
            : null,
          searching
            ? LChatSearchResults(query, results, {
                onResultPress: open,
                labels: { chat: t('chat.title'), empty: t('chat.search.empty') },
              })
            : LList(
                chats.map((chat) => ({
                  id: chat.id,
                  conversation: chat,
                  active: chat.id === selectedId,
                  checked: checkedIds.has(chat.id),
                  onCheckedChange: (checked) => setChecked(chat.id, checked),
                  selecting: checkedChats.length > 0,
                  onPress: () => open(chat.id),
                  swipeActions: chat.swipeActions,
                  actions: chat.swipeActions?.right,
                  onAction: (action) => {
                    if (action === LEAVE) void confirmLeave(chat.id);
                    if (action === DELETE) void confirmDelete(chat.id);
                  },
                })),
              )
                .testID('conversation-list')
                .headerContent(
                  Embed(
                    <StoriesStrip
                      ownAccountId={me}
                      onStoryPress={openStory}
                      onOwnPress={openUpdates}
                    />,
                  ),
                )
                .loading(summaries.length === 0 && sync === 'syncing')
                .emptyState(
                  LChatEmptyState({
                    title: t('chat.empty.title'),
                    description: t('chat.empty.description'),
                  }),
                ),
        )
          .keyboardTaps('handled')
          .contentView((v) => v.padding('bottom', '2xl')),
      )}
    </Screen>
  );

  // Mounted only in the signed-in tree: signed out, this route redirects to sign-in.
  // From `@gemies/sdk/ask`, whose sheet (the same chat, with its voice call) is
  // loaded on the first ask instead of riding in the web entry bundle.
  return supervised ? (
    list
  ) : (
    <GemieAskProvider
      clientContext={t('chat.aliaClientContext', { unread })}
      welcomeSuggestions={aliaWelcomeSuggestions}
    >
      {list}
    </GemieAskProvider>
  );
}

const AskAliaButton = view(function AskAliaButton({ label }: { label: string }) {
  const { ask } = useAskGemie();
  return LButton(Icon(GemieAvatarIcon), LText(label))
    .onPress(() => ask())
    .style('outline');
});
