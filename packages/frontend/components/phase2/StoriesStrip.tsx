import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StoriesRow, type StoryEntry } from '@oxy.so/bloom/chat-list';

import { useStatuses } from '@allo/react';

import { useChatContext } from '@/hooks/useChatContext';
import { ringState, statusAuthors } from '@/lib/statuses';

interface StoriesStripProps {
  /** The signed-in account, drawn first with the `+` badge. */
  ownAccountId: string | undefined;
  /** Somebody else's ring was pressed. */
  onStoryPress: (accountId: string) => void;
  /** The `+` was pressed: add to your own story. */
  onOwnPress: () => void;
}

/**
 * THE STATUS STRIP — Bloom's `StoriesRow` over the SDK's status updates.
 *
 * It is its own component rather than part of the updates screen because the
 * conversation list is the other place it belongs, and it is drawn in both:
 * `/updates` puts it above the list of updates, and `ConversationList` hands it
 * to `ChatList` as the `header`.
 *
 * Bloom decides the order (unseen first, a stable sort) and the geometry; this
 * decides who is in it, what their ring is, and the words. Names come through
 * the people layer, so a person still being looked up draws with whatever the
 * layer has rather than an account id.
 */
export function StoriesStrip({ ownAccountId, onStoryPress, onOwnPress }: StoriesStripProps) {
  const { t } = useTranslation();
  const statuses = useStatuses();
  const authors = useMemo(() => statusAuthors(statuses.all), [statuses.all]);
  const others = useMemo(() => authors.filter((author) => author.accountId !== ownAccountId), [authors, ownAccountId]);

  const accountIds = useMemo(
    () => (ownAccountId ? [...others.map((a) => a.accountId), ownAccountId] : others.map((a) => a.accountId)),
    [others, ownAccountId],
  );
  const { person } = useChatContext(accountIds);

  const stories = useMemo<StoryEntry[]>(
    () =>
      others.map((author) => ({
        id: author.accountId,
        name: person(author.accountId)?.displayName ?? t('stories.someone'),
        avatar: person(author.accountId)?.avatar,
        state: ringState(author),
      })),
    [others, person, t],
  );

  const own = useMemo(
    () => ({
      avatar: ownAccountId ? person(ownAccountId)?.avatar : undefined,
      state: ringState(authors.find((author) => author.accountId === ownAccountId)),
    }),
    [authors, ownAccountId, person],
  );

  return (
    <StoriesRow
      stories={stories}
      own={own}
      onStoryPress={onStoryPress}
      onOwnPress={onOwnPress}
      accessibilityLabel={t('stories.row')}
      labels={{
        own: t('stories.own'),
        add: t('stories.add'),
      }}
    />
  );
}
