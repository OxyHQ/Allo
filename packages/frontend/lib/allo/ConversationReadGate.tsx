/** A newly opened transcript waits for a fresh canonical decision before mounting cached media. */
import { useAlloClient } from '@allo/react';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
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
  useFocusEffect(
    useCallback(() => {
      if (!supervised) return;
      let active = true;
      let revision = 0;
      const refresh = () => {
        const current = ++revision;
        setResult(null);
        void client.conversations.refresh().then(
          () => {
            if (active && current === revision) setResult({ id: conversationId, state: 'ready' });
          },
          () => {
            if (active && current === revision)
              setResult({ id: conversationId, state: 'unavailable' });
          },
        );
      };
      refresh();
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') refresh();
        else {
          revision += 1;
          setResult(null);
        }
      });
      return () => {
        active = false;
        subscription.remove();
        setResult(null);
      };
    }, [client, conversationId, supervised, retry]),
  );
  if (!supervised) return <>{children}</>;
  if (!result || result.id !== conversationId) return <ConversationAccessState state="checking" />;
  if (result.state === 'unavailable')
    return (
      <ConversationAccessState state="unavailable" onRetry={() => setRetry((value) => value + 1)} />
    );
  return <>{children}</>;
}
