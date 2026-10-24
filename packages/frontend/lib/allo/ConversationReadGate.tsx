/**
 * A newly opened transcript waits for a fresh canonical decision before
 * mounting cached media, and asks again each time the reader comes back to it
 * (the screen in front again, or the app back in the foreground).
 *
 * A failed ask is not the answer straight away: a transient failure is asked
 * again by itself (`useTransientRetry`), the screen keeps saying "checking"
 * meanwhile, and once "cannot check access" is on screen it still recovers by
 * itself when the device is back online.
 */
import { useAlloClient } from '@allo/react';
import { useScreenVisible } from '@oxy.so/bloom/screen';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConversationAccessState } from './ConversationAccessState';
import { useMessagingSupervision } from './MessagingSupervision';
import { useTransientRetry } from './transientRetry';

type Answer =
  | { id: string; state: 'ready' }
  | { id: string; state: 'failed'; at: number; error: unknown };

export function ConversationReadGate({
  conversationId,
  children,
}: {
  conversationId: string;
  children: ReactNode;
}) {
  const supervised = useMessagingSupervision();
  const client = useAlloClient();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const visible = useScreenVisible();
  /** Which visit an ask belongs to: an answer for a visit that ended is dropped. */
  const visit = useRef(0);
  const failures = useRef(0);

  const ask = useCallback(
    (forVisit: number) => {
      void client.conversations.refresh().then(
        () => {
          if (visit.current === forVisit) setAnswer({ id: conversationId, state: 'ready' });
        },
        (error: unknown) => {
          failures.current += 1;
          if (visit.current === forVisit)
            setAnswer({ id: conversationId, state: 'failed', at: failures.current, error });
        },
      );
    },
    [client, conversationId],
  );

  useEffect(() => {
    if (!supervised || !visible) return;
    visit.current += 1;
    const current = visit.current;
    ask(current);
    return () => {
      // The previous answer is cleared when the screen leaves, or the deps moved.
      visit.current += 1;
      setAnswer(null);
    };
  }, [ask, supervised, visible]);

  const retry = useCallback(() => ask(visit.current), [ask]);
  const failure = useMemo(
    () =>
      answer?.state === 'failed' && answer.id === conversationId
        ? { at: answer.at, error: answer.error }
        : null,
    [answer, conversationId],
  );
  const gaveUp = useTransientRetry(failure, retry);

  if (!supervised) return <>{children}</>;
  if (!answer || answer.id !== conversationId) return <ConversationAccessState state="checking" />;
  if (answer.state === 'failed')
    return gaveUp ? (
      <ConversationAccessState state="unavailable" onRetry={retry} />
    ) : (
      <ConversationAccessState state="checking" />
    );
  return <>{children}</>;
}
