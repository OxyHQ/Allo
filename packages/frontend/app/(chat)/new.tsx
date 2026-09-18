import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { useConversation, useConversationActions } from '@allo/react';
import { Button } from '@oxy.so/bloom/button';
import { ChatSearchField } from '@oxy.so/bloom/chat-list';
import { ContactRow, SelectedChipsRow, type PersonSummary } from '@oxy.so/bloom/chat-people';
import { ChatEmptyState } from '@oxy.so/bloom/chat-screen';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';

import { Page } from '@/components/shell/Page';
import { useCreateConversation } from '@/hooks/useCreateConversation';
import { useUserSearch, type SearchedUser } from '@/hooks/useUserSearch';
import { logger } from '@/utils/logger';

function summaryOf(user: SearchedUser): PersonSummary {
  return { id: user.id, name: user.displayName, avatar: user.avatar, subtitle: user.handle ? `@${user.handle}` : undefined };
}

/**
 * `/new` — pick people and start talking: one person is a direct message,
 * several are a group with an optional name. `/new?addTo=<id>` is the same
 * picker adding people to an existing group.
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
  const results = search.results.filter((result) => !excluded.has(result.id));

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

  const count = selected.size;
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
      <View style={styles.controls}>
        <ChatSearchField
          value={search.term}
          onChangeText={search.setTerm}
          onClear={search.clear}
          placeholder={t('chat.new.search')}
          autoFocus
        />
        {count > 0 && <SelectedChipsRow people={[...selected.values()]} onRemove={remove} />}
        {!adding && count > 1 && (
          <TextFieldInput label={t('chat.group.name')} value={name} onChangeText={setName} maxLength={128} />
        )}
      </View>
      <FlatList
        data={results}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const person = summaryOf(item);
          return (
            <ContactRow
              {...person}
              trailing="checkbox"
              selected={selected.has(item.id)}
              onSelectedChange={() => toggle(person)}
              onPress={() => toggle(person)}
            />
          );
        }}
        ListEmptyComponent={
          search.searching ? null : (
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
  controls: { paddingHorizontal: 16, paddingBottom: 8, gap: 12 },
});
