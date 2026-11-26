import { Button } from '@oxy.so/bloom/button';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { useOxy } from '@oxy.so/services/ui/client';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet } from 'react-native';

import {
  useBlockedUsers,
  useBlockUser,
  useUnblockUser,
  type BlockedUser,
} from '@/hooks/usePrivacySettings';
import { useUserSearch, type SearchedUser } from '@/hooks/useUserSearch';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';
import { confirm } from '@oxy.so/bloom/surfaces';

import {
  Card as LCard,
  Embed,
  List as LList,
  Search as LSearch,
  SettingsSection as LSettingsSection,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

/**
 * THE PEOPLE THIS ACCOUNT HAS BLOCKED: see who is on the list, put somebody on
 * it, take somebody off it.
 *
 * A block is enforced by the server in both directions: no new direct messages,
 * no conversation invitations and no presence. History and existing shared
 * groups are kept.
 *
 * The list stores Oxy ACCOUNT IDS; the rows show people. An id that resolves to
 * nobody — a deleted account, or one this viewer cannot see — still gets a row,
 * because somebody you cannot see is still somebody you have to be able to
 * unblock.
 */
export default function BlockedUsersScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user: viewer } = useOxy();

  const { users, loading, failed } = useBlockedUsers();
  const addUser = useBlockUser();
  const removeUser = useUnblockUser();
  const search = useUserSearch();

  /** Who is already on the list, so the search does not offer them again. */
  const alreadyListed = useMemo(() => new Set(users.map((user) => user.id)), [users]);

  const add = useCallback(
    (candidate: SearchedUser) => {
      if (addUser.isPending) return;
      if (candidate.id === viewer?.id) {
        toast.error(t('settings.privacy.cannotBlockYourself'));
        return;
      }
      addUser.mutate(candidate.id, {
        onSuccess: () => {
          search.clear();
          toast.success(t('settings.privacy.userBlocked'));
        },
        onError: (error: unknown) => {
          logger.error('[Privacy] Could not block:', error);
          toast.error(getErrorMessage(error) || t('settings.privacy.failedToBlockUser'));
        },
      });
    },
    [addUser, search, t, viewer?.id],
  );

  const remove = useCallback(
    async (user: BlockedUser) => {
      const confirmed = await confirm({
        title: t('settings.privacy.unblock'),
        description: t('settings.privacy.unblockUserConfirm'),
        confirmLabel: t('settings.privacy.unblock'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
      removeUser.mutate(user.id, {
        onSuccess: () => toast.success(t('settings.privacy.userUnblocked')),
        onError: (error: unknown) => {
          logger.error('[Privacy] Could not unblock:', error);
          toast.error(getErrorMessage(error) || t('settings.privacy.failedToUnblockUser'));
        },
      });
    },
    [removeUser, t],
  );

  const searchResults = search.results.filter((candidate) => !alreadyListed.has(candidate.id));
  const isSearching = search.term.trim().length > 0;

  const note = (key: string) => <Muted style={styles.note}>{t(key)}</Muted>;

  return (
    <>
      {toElement(
        LSearch([search.term, search.setTerm])
          .label(t('settings.privacy.searchUsersToBlock'))
          .onClearText(search.clear)
          .autocapitalize('none')
          .autocorrect(false),
      )}
      {isSearching
        ? search.tooShort
          ? note('settings.privacy.searchTooShort')
          : search.searching
            ? toElement(
                VStack(Embed(<ActivityIndicator color={theme.colors.primary} />))
                  .padding('vertical', '2xl')
                  .align('center')
                  .spacing('6'),
              )
            : searchResults.length === 0
              ? note('settings.privacy.noUsersFound')
              : toElement(
                  LSettingsSection(
                    undefined,
                    LCard(
                      LList(
                        searchResults.map((candidate) => ({
                          id: candidate.id,
                          person: {
                            name: candidate.displayName,
                            avatar: candidate.avatar,
                            subtitle: `@${candidate.handle}`,
                            actionLabel: t('settings.privacy.add'),
                            onAction: () => add(candidate),
                          },
                          disabled: addUser.isPending,
                        })),
                      ),
                    ),
                  ),
                )
        : loading
          ? toElement(
              VStack(Embed(<ActivityIndicator color={theme.colors.primary} />))
                .padding('vertical', '2xl')
                .align('center')
                .spacing('6'),
            )
          : failed
            ? note('settings.privacy.loadError')
            : users.length === 0
              ? toElement(
                  VStack(
                    Embed(note('settings.privacy.noBlockedUsers')),
                    Embed(note('settings.privacy.blockedUsersDescription')),
                  )
                    .padding('vertical', '2xl')
                    .align('center')
                    .spacing('6'),
                )
              : toElement(
                  LSettingsSection(
                    t('settings.privacy.blockedUsers'),
                    LCard(
                      LList(
                        users.map((user) => ({
                          id: user.id,
                          person: {
                            name: user.displayName ?? t('settings.privacy.unknownAccount'),
                            avatar: user.avatar,
                            subtitle: user.handle ? `@${user.handle}` : user.id,
                          },
                          trailing: (
                            <Button
                              iconOnly
                              appearance="plain"
                              icon={RiCloseCircleLine}
                              tone="danger"
                              accessibilityLabel={t('settings.privacy.unblock')}
                              disabled={removeUser.isPending}
                              onPress={() => void remove(user)}
                            />
                          ),
                        })),
                      ),
                    ),
                  ).description(t('settings.privacy.blockedUsersDescription')),
                )}
    </>
  );
}

const styles = StyleSheet.create({
  note: { textAlign: 'center', paddingVertical: 12 },
});
