import React, { useState, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { toast } from '@oxyhq/bloom/toast';
import { TextFieldInput } from '@oxyhq/bloom';
import { useTranslation } from 'react-i18next';

// Components
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { Header } from '@/components/layout/Header';
import { EmptyState } from '@/components/shared/EmptyState';
import { MatrixSignInGate } from '@/components/matrix/MatrixSignInGate';

// Hooks
import { useTheme } from '@/hooks/useTheme';
import { useCreateConversation } from '@/hooks/useCreateConversation';
import { roomAdminSource } from '@/lib/chat/roomAdmin';
import { useOxy } from '@oxyhq/services';
import type { User as OxyUser } from '@oxyhq/core';
import type { Href } from 'expo-router';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * How long a group's name may be.
 *
 * A room name is state, not a message: it is drawn in a list row, a header and
 * a notification, all of which truncate. The cap is here so the truncation is
 * the user's choice rather than a surprise, and it is well inside what either
 * backend accepts.
 */
const GROUP_NAME_MAX_LENGTH = 64;

interface User {
  id: string;
  username: string;
  name: {
    /** Canonical, ready-to-render display string from the Oxy API. */
    displayName: string;
    first: string;
    last: string;
  };
  avatar?: string;
}

/**
 * New Chat Screen
 * Allows users to search for and start a new conversation
 *
 * **One creation path, whichever backend this build talks to.** Everything below
 * chooses people and hands them to `useCreateConversation`, which answers with
 * the id of a conversation to open; whether that is a row in Mongo or an
 * encrypted room on a homeserver is decided by `EXPO_PUBLIC_CHAT_BACKEND` and is
 * not this screen's business. See `lib/chat/newConversation.ts`.
 *
 * **It is also the app's one people-picker.** With `?invite=<roomId>` it adds
 * the people chosen to a conversation that already exists instead of making a
 * new one; everything above that last step — the search, the selection, the
 * rows — is the same screen doing the same job, and a second copy of it would
 * be a second search that drifts. Only the Matrix room details screen produces
 * that link, because only Matrix has a way to invite somebody to a room that
 * already exists.
 */
export default function NewChatScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { oxyServices } = useOxy();
  const createConversation = useCreateConversation();
  const { invite: inviteRoomId } = useLocalSearchParams<{ invite?: string }>();
  /** Adding to a conversation rather than starting one. */
  const isInviting = typeof inviteRoomId === 'string' && inviteRoomId !== '';

  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [groupName, setGroupName] = useState('');
  /**
   * A conversation is being created right now.
   *
   * Not cosmetic: creating one is a round trip, and a second tap during it makes
   * a second conversation. A direct message survives that — both backends
   * deduplicate a conversation between the same two people — but a group does
   * not, and two identical family groups with different histories is not a state
   * anyone recovers from.
   */
  const [isCreating, setIsCreating] = useState(false);

  // Search for users using Oxy Services
  const searchUsers = useCallback(async (query: string) => {
    if (!query.trim() || query.length < 2) {
      setUsers([]);
      return;
    }

    setIsLoading(true);
    try {
      const response = await oxyServices.searchProfiles(query, { limit: 20 });
      const searchResults: OxyUser[] = Array.isArray(response) ? response : response?.data || [];

      // Map Oxy profile format to our User format, rendering the API's
      // canonical name.displayName directly.
      const mappedUsers: User[] = searchResults.map((profile) => {
        const handle = typeof profile.handle === 'string' ? profile.handle : undefined;
        const displayName =
          profile.name?.displayName ||
          profile.username ||
          handle ||
          'Unknown';

        return {
          id: profile.id || String(profile._id ?? ''),
          username: profile.username || handle || '',
          name: {
            displayName,
            first: profile.name?.first || '',
            last: profile.name?.last || '',
          },
          avatar: profile.avatar ?? undefined,
        };
      });

      setUsers(mappedUsers);
    } catch (error) {
      logger.error('[NewChat] Error searching users:', error);
      toast.error(t('Failed to search users'));
      setUsers([]);
    } finally {
      setIsLoading(false);
    }
  }, [oxyServices, t]);

  // Debounced search
  const debouncedSearch = useMemo(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    return (query: string) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        searchUsers(query);
      }, 300);
    };
  }, [searchUsers]);

  const handleSearchChange = useCallback((text: string) => {
    setSearchQuery(text);
    debouncedSearch(text);
  }, [debouncedSearch]);

  // Toggle user selection
  const toggleUserSelection = useCallback((userId: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
        // If no users selected, exit selection mode
        if (next.size === 0) {
          setIsSelectionMode(false);
        }
      } else {
        next.add(userId);
        // Enter selection mode when first user is selected
        if (next.size === 1) {
          setIsSelectionMode(true);
        }
      }
      return next;
    });
  }, []);

  /**
   * Starts the conversation and opens it.
   *
   * The one place this screen creates anything. `replace` and not `push`,
   * because the conversation takes the place of the screen that chose who is in
   * it: going back from it belongs in the list, not here.
   */
  const startConversation = useCallback(
    async (participantIds: readonly string[], name: string | undefined) => {
      if (isCreating) {
        return;
      }
      setIsCreating(true);
      try {
        const conversationId = await createConversation({ participantIds, name });
        setSelectedUserIds(new Set());
        setIsSelectionMode(false);
        setGroupName('');
        router.replace(`/c/${conversationId}` as Href);
      } catch (error: unknown) {
        logger.error('[NewChat] Error creating conversation:', error);
        toast.error(getErrorMessage(error) || t('Failed to create conversation'));
      } finally {
        setIsCreating(false);
      }
    },
    [createConversation, isCreating, router, t],
  );

  /**
   * Adds the chosen people to a conversation that already exists.
   *
   * Every invitation is its own request, so some can be accepted and others
   * refused; what is reported is what happened, and the screen only leaves when
   * at least one person was actually invited. Telling the user "added" and
   * going back to a group nobody joined is the failure this shape prevents.
   */
  const invitePeople = useCallback(
    async (roomId: string, participantIds: readonly string[]) => {
      if (isCreating) {
        return;
      }
      setIsCreating(true);
      // Borrowed rather than merely fetched: the registry hands out one source
      // per room and drops it when nothing is watching, so a screen that used
      // one without subscribing would leave an entry behind for every room it
      // ever invited into. Watching it also means that if the details screen
      // this was opened from is still on the stack, its member list is the one
      // that gets refreshed.
      const source = roomAdminSource(roomId);
      const release = source.subscribe(() => {});
      try {
        const outcome = await source.invite(participantIds);
        if (outcome.failed.length > 0) {
          toast.error(
            t('Some invitations could not be sent ({{count}})', {
              count: outcome.failed.length,
            }),
          );
        }
        if (outcome.invited.length === 0) {
          return;
        }
        toast.success(t('Invitations sent ({{count}})', { count: outcome.invited.length }));
        setSelectedUserIds(new Set());
        setIsSelectionMode(false);
        router.replace(`/c/${roomId}` as Href);
      } catch (error: unknown) {
        logger.error('[NewChat] Error inviting people:', error);
        toast.error(getErrorMessage(error) || t('Allo could not invite anybody'));
      } finally {
        release();
        setIsCreating(false);
      }
    },
    [isCreating, router, t],
  );

  // Open a one-to-one conversation with the user whose row was tapped
  const openConversation = useCallback(
    async (user: User) => {
      // While adding people to a conversation there is nothing to open: a tap
      // is a choice, which is what selection mode already means.
      if (isSelectionMode || isInviting) {
        toggleUserSelection(user.id);
        return;
      }
      await startConversation([user.id], undefined);
    },
    [isInviting, isSelectionMode, toggleUserSelection, startConversation],
  );

  // What the button at the bottom does: add the chosen people to a conversation
  // that exists, or start one where a single person is a direct message and
  // more than one is a group.
  const submitSelection = useCallback(async () => {
    if (selectedUserIds.size === 0) {
      toast.error(t('Choose at least one person'));
      return;
    }
    const participantIds = Array.from(selectedUserIds);
    if (isInviting && inviteRoomId !== undefined) {
      await invitePeople(inviteRoomId, participantIds);
      return;
    }
    await startConversation(participantIds, groupName);
  }, [
    groupName,
    invitePeople,
    inviteRoomId,
    isInviting,
    selectedUserIds,
    startConversation,
    t,
  ]);

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    searchContainer: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    searchInputWrapper: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.backgroundSecondary || '#f0f2f5',
      borderRadius: 20,
      paddingHorizontal: 16,
      paddingVertical: 8,
      height: 40,
    },
    searchInput: {
      flex: 1,
      fontSize: 15,
      color: theme.colors.text,
      marginLeft: 8,
    },
    usersList: {
      flex: 1,
    },
    userItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    userInfo: {
      flex: 1,
      marginLeft: 12,
    },
    userName: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
    },
    userUsername: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    selectionIndicator: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: theme.colors.border,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 8,
    },
    selectionIndicatorSelected: {
      backgroundColor: theme.colors.primary,
      borderColor: theme.colors.primary,
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
    },
    emptyStateText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    createFooter: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: theme.colors.background,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    groupNameField: {
      paddingHorizontal: 16,
      paddingTop: 12,
    },
    createButton: {
      padding: 16,
      backgroundColor: theme.colors.primary,
    },
    createButtonText: {
      color: theme.colors.background,
      fontSize: 16,
      fontWeight: '600',
      textAlign: 'center',
    },
    createButtonDisabled: {
      opacity: 0.5,
    },
  });

  const renderUserItem = useCallback(({ item }: { item: User }) => {
    const isSelected = selectedUserIds.has(item.id);
    const fullName = item.name.displayName;

    return (
      <TouchableOpacity
        style={styles.userItem}
        onPress={() => {
          void openConversation(item);
        }}
        onLongPress={() => {
          toggleUserSelection(item.id);
        }}
        activeOpacity={0.7}
        delayLongPress={300}
      >
        {isSelectionMode && (
          <View style={[
            styles.selectionIndicator,
            isSelected && styles.selectionIndicatorSelected,
          ]}>
            {isSelected && (
              <Ionicons name="checkmark" size={16} color={theme.colors.background} />
            )}
          </View>
        )}
        <Avatar
          size={48}
          source={item.avatar ? { uri: item.avatar } : undefined}
          label={item.name.displayName.charAt(0).toUpperCase()}
        />
        <View style={styles.userInfo}>
          <ThemedText style={styles.userName} numberOfLines={1}>
            {fullName}
          </ThemedText>
          <ThemedText style={styles.userUsername} numberOfLines={1}>
            @{item.username}
          </ThemedText>
        </View>
      </TouchableOpacity>
    );
  }, [selectedUserIds, isSelectionMode, openConversation, toggleUserSelection, styles, theme.colors.background]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ThemedView style={styles.container}>
        <Header
          options={{
            title: isInviting ? t('Add people') : t('New Chat'),
            showBackButton: true,
          }}
        />

        {/* On the Matrix backend there is nothing to choose from and nowhere to
            put a new conversation until there is a client: the people are
            invited by their id on the homeserver this account lives on. With the
            flag unset the gate renders its children and nothing else. */}
        <MatrixSignInGate>
          <View style={styles.searchContainer}>
            <View style={styles.searchInputWrapper}>
              <Ionicons
                name="search"
                size={20}
                color={theme.colors.textSecondary}
              />
              <TextInput
                style={styles.searchInput}
                placeholder={t('Search users…')}
                placeholderTextColor={theme.colors.textSecondary}
                value={searchQuery}
                onChangeText={handleSearchChange}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity
                  onPress={() => {
                    setSearchQuery('');
                    setUsers([]);
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons
                    name="close-circle"
                    size={20}
                    color={theme.colors.textSecondary}
                  />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {isLoading ? (
            <View style={styles.emptyState}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
              <ThemedText style={[styles.emptyStateText, { marginTop: 16 }]}>
                {t('Searching…')}
              </ThemedText>
            </View>
          ) : users.length > 0 ? (
            <FlatList
              style={styles.usersList}
              data={users}
              renderItem={renderUserItem}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
            />
          ) : searchQuery.length >= 2 ? (
            <EmptyState
              lottieSource={require('@/assets/lottie/welcome.json')}
              title={t('No users found')}
            />
          ) : (
            <EmptyState
              lottieSource={require('@/assets/lottie/welcome.json')}
              title={
                searchQuery.length === 0
                  ? isInviting
                    ? t('Search for the people to add')
                    : t('Search for users to start a conversation')
                  : t('Type at least 2 characters to search')
              }
            />
          )}

          {isSelectionMode && selectedUserIds.size > 0 && (
            <View style={styles.createFooter}>
              {/* Only for a group. A one-to-one conversation is drawn with the
                  other person's name by every client, so a title here would be
                  one nobody asked for — and on Matrix it would be a name the
                  homeserver can read, because room state is not encrypted. */}
              {!isInviting && selectedUserIds.size > 1 && (
                <View style={styles.groupNameField}>
                  <TextFieldInput
                    label={t('Group name')}
                    placeholder={t('Group name (optional)')}
                    value={groupName}
                    onChangeText={setGroupName}
                    autoCapitalize="sentences"
                    maxLength={GROUP_NAME_MAX_LENGTH}
                    returnKeyType="done"
                  />
                </View>
              )}
              <TouchableOpacity
                style={[styles.createButton, isCreating && styles.createButtonDisabled]}
                onPress={() => {
                  void submitSelection();
                }}
                disabled={isCreating}
                accessibilityRole="button"
                accessibilityState={{ disabled: isCreating }}
              >
                {isCreating ? (
                  <ActivityIndicator color={theme.colors.background} />
                ) : (
                  <ThemedText style={styles.createButtonText}>
                    {isInviting
                      ? t('Add to the conversation ({{count}})', {
                          count: selectedUserIds.size,
                        })
                      : selectedUserIds.size === 1
                        ? t('Start Chat')
                        : t('Start Group Chat ({{count}})', {
                            count: selectedUserIds.size,
                          })}
                  </ThemedText>
                )}
              </TouchableOpacity>
            </View>
          )}
        </MatrixSignInGate>
      </ThemedView>
    </SafeAreaView>
  );
}

