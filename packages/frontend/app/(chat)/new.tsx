import { ConversationAccessState } from '@/lib/allo/ConversationAccessState';
import { useCallback, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services/ui/client';
import { useConversation, useConversationActions } from '@allo/react';
import type { PersonSummary } from '@oxy.so/bloom/chat-people';
import type { ListEntry } from '@oxy.so/bloom/list';
import { toast } from '@oxy.so/bloom/toast';

import { useCreateConversation } from '@/hooks/useCreateConversation';
import { pickerModeFromParams } from '@/lib/chat/newConversation';
import { useUserSearch, type SearchedUser } from '@/hooks/useUserSearch';
import { logger } from '@/utils/logger';

import {
  Button as LButton,
  Embed,
  Group,
  Header,
  Loading,
  Text,
  VStack,
} from '@oxy.so/bloom-language';
import {
  ChatEmptyState as LChatEmptyState,
  ChatSearchField as LChatSearchField,
} from '@oxy.so/bloom-language/chat';
import {
  NewGroupForm as LNewGroupForm,
  SelectedChipsRow as LSelectedChipsRow,
} from '@oxy.so/bloom-language/chat-people';
import { SectionedList } from '@oxy.so/bloom-language/list';
import { screen } from '@oxy.so/bloom-language/router';

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
 * Every part of it is Bloom's: the search pill, `List` for the results
 * (one "People" section and the empty state),
 * `SelectedChipsRow` while it is still one person, and `NewGroupForm` once it
 * is a group — that form is where the name and the picked people live, so the
 * chips step aside rather than saying the same thing twice.
 */
export default screen(function NewConversationRoute() {
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
    .map((result): ListEntry => {
      const person = summaryOf(result);
      if (callMode)
        return {
          id: person.id,
          person: {
            ...person,
            actionLabel: t('calls.new.action'),
            onAction: () => void call(person),
          },
          onPress: () => void call(person),
          disabled: busy,
        };
      return {
        id: person.id,
        person,
        checked: selected.has(person.id),
        onCheckedChange: () => toggle(person),
        selecting: true,
        onPress: () => toggle(person),
      };
    });

  const submitLabel = adding
    ? t('chat.group.addMember')
    : count > 1
      ? t('chat.new.createGroup')
      : t('chat.new.start');

  if (search.unavailable)
    return Embed(<ConversationAccessState state="unavailable" onRetry={search.retry} />)
      .screenScroll('none')
      .header(Header(t('chat.new.title')).inPage());

  return Group(
    VStack(
      LChatSearchField([search.term, search.setTerm], {
        placeholder: t('chat.new.search'),
        clearLabel: t('chat.new.clearSearch'),
        onClear: search.clear,
        autoFocus: true,
      }).label(t('chat.new.search')),
    )
      .padding('horizontal', 'md')
      .padding('bottom', 'sm'),
    SectionedList([{ id: 'people', title: t('chat.new.people'), items: people }])
      .testID('people-picker')
      .scrollable()
      .headerContent(
        callMode
          ? undefined
          : naming
            ? LNewGroupForm([name, setName], {
                nameMaxLength: GROUP_NAME_MAX,
                members: picked,
                onRemoveMember: remove,
                labels: {
                  name: t('chat.group.name'),
                  namePlaceholder: t('chat.new.groupNamePlaceholder'),
                  members: (of) => t('chat.new.selected', { count: of }),
                  remove: removeLabel,
                },
              })
                .padding('top', 'xs')
                .padding('horizontal', 'md')
                .padding('bottom', 'md')
            : count > 0
              ? // Margin, not padding: the scroll layout is a horizontal ScrollView, and
                // padding on a scroller is space the content slides under.
                LSelectedChipsRow(picked, { onRemove: remove, formatRemoveLabel: removeLabel })
                  .margin('horizontal', 'sm')
                  .margin('bottom', 'sm')
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
      Header(
        callMode ? t('calls.new.title') : adding ? t('chat.group.addMember') : t('chat.new.title'),
      )
        .toolbar(
          callMode
            ? null
            : LButton(Text(submitLabel))
                .disabled(count === 0)
                .loading(busy)
                .onPress(() => void submit())
                .tint('accent')
                .style('solid'),
        )
        .inPage(),
    );
});
