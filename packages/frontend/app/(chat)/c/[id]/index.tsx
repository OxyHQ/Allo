import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services/ui/client';
import { useAlloClient, useConversation, useConversationActions } from '@allo/react';
import { useTheme } from '@oxy.so/bloom/theme';

import { ConversationScreen } from '@/components/chat/ConversationScreen';
import { EmptyDetail } from '@/components/shell/EmptyDetail';
import { shareTextFromParam } from '@/lib/chat/shareText';
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
 *
 * `?text=<message>` is a DRAFT: it is put in the composer and the reader sends
 * it, or does not. A link must never send by itself — any web page can open
 * `allo://c/<id>?text=…`, and a message that went out on a page's say-so would
 * be that page speaking as the reader. Mention's share sheet opens this with a
 * post's link (`alloDirectMessageLinks` in `@oxy.so/allo-sdk/links`). The value
 * is somebody else's input and goes through the same `shareTextFromParam` as
 * `/share?text=`; it survives the replace from an account id to the
 * conversation's own, and is dropped from the URL once the conversation is on
 * screen.
 */
export default function ConversationRoute() {
  const { id, text } = useLocalSearchParams<{ id: string; text?: string | string[] }>();
  const draft = shareTextFromParam(text);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: `known` is read only to skip the work: once it exists there is nothing to resolve.
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
        if (cancelled || conversation.id === id) return;
        const query = draft ? `?text=${encodeURIComponent(draft)}` : '';
        router.replace(`/c/${conversation.id}${query}`);
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
  }, [id, known?.id, isSelf, client, createDirect, refresh, router, t, draft]);

  // The draft is the composer's once the conversation is on screen (it keeps
  // its own copy), so the link's is dropped: left in the URL, a reload or a
  // return to this history entry would put back text already sent or deleted.
  const shown = known?.id;
  useEffect(() => {
    if (shown && text !== undefined) router.setParams({ text: undefined });
  }, [shown, text, router]);

  if (known) return <ConversationScreen key={known.id} conversationId={known.id} draft={draft} />;
  if (isSelf) return <EmptyDetail title={t('chat.open.self')} />;
  if (failed) return <EmptyDetail title={failed} />;
  return (
    <View style={styles.pending}>
      <ActivityIndicator color={theme.colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  pending: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
