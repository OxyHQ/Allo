import React, { useCallback, useMemo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { GlyphButton } from '@oxy.so/bloom/button';
import { ContactRow } from '@oxy.so/bloom/chat-people';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons';
import { Search } from '@oxy.so/bloom/search';
import { SettingsListGroup } from '@oxy.so/bloom/settings-list';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';

import { Page } from '@/components/shell/Page';
import {
  useAddModeratedUser,
  useModeratedUsers,
  useRemoveModeratedUser,
  type ModeratedUser,
} from '@/hooks/usePrivacySettings';
import { useUserSearch, type SearchedUser } from '@/hooks/useUserSearch';
import type { ModerationList } from '@/lib/privacy/api';
import { confirm } from '@oxy.so/bloom/surfaces';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * THE BLOCKED LIST AND THE RESTRICTED LIST, which are one screen.
 *
 * They differ in their endpoint and in four sentences. Everything a reader does
 * with them is identical — see who is on it, put somebody on it, take somebody
 * off it — so a second copy of this file would be a second place the removal
 * confirmation, the failure toast or the empty state could be forgotten. The two
 * route files under `settings/privacy/` supply the difference and nothing else.
 *
 * The list stores Oxy ACCOUNT IDS; the rows show people. An id that resolves to
 * nobody — a deleted account, or one this viewer cannot see — still gets a row,
 * because somebody you cannot see is still somebody you have to be able to
 * unblock.
 */
export interface ModeratedUsersScreenProps {
  list: ModerationList;
  /** The screen's title, and the heading over the list. */
  titleKey: string;
  /** What being on this list means, under the list. */
  descriptionKey: string;
  /** What the field above the search results invites. */
  searchPlaceholderKey: string;
  /** Nobody is on the list. */
  emptyKey: string;
  /** The word on the button that takes somebody off it. */
  removeActionKey: string;
  /** The question asked before doing so. */
  removeConfirmKey: string;
  addedKey: string;
  removedKey: string;
  addFailedKey: string;
  removeFailedKey: string;
  /** Refusing to put yourself on your own list. */
  selfKey: string;
}

export function ModeratedUsersScreen(props: ModeratedUsersScreenProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user: viewer } = useOxy();

  const { users, loading, failed } = useModeratedUsers(props.list);
  const addUser = useAddModeratedUser(props.list);
  const removeUser = useRemoveModeratedUser(props.list);
  const search = useUserSearch();

  /** Who is already on the list, so the search does not offer them again. */
  const alreadyListed = useMemo(() => new Set(users.map((user) => user.id)), [users]);

  const add = useCallback(
    (candidate: SearchedUser) => {
      if (addUser.isPending) return;
      if (candidate.id === viewer?.id) {
        toast.error(t(props.selfKey));
        return;
      }
      addUser.mutate(candidate.id, {
        onSuccess: () => {
          search.clear();
          toast.success(t(props.addedKey));
        },
        onError: (error: unknown) => {
          logger.error(`[Privacy] Could not add to ${props.list}:`, error);
          toast.error(getErrorMessage(error) || t(props.addFailedKey));
        },
      });
    },
    [addUser, props.addFailedKey, props.addedKey, props.list, props.selfKey, search, t, viewer?.id],
  );

  const remove = useCallback(
    async (user: ModeratedUser) => {
      const confirmed = await confirm({
        title: t(props.removeActionKey),
        description: t(props.removeConfirmKey),
        confirmLabel: t(props.removeActionKey),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
      removeUser.mutate(user.id, {
        onSuccess: () => toast.success(t(props.removedKey)),
        onError: (error: unknown) => {
          logger.error(`[Privacy] Could not remove from ${props.list}:`, error);
          toast.error(getErrorMessage(error) || t(props.removeFailedKey));
        },
      });
    },
    [props, removeUser, t],
  );

  const searchResults = search.results.filter((candidate) => !alreadyListed.has(candidate.id));
  const isSearching = search.term.trim().length > 0;

  const note = (key: string) => <Muted style={styles.note}>{t(key)}</Muted>;

  return (
    <Page title={t(props.titleKey)}>
      <Search
        label={t(props.searchPlaceholderKey)}
        value={search.term}
        onChangeText={search.setTerm}
        onClearText={search.clear}
        autoCapitalize="none"
        autoCorrect={false}
      />

      {isSearching ? (
        search.tooShort ? (
          note('settings.privacy.searchTooShort')
        ) : search.searching ? (
          <View style={styles.centred}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : searchResults.length === 0 ? (
          note('settings.privacy.noUsersFound')
        ) : (
          <SettingsListGroup>
            {searchResults.map((candidate) => (
              <ContactRow
                key={candidate.id}
                id={candidate.id}
                name={candidate.displayName}
                avatar={candidate.avatar}
                subtitle={`@${candidate.handle}`}
                actionLabel={t('settings.privacy.add')}
                onAction={() => add(candidate)}
              />
            ))}
          </SettingsListGroup>
        )
      ) : loading ? (
        <View style={styles.centred}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : failed ? (
        note('settings.privacy.loadError')
      ) : users.length === 0 ? (
        <View style={styles.centred}>
          {note(props.emptyKey)}
          {note(props.descriptionKey)}
        </View>
      ) : (
        <SettingsListGroup title={t(props.titleKey)} footer={t(props.descriptionKey)}>
          {users.map((user) => (
            <ContactRow
              key={user.id}
              id={user.id}
              name={user.displayName ?? t('settings.privacy.unknownAccount')}
              avatar={user.avatar}
              subtitle={user.handle ? `@${user.handle}` : user.id}
              trailingSlot={
                <GlyphButton
                  icon={RiCloseCircleLine}
                  color={theme.colors.error}
                  accessibilityLabel={t(props.removeActionKey)}
                  disabled={removeUser.isPending}
                  onPress={() => void remove(user)}
                />
              }
            />
          ))}
        </SettingsListGroup>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  centred: { alignItems: 'center', paddingVertical: 24, gap: 6 },
  note: { textAlign: 'center', paddingVertical: 12 },
});

export default ModeratedUsersScreen;
