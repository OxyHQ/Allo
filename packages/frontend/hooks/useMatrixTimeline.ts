import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { CHAT_BACKEND } from '@/lib/chat/backend';
import { toMessage, type UnreadableEventLabels } from '@/lib/chat/matrixViewModel';
import { timelineSource, type TimelineSnapshot } from '@/lib/chat/timelineSource';
import type { AlloUnsubscribe } from '@/lib/matrix/types';
import type { Message } from '@/stores/messagesStore';
import { logger } from '@/utils/logger';

/**
 * One conversation's messages, from the Matrix port.
 *
 * Answers `undefined` when this build talks to the Express API, or when there is
 * no conversation to draw, so that `ConversationView` can fall through to the
 * store it has always used.
 */

/**
 * How many older events one "load more" asks for.
 *
 * The homeserver may return fewer, and on an encrypted room some of them are
 * state events the timeline does not draw, so this is a request and not a count
 * of new rows.
 */
const PAGE_SIZE = 30;

const NO_MESSAGES: readonly Message[] = [];
const NO_UNSUBSCRIBE: AlloUnsubscribe = () => {};
const subscribeToNothing = (): AlloUnsubscribe => NO_UNSUBSCRIBE;

const CLOSED_TIMELINE: TimelineSnapshot = {
  items: [],
  isOpening: false,
  isPaginating: false,
  reachedStart: false,
  typingUserIds: [],
};
const closedTimeline = (): TimelineSnapshot => CLOSED_TIMELINE;

const enabled = CHAT_BACKEND === 'matrix';

export interface MatrixTimeline {
  readonly messages: readonly Message[];
  /** The timeline is being opened; there is nothing to draw *yet*. */
  readonly isLoading: boolean;
  readonly isPaginating: boolean;
  /** The first message of the conversation is on screen; stop asking for more. */
  readonly reachedStart: boolean;
  /** Matrix user ids of everyone else typing here, right now. */
  readonly typingUserIds: readonly string[];
  /** Asks the homeserver for older messages. Safe to call on every scroll. */
  readonly loadOlder: () => void;
  readonly send: (body: string) => Promise<void>;
  /** Adds the viewer's reaction to a message, or takes it away. */
  readonly toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  /** Replaces the body of a message the viewer sent. */
  readonly edit: (messageId: string, body: string) => Promise<void>;
  /**
   * Removes a message's content.
   *
   * The row stays and starts drawing itself as deleted, because that is what a
   * Matrix redaction does — see `AlloTimelineHandle.redact`.
   */
  readonly deleteMessage: (messageId: string) => Promise<void>;
  /**
   * Tells the homeserver everything up to the newest message has been read.
   *
   * Cheap and idempotent: an event already receipted is not sent again.
   */
  readonly markRead: () => void;
  /** Says whether the viewer is typing here. */
  readonly setTyping: (isTyping: boolean) => void;
}

export function useMatrixTimeline(
  conversationId: string | undefined,
): MatrixTimeline | undefined {
  const { t } = useTranslation();

  const source = useMemo(
    () =>
      enabled && conversationId !== undefined ? timelineSource(conversationId) : undefined,
    [conversationId],
  );

  const snapshot = useSyncExternalStore(
    source?.subscribe ?? subscribeToNothing,
    source?.getSnapshot ?? closedTimeline,
    closedTimeline,
  );

  const labels = useMemo<UnreadableEventLabels>(
    () => ({
      undecryptable: t('This message cannot be read on this device.'),
      redacted: t('This message was deleted.'),
      unsupported: (description) =>
        t('Allo cannot show this yet ({{kind}}).', { kind: description }),
    }),
    [t],
  );

  const messages = useMemo(
    () =>
      conversationId === undefined
        ? NO_MESSAGES
        : snapshot.items.map((item) => toMessage(item, conversationId, labels)),
    [snapshot.items, conversationId, labels],
  );

  const loadOlder = useCallback(() => {
    if (source === undefined) {
      return;
    }
    // Deliberately not awaited: this is called from a list as the user scrolls,
    // and the snapshot already reports that a pagination is running. Failures are
    // logged rather than shown, because the conversation is still readable.
    source.paginateBackwards(PAGE_SIZE).catch((error: unknown) => {
      logger.error('[chat] older messages could not be loaded', error);
    });
  }, [source]);

  const send = useCallback(
    async (body: string): Promise<void> => {
      if (source === undefined) {
        return;
      }
      await source.sendText(body);
    },
    [source],
  );

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string): Promise<void> => {
      if (source === undefined) {
        return;
      }
      await source.toggleReaction(messageId, emoji);
    },
    [source],
  );

  const edit = useCallback(
    async (messageId: string, body: string): Promise<void> => {
      if (source === undefined) {
        return;
      }
      await source.edit(messageId, body);
    },
    [source],
  );

  const deleteMessage = useCallback(
    async (messageId: string): Promise<void> => {
      if (source === undefined) {
        return;
      }
      // No reason is sent. Allo has nowhere to ask for one, and a reason is
      // visible to the whole room — inventing "Deleted by the user" would put
      // words in the sender's mouth on every other client.
      await source.redact(messageId);
    },
    [source],
  );

  const markRead = useCallback(() => {
    if (source === undefined) {
      return;
    }
    // Deliberately not awaited and its failures not shown: a read receipt is
    // something the reader neither asked for nor can act on. It is logged
    // because a receipt that never goes out leaves the *sender's* bubble one
    // tick short, and that is a real bug with no other symptom.
    source.markRead().catch((error: unknown) => {
      logger.error('[chat] a read receipt could not be sent', error);
    });
  }, [source]);

  const setTyping = useCallback(
    (isTyping: boolean) => {
      if (source === undefined) {
        return;
      }
      // Not awaited either. A typing notice is only worth anything while it is
      // still true, so there is nothing useful to do about one that failed —
      // and the composer must not wait on the network between keystrokes.
      source.sendTypingNotice(isTyping).catch((error: unknown) => {
        logger.error('[chat] a typing notice could not be sent', error);
      });
    },
    [source],
  );

  return useMemo(
    () =>
      source === undefined
        ? undefined
        : {
            messages,
            isLoading: snapshot.isOpening,
            isPaginating: snapshot.isPaginating,
            reachedStart: snapshot.reachedStart,
            typingUserIds: snapshot.typingUserIds,
            loadOlder,
            send,
            toggleReaction,
            edit,
            deleteMessage,
            markRead,
            setTyping,
          },
    [
      source,
      messages,
      snapshot,
      loadOlder,
      send,
      toggleReaction,
      edit,
      deleteMessage,
      markRead,
      setTyping,
    ],
  );
}
