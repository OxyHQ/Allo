import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services/ui/client';
import { useAlloClient, useConversations } from '@allo/react';
import { Button } from '@oxy.so/bloom/button';
import { ChatSearchField, GroupAvatar } from '@oxy.so/bloom/chat-list';
import {
  ContactList,
  SelectedChipsRow,
  type ContactSection,
  type PersonSummary,
} from '@oxy.so/bloom/chat-people';
import { ChatEmptyState } from '@oxy.so/bloom/chat-screen';
import { Loading } from '@oxy.so/bloom/loading';
import { MessageBubble } from '@oxy.so/bloom/message-bubble';
import { toast } from '@oxy.so/bloom/toast';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';

import { useChatSummaries } from '@/hooks/useChatSummaries';
import { useCreateConversation } from '@/hooks/useCreateConversation';
import { useUserSearch } from '@/hooks/useUserSearch';
import { shareTextFromParam } from '@/lib/chat/shareText';
import { logger } from '@/utils/logger';

/** Rows of the "Recent" section before anything is typed. */
const RECENT_LIMIT = 20;

/** Somebody to send to: a conversation that exists, or a person whose DM may not yet. */
interface Target {
  /** Unique across both kinds: a conversation id and an account id never share a row. */
  key: string;
  kind: 'conversation' | 'person';
  id: string;
  summary: PersonSummary;
}

/**
 * `/share?text=<message>` — send a message another app handed over.
 *
 * Mention's "send" button on a post opens `allo://share?text=<post url>` (or
 * `https://allo.you/share?text=…` on the web). Signed out, the root stack sends
 * the link through sign-in and `usePendingHref` brings it back here, query and
 * all.
 *
 * The screen is the new-chat picker turned round: the message is fixed and
 * shown as the bubble it will become, and the reader picks where it goes —
 * recent conversations first, anybody else by search. A conversation gets the
 * message as it is; a person gets it in the direct conversation with them,
 * made by the same `useCreateConversation` seam `/new` and `/c/<account id>`
 * use (idempotent on the server, so an existing DM is answered, not doubled).
 * The message goes through the SDK's `messages.send`, the call the composer's
 * `useTimeline().send` makes. One destination opens it; several go back to the
 * list, where every row shows the message went.
 */
export default function ShareRoute() {
  const params = useLocalSearchParams<{ text?: string | string[] }>();
  const text = shareTextFromParam(params.text);
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useOxy();
  const client = useAlloClient();
  const views = useConversations();
  const summaries = useChatSummaries();
  const create = useCreateConversation();
  const search = useUserSearch();
  const [selected, setSelected] = useState<ReadonlyMap<string, Target>>(new Map());
  const [busy, setBusy] = useState(false);

  /** A conversation the composer would refuse (blocked, or closed for integrity) is not offered. */
  const sendable = useMemo(
    () =>
      new Set(
        views
          .filter(
            (view) =>
              (view.access === undefined || view.access === 'allowed') &&
              view.integrity !== 'refused_commit',
          )
          .map((view) => view.id),
      ),
    [views],
  );

  const toggle = useCallback((target: Target) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(target.key)) next.delete(target.key);
      else next.set(target.key, target);
      return next;
    });
  }, []);

  const remove = useCallback((key: string) => {
    setSelected((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    const targets = [...selected.values()];
    if (targets.length === 0 || text.length === 0) return;
    setBusy(true);
    const delivered = new Set<string>();
    const failed = new Map<string, Target>();
    for (const target of targets) {
      try {
        const conversationId =
          target.kind === 'conversation'
            ? target.id
            : await create({ participantIds: [target.id], name: undefined });
        // A person picked beside their own DM resolves to the same conversation: send once.
        if (!delivered.has(conversationId)) {
          await client.messages.send(conversationId, text);
          delivered.add(conversationId);
        }
      } catch (error) {
        logger.error('[Share] send failed', error);
        failed.set(target.key, target);
      }
    }
    setBusy(false);
    if (failed.size > 0) {
      // What went, went; what is left selected is what a second press retries.
      setSelected(failed);
      toast.error(t('share.failed'));
      return;
    }
    const [only, ...rest] = [...delivered];
    if (only !== undefined && rest.length === 0) {
      router.replace(`/c/${only}`);
      return;
    }
    toast.success(t('share.sent', { count: delivered.size }));
    router.replace('/');
  }, [client, create, router, selected, t, text]);

  const term = search.term.trim().toLocaleLowerCase();
  const row = (target: Target, avatarSlot?: React.ReactNode) => ({
    ...target.summary,
    id: target.key,
    avatarSlot,
    size: 'sm' as const,
    trailing: 'checkbox' as const,
    selected: selected.has(target.key),
    onSelectedChange: () => toggle(target),
    onPress: () => toggle(target),
  });

  const recent = summaries
    .filter((chat) => sendable.has(chat.id))
    .filter((chat) => (term ? chat.name.toLocaleLowerCase().includes(term) : true))
    .slice(0, term ? undefined : RECENT_LIMIT)
    .map((chat) =>
      row(
        {
          key: `c:${chat.id}`,
          kind: 'conversation',
          id: chat.id,
          summary: { id: chat.id, name: chat.name, avatar: chat.avatar },
        },
        chat.faces && chat.faces.length > 1 ? (
          <GroupAvatar faces={chat.faces} size={36} />
        ) : undefined,
      ),
    );

  const people = search.results
    .filter((person) => person.id !== user?.id)
    .map((person) =>
      row({
        key: `p:${person.id}`,
        kind: 'person',
        id: person.id,
        summary: {
          id: person.id,
          name: person.displayName,
          avatar: person.avatar,
          subtitle: person.handle ? `@${person.handle}` : undefined,
        },
      }),
    );

  const sections: ContactSection[] = [
    ...(recent.length > 0 ? [{ letter: t('share.recent'), contacts: recent }] : []),
    ...(people.length > 0 ? [{ letter: t('share.people'), contacts: people }] : []),
  ];

  const picked = [...selected.values()];

  if (text.length === 0)
    return (
      <Screen scroll="none" header={<PageHeader title={t('share.title')} />}>
        <View style={styles.empty}>
          <ChatEmptyState title={t('share.empty.title')} description={t('share.empty.body')} />
        </View>
      </Screen>
    );

  return (
    // The contact list scrolls itself, under the header the Screen reserves.
    <Screen
      scroll="none"
      header={
        <PageHeader
          title={t('share.title')}
          actions={
            <Button
              size="sm"
              disabled={picked.length === 0}
              loading={busy}
              onPress={() => void submit()}
              tone="accent"
              appearance="solid"
            >
              {t('share.send')}
            </Button>
          }
        />
      }
    >
      <View style={styles.search}>
        <ChatSearchField
          value={search.term}
          onChangeText={search.setTerm}
          onClear={search.clear}
          placeholder={t('share.search')}
          accessibilityLabel={t('share.search')}
          clearLabel={t('chat.new.clearSearch')}
        />
      </View>
      {picked.length > 0 ? (
        <SelectedChipsRow
          style={styles.chips}
          people={picked.map((target) => ({ ...target.summary, id: target.key }))}
          onRemove={remove}
          formatRemoveLabel={(name) => t('chat.new.removePerson', { name })}
        />
      ) : null}
      <ContactList
        style={styles.list}
        sections={sections}
        showIndex={false}
        header={
          <View style={styles.preview}>
            <MessageBubble direction="outgoing" text={text} tail />
          </View>
        }
        footer={
          search.unavailable ? (
            <View style={styles.notice}>
              <ChatEmptyState title={t('share.searchFailed')} />
              <Button size="sm" onPress={search.retry}>
                {t('error.boundary.retry')}
              </Button>
            </View>
          ) : undefined
        }
        emptyState={
          search.searching ? (
            <Loading
              variant="spinner"
              style={styles.searching}
              accessibilityLabel={t('chat.new.searching')}
            />
          ) : (
            <ChatEmptyState
              title={
                search.tooShort
                  ? t('chat.new.tooShort')
                  : search.term
                    ? t('chat.new.noResults')
                    : t('chat.new.hint')
              }
            />
          )
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  // 12, the gutter the conversation list's own search pill sits on.
  search: { paddingHorizontal: 12, paddingBottom: 8 },
  list: { flex: 1, minHeight: 0 },
  searching: { paddingVertical: 32 },
  preview: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 12 },
  // MARGIN, not padding: the scroll layout is a horizontal ScrollView.
  chips: { marginHorizontal: 8, marginBottom: 8 },
  notice: { alignItems: 'center', gap: 12, paddingVertical: 16 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
