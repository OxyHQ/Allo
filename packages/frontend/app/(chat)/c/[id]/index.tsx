import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { useAlloClient, useConversation, useConversationActions } from '@allo/react';
import { useTheme } from '@oxy.so/bloom/theme';

import { ConversationScreen } from '@/components/chat/ConversationScreen';
import { EmptyDetail } from '@/components/shell/EmptyDetail';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * `/c/:id` — a conversation id, or an Oxy account id to talk to.
 *
 * Told apart by asking the SDK: a conversation known locally renders; one that
 * is not is looked for once on the server (it may have been created on another
 * device a moment ago); still unknown, the id is an ACCOUNT and a direct
 * conversation with that person is created — idempotent on the server — and
 * the route is replaced with the conversation's own id.
 */
export default function ConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();
  const { user } = useOxy();
  const client = useAlloClient();
  const known = useConversation(id ?? '');
  const { createDirect, refresh } = useConversationActions();
  const [failed, setFailed] = useState<string | null>(null);
  const resolving = useRef<string | null>(null);

  const isSelf = Boolean(id) && id === user?.id;

  useEffect(() => {
    if (!id || known || isSelf || resolving.current === id) return;
    resolving.current = id;
    let cancelled = false;
    (async () => {
      try {
        await refresh();
        // Asked of the client: the hook's value in this closure predates the refresh.
        if (cancelled || client.conversations.get(id)) return;
        const conversation = await createDirect(id);
        if (!cancelled && conversation.id !== id) router.replace(`/c/${conversation.id}`);
      } catch (error) {
        if (cancelled) return;
        logger.error('[ConversationRoute] could not open a conversation', error);
        setFailed(getErrorMessage(error) || t('chat.open.failed'));
      } finally {
        if (resolving.current === id) resolving.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
    // `known` is read only to skip the work: once it exists there is nothing to resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, known?.id, isSelf, client, createDirect, refresh, router, t]);

  if (known) return <ConversationScreen key={known.id} conversationId={known.id} />;
  if (isSelf) return <EmptyDetail title={t('chat.open.self')} />;
  if (failed) return <EmptyDetail title={failed} />;
  return (
    <View style={[styles.pending, { backgroundColor: theme.colors.background }]}>
      <ActivityIndicator color={theme.colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  pending: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
