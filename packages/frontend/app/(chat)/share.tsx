import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services/ui/client';
import { useAlloClient, useConversations } from '@allo/react';
import { AvatarGroup } from '@oxy.so/bloom/avatar-group';
import type { ListEntry, ListSection } from '@oxy.so/bloom/list';
import { SelectedChipsRow, type PersonSummary } from '@oxy.so/bloom/chat-people';
import { MessageBubble } from '@oxy.so/bloom/message-bubble';
import { toast } from '@oxy.so/bloom/toast';

import { useChatSummaries } from '@/hooks/useChatSummaries';
import { useCreateConversation } from '@/hooks/useCreateConversation';
import { useUserSearch } from '@/hooks/useUserSearch';
import { shareTextFromParam } from '@/lib/chat/shareText';
import { logger } from '@/utils/logger';

import {
  Button as LButton,
  ChatEmptyState as LChatEmptyState,
  ChatSearchField as LChatSearchField,
  Embed,
  Group,
  Header,
  Loading,
  SectionedList,
  Text,
  VStack,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

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
export default screen(function ShareRoute() {
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
  const row = (target: Target, leading?: React.ReactNode): ListEntry => ({
    person: target.summary,
    id: target.key,
    leading,
    checked: selected.has(target.key),
    onCheckedChange: () => toggle(target),
    selecting: true,
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
          // A row's slot takes an element: Bloom's AvatarGroup itself, no language root per row.
          <AvatarGroup
            layout="conversation"
            items={chat.faces.map((face) => ({ ...face, uri: face.source }))}
            size={36}
          />
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

  const sections: ListSection[] = [
    ...(recent.length > 0 ? [{ id: 'recent', title: t('share.recent'), items: recent }] : []),
    ...(people.length > 0 ? [{ id: 'people', title: t('share.people'), items: people }] : []),
  ];

  const picked = [...selected.values()];

  if (text.length === 0)
    return VStack(
      LChatEmptyState({ title: t('share.empty.title'), description: t('share.empty.body') }),
    )
      .padding('all', '2xl')
      .align('center')
      .justify('center')
      .grow()
      .screenScroll('none')
      .header(Header(t('share.title')).inPage());

  return Group(
    VStack(
      LChatSearchField([search.term, search.setTerm], {
        placeholder: t('share.search'),
        clearLabel: t('chat.new.clearSearch'),
        onClear: search.clear,
      }).label(t('share.search')),
    )
      .padding('horizontal', 'md')
      .padding('bottom', 'sm'),
    picked.length > 0
      ? Embed(
          <SelectedChipsRow
            style={styles.chips}
            people={picked.map((target) => ({ ...target.summary, id: target.key }))}
            onRemove={remove}
            formatRemoveLabel={(name) => t('chat.new.removePerson', { name })}
          />,
        )
      : null,
    SectionedList(sections)
      .testID('share-targets')
      .scrollable()
      .headerContent(
        VStack(Embed(<MessageBubble direction="outgoing" text={text} tail />))
          .padding('horizontal', 'md')
          .padding('top', 'xs')
          .padding('bottom', 'md'),
      )
      .footerContent(
        search.unavailable
          ? VStack(
              LChatEmptyState({ title: t('share.searchFailed') }),
              LButton(Text(t('error.boundary.retry')))
                .size('sm')
                .onPress(search.retry),
            )
              .padding('vertical', 'lg')
              .align('center')
              .spacing('md')
          : undefined,
      )
      .emptyState(
        search.searching
          ? Loading().style('spinner').label(t('chat.new.searching')).padding('vertical', '3xl')
          : LChatEmptyState({
              title: search.tooShort
                ? t('chat.new.tooShort')
                : search.term
                  ? t('chat.new.noResults')
                  : t('chat.new.hint'),
            }),
      )
      .frame({ minHeight: 'none' })
      .grow(),
  )
    .screenScroll('none')
    .header(
      Header(t('share.title'))
        .toolbar(
          LButton(Text(t('share.send')))
            .disabled(picked.length === 0)
            .loading(busy)
            .onPress(() => void submit())
            .tint('accent')
            .style('solid'),
        )
        .inPage(),
    );
});

const styles = StyleSheet.create({
  // MARGIN, not padding: the scroll layout is a horizontal ScrollView.
  chips: { marginHorizontal: 8, marginBottom: 8 },
});
