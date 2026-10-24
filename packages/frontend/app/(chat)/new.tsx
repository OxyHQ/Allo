import { ConversationAccessState } from '@/lib/allo/ConversationAccessState';
import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services/ui/client';
import { useConversation, useConversationActions } from '@allo/react';
import { Button } from '@oxy.so/bloom/button';
import { ChatSearchField } from '@oxy.so/bloom/chat-list';
import {
  ContactList,
  NewGroupForm,
  SelectedChipsRow,
  type ContactSection,
  type PersonSummary,
} from '@oxy.so/bloom/chat-people';
import { ChatEmptyState } from '@oxy.so/bloom/chat-screen';
import { Loading } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';

import { useCreateConversation } from '@/hooks/useCreateConversation';
import { pickerModeFromParams } from '@/lib/chat/newConversation';
import { useUserSearch, type SearchedUser } from '@/hooks/useUserSearch';
import { logger } from '@/utils/logger';

/** The group name's hard limit AND the counter's denominator — `NewGroupForm` takes one number for both. */
const GROUP_NAME_MAX = 64;

function summaryOf(user: SearchedUser): PersonSummary {
  return {
    id: user.id,
    name: user.displayName,
    avatar: user.avatar,
    subtitle: user.handle ? `@${user.handle}` : undefined,
  };
}

/**
 * `/new` — pick people and start talking: one person is a direct message,
 * several are a group with an optional name. `/new?addTo=<id>` is the same
 * picker adding people to an existing group, and `/new?call=voice` (the Calls
 * page's floating action) the same search picking ONE person to call.
 *
 * Every part of it is Bloom's: the search pill, `ContactList` for the results
 * (one "People" section and the empty state),
 * `SelectedChipsRow` while it is still one person, and `NewGroupForm` once it
 * is a group — that form is where the name and the picked people live, so the
 * chips step aside rather than saying the same thing twice.
 */
export default function NewConversationRoute() {
  const params = useLocalSearchParams<{ addTo?: string; call?: string }>();
  const pickerMode = pickerModeFromParams(params);
  const addTo = pickerMode.kind === 'add' ? pickerMode.conversationId : undefined;
  const callMode = pickerMode.kind === 'call' ? pickerMode.mode : undefined;
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useOxy();
  const group = useConversation(addTo ?? '');
  const { addMember } = useConversationActions();
  const create = useCreateConversation();
  const search = useUserSearch();
  const [selected, setSelected] = useState<ReadonlyMap<string, PersonSummary>>(new Map());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const adding = Boolean(addTo);
  const excluded = new Set([user?.id, ...(group?.memberAccountIds ?? [])]);

  const toggle = useCallback((person: PersonSummary) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(person.id)) next.delete(person.id);
      else next.set(person.id, person);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    const ids = [...selected.keys()];
    if (ids.length === 0) return;
    setBusy(true);
    try {
      if (addTo) {
        for (const id of ids) await addMember(addTo, id);
        toast.success(t('chat.group.memberAdded'));
        router.back();
      } else {
        const conversationId = await create({ participantIds: ids, name });
        router.replace(`/c/${conversationId}`);
      }
    } catch (error) {
      logger.error('[NewConversation] failed', error);
      toast.error(adding ? t('chat.group.addFailed') : t('chat.new.failed'));
    } finally {
      setBusy(false);
    }
  }, [addMember, addTo, adding, create, name, router, selected, t]);

  /**
   * Call mode: one person, pressed once. The DM is opened (created if it is
   * new — idempotent on the server) and the CALL ROUTE replaces this picker;
   * the route is what dials (`/c/:id/call` is the app's one dialler), so
   * nothing here calls `start`.
   */
  const call = useCallback(
    async (person: PersonSummary) => {
      if (!callMode || busy) return;
      setBusy(true);
      try {
        const conversationId = await create({ participantIds: [person.id], name: undefined });
        router.replace(`/c/${conversationId}/call?mode=${callMode}`);
      } catch (error) {
        logger.error('[NewCall] failed', error);
        toast.error(t('calls.new.failed'));
      } finally {
        setBusy(false);
      }
    },
    [busy, callMode, create, router, t],
  );

  const picked = [...selected.values()];
  const count = picked.length;
  /** Two or more people are a group, and a group gets a name — but not when adding to one that exists. */
  const naming = !adding && count > 1;
  const removeLabel = (who: string) => t('chat.new.removePerson', { name: who });

  // The directory's relevance order, untouched: Allo has no address book, so
  // these are search results, not contacts to file under A–Z. One section, no
  // index rail (`lib/people/directorySearch.ts` says who may appear at all).
  const people = search.results
    .filter((result) => !excluded.has(result.id))
    .map((result): ContactSection['contacts'][number] => {
      const person = summaryOf(result);
      if (callMode)
        return {
          ...person,
          size: 'sm' as const,
          trailing: 'action' as const,
          actionLabel: t('calls.new.action'),
          onAction: () => void call(person),
          onPress: () => void call(person),
          disabled: busy,
        };
      return {
        ...person,
        size: 'sm' as const,
        trailing: 'checkbox' as const,
        selected: selected.has(person.id),
        onSelectedChange: () => toggle(person),
        onPress: () => toggle(person),
      };
    });
  // Search results in the directory's (relevance) order: one flat section.
  const sections: ContactSection[] = people.length > 0 ? [{ letter: '', contacts: people }] : [];

  const submitLabel = adding
    ? t('chat.group.addMember')
    : count > 1
      ? t('chat.new.createGroup')
      : t('chat.new.start');

  if (search.unavailable)
    return (
      <Screen scroll="none" header={<PageHeader title={t('chat.new.title')} />}>
        <ConversationAccessState state="unavailable" onRetry={search.retry} />
      </Screen>
    );

  return (
    // The contact list scrolls itself, under the header the Screen reserves.
    <Screen
      scroll="none"
      header={
        <PageHeader
          title={
            callMode
              ? t('calls.new.title')
              : adding
                ? t('chat.group.addMember')
                : t('chat.new.title')
          }
          actions={
            callMode ? undefined : (
              <Button
                size="sm"
                disabled={count === 0}
                loading={busy}
                onPress={() => void submit()}
                tone="accent"
                appearance="solid"
              >
                {submitLabel}
              </Button>
            )
          }
        />
      }
    >
      <View style={styles.search}>
        <ChatSearchField
          value={search.term}
          onChangeText={search.setTerm}
          onClear={search.clear}
          placeholder={t('chat.new.search')}
          accessibilityLabel={t('chat.new.search')}
          clearLabel={t('chat.new.clearSearch')}
          autoFocus
        />
      </View>
      <ContactList
        style={styles.list}
        sections={sections}
        layout="flat"
        flatLabel={t('chat.new.people')}
        header={
          callMode ? undefined : naming ? (
            <NewGroupForm
              style={styles.form}
              name={name}
              onNameChange={setName}
              nameMaxLength={GROUP_NAME_MAX}
              members={picked}
              onRemoveMember={remove}
              labels={{
                name: t('chat.group.name'),
                namePlaceholder: t('chat.new.groupNamePlaceholder'),
                members: (of) => t('chat.new.selected', { count: of }),
                remove: removeLabel,
              }}
            />
          ) : count > 0 ? (
            <SelectedChipsRow
              style={styles.chips}
              people={picked}
              onRemove={remove}
              formatRemoveLabel={removeLabel}
            />
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
  form: { paddingTop: 4, paddingHorizontal: 12, paddingBottom: 12 },
  // MARGIN, not padding: the scroll layout is a horizontal ScrollView, and
  // padding on a scroller is space the content slides under.
  chips: { marginHorizontal: 8, marginBottom: 8 },
});
