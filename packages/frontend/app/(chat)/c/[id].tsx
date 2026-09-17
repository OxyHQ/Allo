import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { toast } from "@oxy.so/bloom/toast";
import { useOxy } from "@oxy.so/services";
import { useAlloClient, useConversation as useAlloConversation, useConversationActions } from "@allo/react";

import ConversationView from "@/components/conversation/ConversationView";
import { EmptyState } from "@/components/shared/EmptyState";
import { useTheme } from "@/hooks/useTheme";
import { getErrorMessage } from "@/utils/errors";
import { logger } from "@/utils/logger";

/**
 * Unified route handler for ALL conversations: /c/:id
 *
 * The id is a conversation id or an Oxy account id, and the two are told
 * apart by asking the SDK:
 *
 * 1. A conversation with this id is known locally → render it.
 * 2. It is not → the list is refreshed once from the server, because a
 *    conversation created on another device a moment ago is not local yet.
 * 3. Still not → the id is treated as an ACCOUNT id and a direct conversation
 *    with that person is created (idempotent on the server: opening the same
 *    person twice answers the same conversation), and the route is replaced
 *    with the conversation's own id.
 *
 * Nothing optimistic: the SDK answers quickly and an optimistic conversation
 * that the server then names differently was a bug the store-based version
 * carried.
 */
export default function ConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { user } = useOxy();
  const client = useAlloClient();
  const known = useAlloConversation(id ?? "");
  const { createDirect, refresh } = useConversationActions();
  const [failed, setFailed] = useState<string | null>(null);
  const resolving = useRef<string | null>(null);

  useEffect(() => {
    if (!id || known || resolving.current === id) return;
    if (id === user?.id) {
      setFailed("You cannot start a conversation with yourself.");
      return;
    }
    resolving.current = id;
    let cancelled = false;
    (async () => {
      try {
        await refresh();
        if (cancelled) return;
        // The refresh may have made it known, in which case the render that
        // follows draws it and there is nothing to create. Asked of the client
        // directly: the hook's value in this closure is from before the refresh.
        if (client.conversations.get(id)) return;
        const conversation = await createDirect(id);
        if (cancelled) return;
        if (conversation.id !== id) router.replace(`/c/${conversation.id}` as Href);
      } catch (error: unknown) {
        if (cancelled) return;
        logger.error("[ConversationRoute] Could not open a conversation:", error);
        const message = getErrorMessage(error) || "Failed to open the conversation";
        setFailed(message);
        toast.error(message);
      } finally {
        if (resolving.current === id) resolving.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
    // `known` is deliberately read only at the start: once it exists the branch above returns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, known?.id, user?.id, client, createDirect, refresh, router]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        pending: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.background,
        },
      }),
    [theme],
  );

  if (known) return <ConversationView conversationId={known.id} />;
  if (failed) {
    return <EmptyState lottieSource={require("@/assets/lottie/welcome.json")} title={failed} />;
  }
  return (
    <View style={styles.pending}>
      <ActivityIndicator color={theme.colors.primary} />
    </View>
  );
}
