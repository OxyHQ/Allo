import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { useConversation, useConversationActions } from '@allo/react';
import { Button } from '@oxy.so/bloom/button';
import { ChatSearchField } from '@oxy.so/bloom/chat-list';
import {
  CONTACT_ALPHABET,
  ContactList,
  NewGroupForm,
  SelectedChipsRow,
  type ContactRowProps,
  type ContactSection,
  type PersonSummary,
} from '@oxy.so/bloom/chat-people';
import { ChatEmptyState } from '@oxy.so/bloom/chat-screen';
import { toast } from '@oxy.so/bloom/toast';

import { Page } from '@/components/shell/Page';
import { useCreateConversation } from '@/hooks/useCreateConversation';
import { useUserSearch, type SearchedUser } from '@/hooks/useUserSearch';
import { logger } from '@/utils/logger';

/** The group name's hard limit AND the counter's denominator — `NewGroupForm` takes one number for both. */
const GROUP_NAME_MAX = 64;

function summaryOf(user: SearchedUser): PersonSummary {
  return { id: user.id, name: user.displayName, avatar: user.avatar, subtitle: user.handle ? `@${user.handle}` : undefined };
}

/**
 * Which bucket of the rail a name falls in: its first letter, `#` for
 * everything else.
 *
 * Accents are folded first, so "Ángel" sits under A with every other Ángel
 * rather than alone at the bottom of the list under `#` — the rail is how a
 * reader finds a person, and a name they would spell with an A must be where
 * they look for it.
 */
function sectionLetterOf(name: string): string {
  const first = name.trim().normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
  return first >= 'A' && first <= 'Z' ? first : '#';
}

/** The results as `ContactList` sections: one per first letter, A–Z then `#`, each sorted by name. */
function contactSections(contacts: readonly ContactRowProps[]): ContactSection[] {
  const buckets = new Map<string, ContactRowProps[]>();
  for (const contact of contacts) {
    const letter = sectionLetterOf(contact.name);
    const bucket = buckets.get(letter);
    if (bucket === undefined) buckets.set(letter, [contact]);
    else bucket.push(contact);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => CONTACT_ALPHABET.indexOf(a) - CONTACT_ALPHABET.indexOf(b))
    .map(([letter, people]) => ({
      letter,
      contacts: [...people].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

/**
 * `/new` — pick people and start talking: one person is a direct message,
 * several are a group with an optional name. `/new?addTo=<id>` is the same
 * picker adding people to an existing group.
 *
 * Every part of it is Bloom's: the search pill, `ContactList` for the results
 * (A–Z sections, pinned headings, the index rail, the empty state),
 * `SelectedChipsRow` while it is still one person, and `NewGroupForm` once it
 * is a group — that form is where the name and the picked people live, so the
 * chips step aside rather than saying the same thing twice.
 */
export default function NewConversationRoute() {
  const { addTo } = useLocalSearchParams<{ addTo?: string }>();
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

  const picked = [...selected.values()];
  const count = picked.length;
  /** Two or more people are a group, and a group gets a name — but not when adding to one that exists. */
  const naming = !adding && count > 1;
  const removeLabel = (who: string) => t('chat.new.removePerson', { name: who });

  const sections = contactSections(
    search.results
      .filter((result) => !excluded.has(result.id))
      .map((result) => {
        const person = summaryOf(result);
        return {
          ...person,
          size: 'small' as const,
          trailing: 'checkbox' as const,
          selected: selected.has(person.id),
          onSelectedChange: () => toggle(person),
          onPress: () => toggle(person),
        };
      }),
  );

  const submitLabel = adding ? t('chat.group.addMember') : count > 1 ? t('chat.new.createGroup') : t('chat.new.start');

  return (
    <Page
      title={adding ? t('chat.group.addMember') : t('chat.new.title')}
      back="always"
      scroll={false}
      actions={
        <Button variant="primary" size="small" disabled={count === 0} loading={busy} onPress={() => void submit()}>
          {submitLabel}
        </Button>
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
        indexLetters={CONTACT_ALPHABET}
        formatJumpLabel={(letter) => t('chat.new.jumpTo', { letter })}
        header={
          naming ? (
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
            <SelectedChipsRow style={styles.chips} people={picked} onRemove={remove} formatRemoveLabel={removeLabel} />
          ) : undefined
        }
        emptyState={
          search.searching ? undefined : (
            <ChatEmptyState
              title={search.tooShort ? t('chat.new.tooShort') : search.term ? t('chat.new.noResults') : t('chat.new.hint')}
            />
          )
        }
      />
    </Page>
  );
}

const styles = StyleSheet.create({
  // 12, the gutter the conversation list's own search pill sits on.
  search: { paddingHorizontal: 12, paddingBottom: 8 },
  list: { flex: 1, minHeight: 0 },
  form: { paddingTop: 4, paddingHorizontal: 12, paddingBottom: 12 },
  // MARGIN, not padding: the scroll layout is a horizontal ScrollView, and
  // padding on a scroller is space the content slides under.
  chips: { marginHorizontal: 8, marginBottom: 8 },
});
