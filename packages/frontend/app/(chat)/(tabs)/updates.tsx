import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services/ui/client';
import { useStatuses } from '@allo/react';
import { StoryRing } from '@oxy.so/bloom/chat-indicators';
import { List } from '@oxy.so/bloom/list';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';

import { StoriesStrip } from '@/components/phase2/StoriesStrip';
import { useChatContext } from '@/hooks/useChatContext';
import { usePostStatus } from '@/hooks/usePostStatus';
import { ringState, statusAgeLabel, statusAuthors, statusRemainingLabel } from '@/lib/statuses';
import { confirm } from '@oxy.so/bloom/surfaces';
import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { logger } from '@/utils/logger';

import { Avatar as LAvatar, Embed, Header, ScrollView, toElement } from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

/**
 * `/updates` — STATUS UPDATES.
 *
 * The route is `/updates`, not `/status`: Metro's dev server answers `/status`
 * itself with `packager-status:running`, so the screen could never be opened or
 * refreshed by URL while developing. The words on screen are still "Status".
 *
 * Bloom's `StoriesRow` at the top, then every person with updates as a row
 * with their own `StoryRing`; opening one pushes the viewer
 * (`/updates/:accountId`). Adding your own (the "My status" ring, or the
 * floating action while this page is in front) is `usePostStatus`: the app's
 * existing picker, the same one the composer uses.
 *
 * **What this posts is end-to-end encrypted** (ADR 0002): one ciphertext, a
 * key sealed to each recipient's devices, twenty-four hours. The audience is
 * resolved on THIS device — everybody it shares a conversation with — so the
 * server is never asked for a contact list and never sees the words or the
 * picture. What it does see is which devices a status was sealed to, because
 * that is how it delivers.
 *
 * The viewer still has no reply field: a reply has nowhere to go in this
 * platform, and a field that accepts one and drops it is the lie this screen
 * is written to avoid.
 */
export default screen(function UpdatesScreen() {
  const { t } = useTranslation();
  const { user } = useOxy();
  const router = useRouter();
  const statuses = useStatuses();

  const authors = useMemo(() => statusAuthors(statuses.all), [statuses.all]);
  const accountIds = useMemo(() => authors.map((author) => author.accountId), [authors]);
  const { person, now } = useChatContext(accountIds);

  // Opening is all the viewer needs; telling the author it was seen happens
  // there, as each update is actually advanced past.
  const open = useCallback((accountId: string) => router.push(`/updates/${accountId}`), [router]);

  const me = user?.id;
  // The same post the floating action makes while this page is in front.
  const post = usePostStatus();
  const add = useCallback(() => {
    if (me) void post();
  }, [me, post]);

  /** Taking one of yours down early. A long press, and a confirmation. */
  const remove = useCallback(
    async (statusId: string) => {
      const ok = await confirm({
        title: t('stories.remove.title'),
        description: t('stories.remove.confirm'),
        confirmLabel: t('stories.remove.action'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await statuses.remove(statusId);
      } catch (error: unknown) {
        logger.error('[updates] could not take one down', error);
        toast.error(t('stories.removeFailed'));
      }
    },
    [statuses, t],
  );

  return ScrollView(
    Embed(
      <View style={styles.strip}>
        <StoriesStrip ownAccountId={me} onStoryPress={open} onOwnPress={add} />
      </View>,
    ),
    Embed(
      <List
        sections={[
          {
            id: 'recent',
            title: t('stories.recent'),
            items: authors.map((author) => {
              const who = person(author.accountId);
              const name = author.mine
                ? t('stories.own')
                : (who?.displayName ?? t('stories.someone'));
              return {
                id: author.accountId,
                title: name,
                supporting: t('stories.updateCount', {
                  count: author.statuses.length,
                  age: statusAgeLabel(author.statuses[0].createdAt, now, t),
                }),
                leading: (
                  <StoryRing state={ringState(author)} size={36}>
                    {toElement(LAvatar(who?.avatar, { name: name }).size('lg'))}
                  </StoryRing>
                ),
                onPress: () => open(author.accountId),
                onLongPress: author.mine ? () => void remove(author.statuses[0].id) : undefined,
                label: t('stories.openOf', { name }),
              };
            }),
          },
        ]}
        empty={<Muted style={styles.empty}>{t('stories.empty')}</Muted>}
      />,
    ),
    Embed(
      <Muted style={styles.expiry}>
        {authors[0]?.mine
          ? t('stories.yoursExpire', {
              remaining: statusRemainingLabel(authors[0].statuses[0].expiresAt, now, t),
            })
          : t('stories.expiry')}
      </Muted>,
    ),
  )
    .keyboardTaps('handled')
    .contentView((v) => v.padding('horizontal', 'lg').padding('bottom', '3xl').spacing('lg'))
    .screenScroll('content')
    .header(
      Header(t('stories.title'))
        .toolbarLeading(Embed(<AppShellMenuButton accessibilityLabel={t('navigation.open')} />))
        .inPage(),
    );
});

const styles = StyleSheet.create({
  strip: { marginHorizontal: -16 },
  empty: { paddingVertical: 16 },
  expiry: { paddingTop: 8 },
});
