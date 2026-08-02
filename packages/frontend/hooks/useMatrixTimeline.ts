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
  /** Asks the homeserver for older messages. Safe to call on every scroll. */
  readonly loadOlder: () => void;
  readonly send: (body: string) => Promise<void>;
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

  return useMemo(
    () =>
      source === undefined
        ? undefined
        : {
            messages,
            isLoading: snapshot.isOpening,
            isPaginating: snapshot.isPaginating,
            reachedStart: snapshot.reachedStart,
            loadOlder,
            send,
          },
    [source, messages, snapshot, loadOlder, send],
  );
}
