/**
 * A newly opened transcript waits for a fresh canonical decision before
 * mounting cached media, and asks again each time the reader comes back to it
 * (the screen in front again, or the app back in the foreground).
 */
import { useAlloClient } from '@allo/react';
import { useScreenVisible } from '@oxy.so/bloom/screen';
import { useEffect, useState, type ReactNode } from 'react';
import { ConversationAccessState } from './ConversationAccessState';
import { useMessagingSupervision } from './MessagingSupervision';

export function ConversationReadGate({
  conversationId,
  children,
}: {
  conversationId: string;
  children: ReactNode;
}) {
  const supervised = useMessagingSupervision();
  const client = useAlloClient();
  const [result, setResult] = useState<{ id: string; state: 'ready' | 'unavailable' } | null>(null);
  const [retry, setRetry] = useState(0);
  const visible = useScreenVisible();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `retry` re-asks on purpose.
  useEffect(() => {
    if (!supervised || !visible) return;
    let active = true;
    // The previous answer was cleared when the screen left, or the deps moved.
    void client.conversations.refresh().then(
      () => {
        if (active) setResult({ id: conversationId, state: 'ready' });
      },
      () => {
        if (active) setResult({ id: conversationId, state: 'unavailable' });
      },
    );
    return () => {
      active = false;
      setResult(null);
    };
  }, [client, conversationId, supervised, visible, retry]);
  if (!supervised) return <>{children}</>;
  if (!result || result.id !== conversationId) return <ConversationAccessState state="checking" />;
  if (result.state === 'unavailable')
    return (
      <ConversationAccessState state="unavailable" onRetry={() => setRetry((value) => value + 1)} />
    );
  return <>{children}</>;
}
