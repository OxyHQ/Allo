import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ContactDraft, PlaceDraft, PollDraft, TimelineContent } from '@allo/core';
import { useConversation, useConversationActions, usePresence, useSyncState, useTimeline } from '@allo/react';
import { ChatBackground, ChatEmptyState, ChatHeader, PinnedMessageBar } from '@oxy.so/bloom/chat-screen';
import { ChatSearchField, GroupAvatar } from '@oxy.so/bloom/chat-list';
import { ComposerIconButton, MessageContextMenu } from '@oxy.so/bloom/chat-composer';
import {
  RiArrowGoBackLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiInformationLine,
  RiMore2Line,
  RiPencilLine,
  RiPushpinLine,
} from '@oxy.so/bloom/icons';
import type { MessageBubbleLabels, MessageListItem } from '@oxy.so/bloom/message-bubble';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import * as Clipboard from 'expo-clipboard';

import { Composer, type ComposerTarget, type Mentionable } from '@/components/chat/composer/Composer';
import { MediaViewer, type MediaViewerHandle } from '@/components/chat/media/MediaViewer';
import { hasMessageMedia, MessageMedia } from '@/components/chat/media/MessageMedia';
import { Transcript } from '@/components/chat/transcript/Transcript';
import { useChatContext } from '@/hooks/useChatContext';
import { useInfoPane, useSplitLayout } from '@/hooks/useSplitLayout';
import { collectViewerItems } from '@/lib/chat/attachmentViewer';
import type { PickedAttachments } from '@/lib/chat/attachments';
import {
  conversationAvatar,
  conversationFaces,
  conversationTitle,
  firstUnreadId,
  pinnedMessages,
  previewText,
  transcriptItems,
  unreachableCopy,
} from '@/lib/chat/model';
import { toUpload } from '@/lib/chat/upload';
import { presenceDot, presenceLine } from '@/lib/presence';
import { useCallsStore } from '@/lib/phase2/calls';
import { useChatPaneStore } from '@/stores/chatPaneStore';
import { confirmDialog } from '@/utils/alerts';
import { logger } from '@/utils/logger';

/** What this screen does to a message it is pointed at. */
interface MessageActions {
  reply: (id: string) => void;
  edit: (id: string) => void;
  remove: (id: string) => void;
  pin: (id: string, pinned: boolean) => void;
  react: (id: string, emoji: string) => void;
  vote: (id: string, optionIds: string[]) => void;
  openMedia: (id: string) => void;
  /** A card that names an Oxy account: open the conversation with them. */
  messageAccount: (accountId: string) => void;
}

/** The content kinds whose bubble keeps its padding rather than letting the block bleed. */
const INSET_MEDIA: ReadonlySet<TimelineContent['kind']> = new Set<TimelineContent['kind']>([
  'poll',
  'location',
  'contact',
]);

/** A readable measure for a bubble once the conversation has a pane to itself. */
const WIDE_BUBBLE_MAX_WIDTH = 560;

/** One conversation: its header, its messages and the composer. */
export function ConversationScreen({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const split = useSplitLayout();
  // Below the third column the info is a route of its own, so the press always lands somewhere.
  const infoBeside = useInfoPane();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const toggleInfo = useChatPaneStore((state) => state.toggleInfo);
  const sync = useSyncState();
  const { leave } = useConversationActions();
  const placeCall = useCallsStore((state) => state.place);
  const view = useConversation(conversationId);
  const timeline = useTimeline(conversationId);
  const ctx = useChatContext(view?.memberAccountIds ?? []);
  const viewer = useRef<MediaViewerHandle>(null);
  const [target, setTarget] = useState<ComposerTarget | null>(null);
  // Searching filters the loaded history: this device has no other history to search.
  const [search, setSearch] = useState<string | null>(null);
  /** The message whose actions are open. One menu for the screen, as Bloom draws one. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** Which pin the bar is showing, and whether it was dismissed for this visit. */
  const [pinIndex, setPinIndex] = useState(0);
  const [pinsHidden, setPinsHidden] = useState(false);
  const isGroup = view?.kind === 'group';

  // Where "unread messages" goes is decided once, from the count as the
  // conversation opened; the read receipt below zeroes it straight after.
  const [unreadAnchor, setUnreadAnchor] = useState<string | undefined | null>(null);
  const { items, markRead } = timeline;
  if (unreadAnchor === null && items.length > 0) setUnreadAnchor(firstUnreadId(items, view?.unreadCount ?? 0));

  // Whatever is on screen has been read. The SDK sends one receipt per advance
  // and nothing when nothing is new, so this is safe on every change.
  useEffect(() => {
    if (items.length === 0) return;
    markRead().catch((error: unknown) => logger.warn('[Conversation] read receipt failed', error));
  }, [items, markRead]);

  // Somebody here has not set up Allo: a note above the composer, and a name for the held clock.
  const unreachable = useMemo(() => (view ? unreachableCopy(view, ctx) : null), [view, ctx]);
  const rows = useMemo(
    () =>
      transcriptItems(items, ctx, {
        isGroup,
        firstUnreadId: unreadAnchor ?? undefined,
        holdLabel: unreachable?.hold,
        bubbleMaxWidth: split ? WIDE_BUBBLE_MAX_WIDTH : undefined,
      }),
    [items, ctx, isGroup, unreadAnchor, unreachable, split],
  );
  const sources = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  // A DM's other account is the one presence this screen draws. A group's
  // members are not watched: a header cannot say anything useful about eight
  // dots, and watching them would tell the server about a screen that shows
  // nothing of the sort.
  const other = view?.kind === 'dm' ? view.memberAccountIds.find((id) => id !== ctx.me) : undefined;
  const watched = useMemo(() => (other ? [other] : []), [other]);
  const presence = usePresence(watched);
  const pins = useMemo(() => pinnedMessages(items, ctx), [items, ctx]);

  const matches = useMemo(() => {
    const needle = search?.trim().toLocaleLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => row.text?.toLocaleLowerCase().includes(needle));
  }, [rows, search]);

  /** Who `@` offers: the group's other members, named by the people layer. */
  const mentionables = useMemo<Mentionable[]>(() => {
    if (!isGroup) return [];
    return (view?.memberAccountIds ?? [])
      .filter((id) => id !== ctx.me)
      .map((id) => {
        const person = ctx.person(id);
        return { id, label: person?.displayName ?? '', handle: person?.handle, avatar: person?.avatar };
      })
      .filter((person) => person.label !== '');
  }, [ctx, isGroup, view?.memberAccountIds]);

  const bubbleLabels = useMemo<Partial<MessageBubbleLabels>>(
    () => ({
      deleted: t('message.deleted'),
      replyTo: t('message.replyTo'),
      addReaction: t('message.addReaction'),
      pending: t('message.pending'),
      failed: t('message.failed'),
      selected: t('message.selected'),
      retry: t('message.retry'),
    }),
    [t],
  );

  // The actions read the latest timeline through a ref, so they keep one
  // identity for the screen's life and a new message does not re-render every row.
  const latest = useRef({ items, sources, ctx });
  useEffect(() => {
    latest.current = { items, sources, ctx };
  }, [items, sources, ctx]);
  const { remove, react, setPinned, vote } = timeline;

  const actions = useMemo<MessageActions>(
    () => ({
      reply: (id) => {
        const source = latest.current.sources.get(id);
        if (!source) return;
        const who = source.isOwn ? t('chat.you') : (latest.current.ctx.person(source.senderAccountId)?.displayName ?? '');
        setTarget({ kind: 'reply', id, title: who, preview: previewText(source, t) });
      },
      edit: (id) => {
        const source = latest.current.sources.get(id);
        if (source?.content.kind !== 'text') return;
        setTarget({ kind: 'edit', id, body: source.content.body, preview: source.content.body });
      },
      remove: (id) => {
        void confirmDialog({
          title: t('message.delete'),
          message: t('message.deleteConfirm'),
          okText: t('message.delete'),
          cancelText: t('common.cancel'),
          destructive: true,
        }).then((ok) => {
          if (!ok) return;
          remove(id).catch((error: unknown) => {
            logger.error('[Conversation] delete failed', error);
            toast.error(t('error.chat.delete_failed'));
          });
        });
      },
      react: (id, emoji) => {
        react(id, emoji).catch((error: unknown) => logger.warn('[Conversation] reaction failed', error));
      },
      pin: (id, pinned) => {
        setPinned(id, pinned).catch((error: unknown) => {
          logger.error('[Conversation] pin failed', error);
          toast.error(t('message.pinFailed'));
        });
      },
      vote: (id, optionIds) => {
        vote(id, optionIds).catch((error: unknown) => {
          logger.error('[Conversation] vote failed', error);
          toast.error(t('poll.voteFailed'));
        });
      },
      openMedia: (id) => {
        const item = collectViewerItems(latest.current.items).find((candidate) => candidate.key === id);
        if (item) viewer.current?.open(item);
      },
      messageAccount: (accountId) => router.push(`/c/${accountId}`),
    }),
    [react, remove, router, setPinned, t, vote],
  );

  const { edit, send, sendMedia, setTyping, loadOlder } = timeline;
  /**
   * What `MessageList` draws: the projection, plus this screen's gestures and
   * the media node a bubble carries. Built here rather than in a component of
   * our own, because Bloom's list renders the bubbles itself.
   */
  const listItems = useMemo<MessageListItem[]>(
    () =>
      matches.map((row) => {
        const source = sources.get(row.id);
        const content = source?.content;
        const settled = source !== undefined && source.sendState !== 'pending' && source.sendState !== 'failed';
        return {
          ...row,
          media:
            content && hasMessageMedia(content) ? (
              <MessageMedia
                content={content}
                tone={row.direction}
                onOpen={() => actions.openMedia(row.id)}
                onVote={(optionIds) => actions.vote(row.id, optionIds)}
                onMessageAccount={actions.messageAccount}
              />
            ) : undefined,
          // A photo bleeds to the bubble's radius; a poll, a place and a card
          // are typography and keep its padding (Bloom 2.12.4).
          mediaFit: content && INSET_MEDIA.has(content.kind) ? ('inset' as const) : undefined,
          onLongPress: content && content.kind !== 'deleted' ? () => setMenuFor(row.id) : undefined,
          onContextMenu: content && content.kind !== 'deleted' ? () => setMenuFor(row.id) : undefined,
          onToggleReaction: settled ? (emoji: string) => actions.react(row.id, emoji) : undefined,
          onSwipeReply: settled ? () => actions.reply(row.id) : undefined,
        };
      }),
    [actions, matches, sources],
  );

  /** The actions the open message allows, in the order a reader expects them. */
  const menuSource = menuFor ? sources.get(menuFor) : undefined;
  const menuItems = useMemo(() => {
    if (!menuSource) return [];
    const settled = menuSource.sendState !== 'pending' && menuSource.sendState !== 'failed';
    const entries = [];
    if (settled) entries.push({ id: 'reply', label: t('message.reply'), icon: RiArrowGoBackLine });
    if (menuSource.content.kind === 'text') entries.push({ id: 'copy', label: t('message.copy'), icon: RiFileCopyLine });
    if (menuSource.isOwn && settled && menuSource.content.kind === 'text') {
      entries.push({ id: 'edit', label: t('message.edit'), icon: RiPencilLine });
    }
    if (settled) {
      entries.push({
        id: menuSource.pinned ? 'unpin' : 'pin',
        label: menuSource.pinned ? t('message.unpin') : t('message.pin'),
        icon: RiPushpinLine,
      });
    }
    if (menuSource.isOwn && settled) {
      entries.push({
        id: 'delete',
        label: t('message.delete'),
        icon: RiDeleteBinLine,
        variant: 'destructive' as const,
        separated: true,
      });
    }
    return entries;
  }, [menuSource, t]);

  const sendText = useCallback(
    async (text: string, composing: ComposerTarget | null) => {
      try {
        if (composing?.kind === 'edit') await edit(composing.id, text);
        else await send(text, { replyTo: composing?.kind === 'reply' ? composing.id : undefined });
      } catch (error) {
        logger.error('[Conversation] send failed', error);
        toast.error(t('error.chat.send_failed'));
        throw error;
      }
    },
    [edit, send, t],
  );

  const sendAttachments = useCallback(
    async (attachments: PickedAttachments) => {
      for (const attachment of attachments) {
        try {
          const { bytes, meta } = await toUpload(attachment);
          await sendMedia(bytes, meta);
        } catch (error) {
          logger.error('[Conversation] attachment failed', error);
          toast.error(t('error.chat.send_failed'));
        }
      }
    },
    [sendMedia, t],
  );

  /**
   * A poll, a place and a card each go as their own message, so all three are
   * the same shape: send it, and say so when it does not go out.
   */
  const { sendPoll, sendLocation, sendContact } = timeline;
  const sendOne = useCallback(
    async (send: () => Promise<string>) => {
      try {
        await send();
      } catch (error) {
        logger.error('[Conversation] send failed', error);
        toast.error(t('error.chat.send_failed'));
        throw error;
      }
    },
    [t],
  );
  const onSendPoll = useCallback((poll: PollDraft) => sendOne(() => sendPoll(poll)), [sendOne, sendPoll]);
  const onSendPlace = useCallback((place: PlaceDraft) => sendOne(() => sendLocation(place)), [sendLocation, sendOne]);
  const onSendContact = useCallback(
    (contact: ContactDraft) => sendOne(() => sendContact(contact)),
    [sendContact, sendOne],
  );

  const onTyping = useCallback(
    (on: boolean) => {
      setTyping(on).catch(() => {
        // A typing notice that does not go out is not worth a toast.
      });
    },
    [setTyping],
  );
  const onLoadOlder = useCallback(() => void loadOlder(), [loadOlder]);

  const confirmLeave = useCallback(async () => {
    const ok = await confirmDialog({
      title: isGroup ? t('chat.leave.group') : t('chat.leave.conversation'),
      message: t('chat.leave.confirm'),
      okText: t('chat.leave.action'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await leave(conversationId);
      router.replace('/');
    } catch (error) {
      logger.error('[Conversation] leave failed', error);
      toast.error(t('chat.leave.failed'));
    }
  }, [conversationId, isGroup, leave, router, t]);

  if (!view) return null;

  const openInfo = () => (infoBeside ? toggleInfo() : router.push(`/c/${conversationId}/info`));
  /**
   * Calls are not connected to anything yet: this opens the call screen, which
   * says so itself. The mode is decided here so the screen does not have to
   * guess which button was pressed.
   */
  const startCall = (mode: 'voice' | 'video') => {
    const peers = view.memberAccountIds.filter((id) => id !== ctx.me);
    if (peers.length === 0) return;
    placeCall({ conversationId, peerAccountIds: peers, mode });
    router.push(`/c/${conversationId}/call`);
  };
  const title = conversationTitle(view, ctx);
  const members = view.memberAccountIds.length;
  const otherPerson = other ? ctx.person(other) : undefined;
  const handle = otherPerson?.handle;
  const faces = conversationFaces(view, ctx);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={{ paddingTop: split ? 0 : insets.top }}>
        <ChatHeader
          title={title}
          marker={otherPerson?.verified ? 'verified' : undefined}
          markerLabel={otherPerson?.verified ? t('profile.verified') : undefined}
          avatar={faces ? <GroupAvatar faces={faces} size={40} /> : undefined}
          avatarSource={faces ? undefined : conversationAvatar(view, ctx)}
          avatarName={title}
          status={
            isGroup
              ? t('chat.members', { count: members })
              : // Presence when there is any, the handle when there is not: a
                // header that says nothing is worse than one that says who.
                (other ? presenceLine(presence.of(other), { t, locale: ctx.locale, now: ctx.now }) : undefined) ??
                (handle ? `@${handle}` : undefined)
          }
          presence={other ? presenceDot(presence.of(other)) : undefined}
          typingLabel={timeline.typing ? t('chat.typing.someone') : undefined}
          connecting={sync === 'offline'}
          connectingLabel={t('chat.connecting')}
          onPressBack={split ? undefined : () => (router.canGoBack() ? router.back() : router.replace('/'))}
          backLabel={t('common.back')}
          onPressCall={() => startCall('voice')}
          onPressVideoCall={() => startCall('video')}
          callLabel={t('calls.voice')}
          videoCallLabel={t('calls.video')}
          onPressSearch={() => setSearch((current) => (current === null ? '' : null))}
          searchLabel={t('chat.info.search')}
          onPressHeader={openInfo}
          openInfoLabel={t('chat.info.open')}
          renderMore={() => (
            <MessageContextMenu
              label={t('chat.actions')}
              reactions={false}
              items={[
                { id: 'info', label: t('chat.info.open'), icon: RiInformationLine },
                {
                  id: 'leave',
                  label: isGroup ? t('chat.leave.group') : t('chat.leave.conversation'),
                  icon: RiDeleteBinLine,
                  variant: 'destructive',
                  separated: true,
                },
              ]}
              onSelect={(action) => {
                if (action === 'info') openInfo();
                else void confirmLeave();
              }}
            >
              <ComposerIconButton icon={RiMore2Line} accessibilityLabel={t('chat.actions')} />
            </MessageContextMenu>
          )}
          divider
        />
      </View>
      {pins.length > 0 && !pinsHidden && (
        <PinnedMessageBar
          pins={pins}
          index={pinIndex}
          onPressPin={(_pin, index) => setPinIndex(index + 1 >= pins.length ? 0 : index + 1)}
          onDismiss={() => setPinsHidden(true)}
          dismissLabel={t('common.close')}
          formatTitle={(index, total) =>
            total > 1 ? t('chat.pinned.numbered', { index: index + 1 }) : t('chat.pinned.one')
          }
        />
      )}
      {search !== null && (
        <View style={styles.search}>
          <ChatSearchField
            value={search}
            onChangeText={setSearch}
            onClear={() => setSearch(null)}
            placeholder={t('chat.search.inConversation')}
            autoFocus
          />
        </View>
      )}
      <KeyboardAvoidingView behavior="padding" style={styles.root}>
        <ChatBackground variant="pattern" style={styles.root}>
          {matches.length === 0 && search !== null ? (
            <ChatEmptyState title={t('chat.search.empty')} />
          ) : items.length === 0 && timeline.reachedStart ? (
            <ChatEmptyState description={t('chat.empty.conversation')} notice={t('chat.e2ee')} />
          ) : (
            <Transcript
              items={listItems}
              isGroup={isGroup}
              typing={timeline.typing}
              unreadCount={view.unreadCount}
              reachedStart={timeline.reachedStart}
              onLoadOlder={onLoadOlder}
              labels={bubbleLabels}
            />
          )}
        </ChatBackground>
        <View style={{ paddingBottom: split ? 0 : insets.bottom }}>
          <Composer
            target={target}
            onClearTarget={() => setTarget(null)}
            notice={view.joined ? undefined : t('chat.notJoined')}
            note={unreachable?.banner}
            mentionables={mentionables}
            onSendText={sendText}
            onSendAttachments={sendAttachments}
            onSendPoll={onSendPoll}
            onSendPlace={onSendPlace}
            onSendContact={onSendContact}
            onTyping={onTyping}
          />
        </View>
      </KeyboardAvoidingView>
      {/* One menu for the screen: Bloom draws a dropdown on the web and a sheet
          on a phone, and a message opens it through its own long press. */}
      <MessageContextMenu
        open={menuFor !== null}
        onOpenChange={(open) => {
          if (!open) setMenuFor(null);
        }}
        label={t('message.actions')}
        items={menuItems}
        reactions={menuSource && menuSource.sendState !== 'failed' ? undefined : false}
        selectedReaction={menuSource?.reactions.find((reaction) => ctx.me && reaction.accountIds.includes(ctx.me))?.key}
        onSelectReaction={(emoji) => {
          if (menuFor) actions.react(menuFor, emoji);
          setMenuFor(null);
        }}
        onSelect={(action) => {
          const id = menuFor;
          setMenuFor(null);
          if (!id) return;
          if (action === 'pin' || action === 'unpin') actions.pin(id, action === 'pin');
          else if (action === 'reply') actions.reply(id);
          else if (action === 'edit') actions.edit(id);
          else if (action === 'delete') actions.remove(id);
          else if (action === 'copy') {
            const source = sources.get(id);
            if (source?.content.kind === 'text') {
              void Clipboard.setStringAsync(source.content.body).then(() => toast.success(t('message.copied')));
            }
          }
        }}
      >
        <View style={styles.menuAnchor} />
      </MessageContextMenu>
      <MediaViewer ref={viewer} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  search: { paddingHorizontal: 12, paddingVertical: 8 },
  menuAnchor: { position: 'absolute', left: 24, bottom: 96, height: 0, width: 0 },
});
