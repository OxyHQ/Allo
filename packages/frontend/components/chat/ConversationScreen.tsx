import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConversation, useConversationActions, useSyncState, useTimeline } from '@allo/react';
import { GroupAvatar } from '@oxy.so/bloom/chat-list';
import { ChatBackground, ChatEmptyState, ChatHeader } from '@oxy.so/bloom/chat-screen';
import { ComposerIconButton, MessageContextMenu } from '@oxy.so/bloom/chat-composer';
import { RiDeleteBinLine, RiInformationLine, RiMore2Line } from '@oxy.so/bloom/icons';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';

import { Composer, type ComposerTarget } from '@/components/chat/composer/Composer';
import { MediaViewer, type MediaViewerHandle } from '@/components/chat/media/MediaViewer';
import { Transcript } from '@/components/chat/transcript/Transcript';
import type { MessageActions } from '@/components/chat/transcript/MessageRow';
import { useChatContext } from '@/hooks/useChatContext';
import { useInfoPane, useSplitLayout } from '@/hooks/useSplitLayout';
import { collectViewerItems } from '@/lib/chat/attachmentViewer';
import type { PickedAttachments } from '@/lib/chat/attachments';
import {
  conversationAvatar,
  conversationFaces,
  composerNotice,
  conversationTitle,
  firstUnreadId,
  previewText,
  transcriptItems,
  unreachableCopy,
} from '@/lib/chat/model';
import { toUpload } from '@/lib/chat/upload';
import { useChatPaneStore } from '@/stores/chatPaneStore';
import { confirmDialog } from '@/utils/alerts';
import { logger } from '@/utils/logger';

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
  const view = useConversation(conversationId);
  const timeline = useTimeline(conversationId);
  const ctx = useChatContext(view?.memberAccountIds ?? []);
  const viewer = useRef<MediaViewerHandle>(null);
  const [target, setTarget] = useState<ComposerTarget | null>(null);
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
        stalledLabel: t('chat.hold.stalled'),
      }),
    [items, ctx, isGroup, unreadAnchor, unreachable, split, t],
  );
  const sources = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  // The actions read the latest timeline through a ref, so they keep one
  // identity for the screen's life and a new message does not re-render every row.
  const latest = useRef({ items, sources, ctx });
  useEffect(() => {
    latest.current = { items, sources, ctx };
  }, [items, sources, ctx]);
  const { remove, react } = timeline;

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
      openMedia: (id) => {
        const item = collectViewerItems(latest.current.items).find((candidate) => candidate.key === id);
        if (item) viewer.current?.open(item);
      },
    }),
    [react, remove, t],
  );

  const { edit, send, sendMedia, setTyping, loadOlder } = timeline;
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
  const title = conversationTitle(view, ctx);
  const members = view.memberAccountIds.length;
  const other = view.kind === 'dm' ? view.memberAccountIds.find((id) => id !== ctx.me) : undefined;
  const handle = other ? ctx.person(other)?.handle : undefined;
  const faces = conversationFaces(view, ctx);
  const notice = composerNotice(view, t);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={{ paddingTop: split ? 0 : insets.top }}>
        <ChatHeader
          title={title}
          avatar={faces ? <GroupAvatar faces={faces} size={40} /> : undefined}
          avatarSource={faces ? undefined : conversationAvatar(view, ctx)}
          avatarName={title}
          status={isGroup ? t('chat.members', { count: members }) : handle ? `@${handle}` : undefined}
          typingLabel={timeline.typing ? t('chat.typing.someone') : undefined}
          connecting={sync === 'offline'}
          connectingLabel={t('chat.connecting')}
          onPressBack={split ? undefined : () => (router.canGoBack() ? router.back() : router.replace('/'))}
          backLabel={t('common.back')}
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
      <KeyboardAvoidingView behavior="padding" style={styles.root}>
        <ChatBackground variant="pattern" style={styles.root}>
          {items.length === 0 && timeline.reachedStart ? (
            <ChatEmptyState description={t('chat.empty.conversation')} notice={t('chat.e2ee')} />
          ) : (
            <Transcript
              items={rows}
              sources={sources}
              isGroup={isGroup}
              typing={timeline.typing}
              reachedStart={timeline.reachedStart}
              onLoadOlder={onLoadOlder}
              actions={actions}
            />
          )}
        </ChatBackground>
        <View style={{ paddingBottom: split ? 0 : insets.bottom }}>
          <Composer
            target={target}
            onClearTarget={() => setTarget(null)}
            notice={notice?.text}
            noticeBusy={notice?.busy}
            noticeError={notice?.error}
            note={unreachable?.banner}
            onSendText={sendText}
            onSendAttachments={sendAttachments}
            onTyping={onTyping}
          />
        </View>
      </KeyboardAvoidingView>
      <MediaViewer ref={viewer} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
});
