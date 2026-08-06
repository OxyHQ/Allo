import React, { useCallback, useMemo } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { Search } from '@oxyhq/bloom';
import { Button } from '@oxyhq/bloom/button';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { toast } from '@oxyhq/bloom/toast';
import { useOxy } from '@oxyhq/services';

import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import Avatar from '@/components/Avatar';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { EmptyState } from '@/components/shared/EmptyState';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import {
  useAddModeratedUser,
  useModeratedUsers,
  useRemoveModeratedUser,
  type ModeratedUser,
} from '@/hooks/usePrivacySettings';
import { useTheme } from '@/hooks/useTheme';
import { useUserSearch, type SearchedUser } from '@/hooks/useUserSearch';
import type { ModerationList } from '@/lib/privacy/api';
import { confirmDialog } from '@/utils/alerts';
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
      const confirmed = await confirmDialog({
        title: t(props.removeActionKey),
        message: t(props.removeConfirmKey),
        okText: t(props.removeActionKey),
        cancelText: t('common.cancel'),
        destructive: true,
      });
      if (!confirmed) return;

      removeUser.mutate(user.id, {
        onSuccess: () => {
          toast.success(t(props.removedKey));
        },
        onError: (error: unknown) => {
          logger.error(`[Privacy] Could not remove from ${props.list}:`, error);
          toast.error(getErrorMessage(error) || t(props.removeFailedKey));
        },
      });
    },
    [props, removeUser, t],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        searchField: {
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 4,
        },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        rowText: {
          flex: 1,
          marginLeft: 12,
        },
        name: {
          fontSize: 16,
          fontWeight: '500',
          color: theme.colors.text,
        },
        handle: {
          fontSize: 14,
          color: theme.colors.textSecondary,
          marginTop: 2,
        },
        centred: {
          alignItems: 'center',
          paddingVertical: 24,
        },
      }),
    [theme],
  );

  const searchResults = search.results.filter((candidate) => !alreadyListed.has(candidate.id));
  const isSearching = search.term.trim().length > 0;

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t(props.titleKey),
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <View style={styles.searchField}>
        <Search
          placeholder={t(props.searchPlaceholderKey)}
          value={search.term}
          onChangeText={search.setTerm}
          onClearText={search.clear}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <ScrollView className="flex-1" contentContainerClassName="pb-6" keyboardShouldPersistTaps="handled">
        {isSearching ? (
          search.tooShort ? (
            <View style={styles.centred}>
              <ThemedText style={styles.handle}>
                {t('settings.privacy.searchTooShort')}
              </ThemedText>
            </View>
          ) : search.searching ? (
            <View style={styles.centred}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
          ) : searchResults.length === 0 ? (
            <View style={styles.centred}>
              <ThemedText style={styles.handle}>{t('settings.privacy.noUsersFound')}</ThemedText>
            </View>
          ) : (
            searchResults.map((candidate) => (
              <View key={candidate.id} style={styles.row}>
                <Avatar
                  size={40}
                  source={candidate.avatar ? { uri: candidate.avatar } : undefined}
                  label={candidate.displayName.charAt(0).toUpperCase()}
                />
                <View style={styles.rowText}>
                  <ThemedText style={styles.name} numberOfLines={1}>
                    {candidate.displayName}
                  </ThemedText>
                  <ThemedText style={styles.handle} numberOfLines={1}>
                    @{candidate.handle}
                  </ThemedText>
                </View>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={addUser.isPending}
                  onPress={() => add(candidate)}
                >
                  {t('settings.privacy.add')}
                </Button>
              </View>
            ))
          )
        ) : loading ? (
          <View style={styles.centred}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : failed ? (
          <View style={styles.centred}>
            <ThemedText style={styles.handle}>{t('settings.privacy.loadError')}</ThemedText>
          </View>
        ) : users.length === 0 ? (
          <EmptyState
            lottieSource={require('@/assets/lottie/welcome.json')}
            title={t(props.emptyKey)}
            subtitle={t(props.descriptionKey)}
          />
        ) : (
          <View className="px-4 pt-4">
            <SettingsListGroup title={t(props.titleKey)} footer={t(props.descriptionKey)}>
              {users.map((user) => (
                <SettingsListItem
                  key={user.id}
                  icon={
                    <Avatar
                      size={28}
                      source={user.avatar ? { uri: user.avatar } : undefined}
                      label={(user.displayName ?? user.id).charAt(0).toUpperCase()}
                    />
                  }
                  title={user.displayName ?? t('settings.privacy.unknownAccount')}
                  description={user.handle ? `@${user.handle}` : user.id}
                  showChevron={false}
                  rightElement={
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={t(props.removeActionKey)}
                      disabled={removeUser.isPending}
                      onPress={() => {
                        void remove(user);
                      }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons name="close-circle" size={22} color={theme.colors.error} />
                    </TouchableOpacity>
                  }
                />
              ))}
            </SettingsListGroup>
          </View>
        )}
      </ScrollView>
    </ThemedView>
  );
}

export default ModeratedUsersScreen;
