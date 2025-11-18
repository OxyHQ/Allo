import React, { useState, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { toast } from '@/lib/sonner';

// Components
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';

// Hooks
import { useTheme } from '@/hooks/useTheme';
import { useOxy } from '@oxyhq/services';
import { useConversationsStore } from '@/stores';

// Utils
import { api } from '@/utils/api';
import { colors } from '@/styles/colors';

interface User {
  id: string;
  username: string;
  name: {
    first: string;
    last: string;
  };
  avatar?: string;
}

/**
 * New Chat Screen
 * Allows users to search for and start a new conversation
 */
export default function NewChatScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { oxyServices } = useOxy();
  const addConversation = useConversationsStore((state) => state.addConversation);
  
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());

  // Search for users
  const searchUsers = useCallback(async (query: string) => {
    if (!query.trim() || query.length < 2) {
      setUsers([]);
      return;
    }

    setIsLoading(true);
    try {
      // Use Oxy Services to search for users
      // This will search by username or name
      const searchResults = await oxyServices.searchProfiles(query, { limit: 20 });
      
      // Map Oxy profile format to our User format
      const mappedUsers: User[] = (searchResults || []).map((profile: any) => {
        // Handle name object or string
        let firstName = 'Unknown';
        let lastName = '';
        
        if (typeof profile.name === 'string') {
          const parts = profile.name.split(' ');
          firstName = parts[0] || 'Unknown';
          lastName = parts.slice(1).join(' ') || '';
        } else if (profile.name?.first) {
          firstName = profile.name.first;
          lastName = profile.name.last || '';
        } else if (profile.name?.full) {
          const parts = profile.name.full.split(' ');
          firstName = parts[0] || 'Unknown';
          lastName = parts.slice(1).join(' ') || '';
        } else if (profile.displayName) {
          const parts = profile.displayName.split(' ');
          firstName = parts[0] || 'Unknown';
          lastName = parts.slice(1).join(' ') || '';
        } else {
          firstName = profile.username || profile.handle || 'Unknown';
        }

        return {
          id: profile.id || profile._id,
          username: profile.username || profile.handle,
          name: {
            first: firstName,
            last: lastName,
          },
          avatar: profile.avatar || profile.profilePicture,
        };
      });
      
      setUsers(mappedUsers);
    } catch (error) {
      console.error('[NewChat] Error searching users:', error);
      toast.error('Failed to search users');
      setUsers([]);
    } finally {
      setIsLoading(false);
    }
  }, [oxyServices]);

  // Debounced search
  const debouncedSearch = useMemo(() => {
    let timeoutId: NodeJS.Timeout;
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
      } else {
        next.add(userId);
      }
      return next;
    });
  }, []);

  // Create new conversation
  const createConversation = useCallback(async () => {
    if (selectedUserIds.size === 0) {
      toast.error('Please select at least one user');
      return;
    }

    try {
      const participantIds = Array.from(selectedUserIds);
      const type = participantIds.length === 1 ? 'direct' : 'group';

      // Create conversation via API
      const response = await api.post<{ conversation: any }>('/conversations', {
        type,
        participantIds,
      });

      const apiConversation = response.data.conversation;

      // Transform to frontend format
      const participants = (apiConversation.participants || []).map((p: any) => ({
        id: p.userId,
        name: {
          first: p.name?.first || 'Unknown',
          last: p.name?.last || '',
        },
        username: p.username,
        avatar: p.avatar,
      }));

      const conversation = {
        id: apiConversation._id || apiConversation.id,
        type: apiConversation.type || 'direct',
        name: apiConversation.name || (type === 'group' ? 'Group Chat' : 'Direct Chat'),
        lastMessage: '',
        timestamp: new Date(apiConversation.createdAt).toISOString(),
        unreadCount: 0,
        avatar: apiConversation.avatar,
        participants,
        groupName: apiConversation.name,
        groupAvatar: apiConversation.avatar,
        participantCount: participants.length,
      };

      // Add to store
      addConversation(conversation);

      // Navigate to conversation
      router.push(`/c/${conversation.id}` as any);
      router.back(); // Close this screen
    } catch (error: any) {
      console.error('[NewChat] Error creating conversation:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to create conversation';
      toast.error(errorMessage);
    }
  }, [selectedUserIds, addConversation, router]);

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
    createButton: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      padding: 16,
      backgroundColor: theme.colors.primary,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    createButtonText: {
      color: '#FFFFFF',
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
    const fullName = `${item.name.first} ${item.name.last}`.trim();

    return (
      <TouchableOpacity
        style={styles.userItem}
        onPress={() => toggleUserSelection(item.id)}
        activeOpacity={0.7}
      >
        <View style={[
          styles.selectionIndicator,
          isSelected && styles.selectionIndicatorSelected,
        ]}>
          {isSelected && (
            <Ionicons name="checkmark" size={16} color="#FFFFFF" />
          )}
        </View>
        <Avatar
          size={48}
          source={item.avatar ? { uri: item.avatar } : undefined}
          label={item.name.first.charAt(0).toUpperCase()}
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
  }, [selectedUserIds, toggleUserSelection, styles]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ThemedView style={styles.container}>
        <Header
          title="New Chat"
          leftComponent={
            <HeaderIconButton
              icon="arrow-back"
              onPress={() => router.back()}
              accessibilityLabel="Go back"
            />
          }
        />

        <View style={styles.searchContainer}>
          <View style={styles.searchInputWrapper}>
            <Ionicons
              name="search"
              size={20}
              color={theme.colors.textSecondary}
            />
            <TextInput
              style={styles.searchInput}
              placeholder="Search users..."
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
              Searching...
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
          <View style={styles.emptyState}>
            <ThemedText style={styles.emptyStateText}>
              No users found
            </ThemedText>
          </View>
        ) : (
          <View style={styles.emptyState}>
            <ThemedText style={styles.emptyStateText}>
              {searchQuery.length === 0
                ? 'Search for users to start a conversation'
                : 'Type at least 2 characters to search'}
            </ThemedText>
          </View>
        )}

        {selectedUserIds.size > 0 && (
          <TouchableOpacity
            style={[
              styles.createButton,
              selectedUserIds.size === 0 && styles.createButtonDisabled,
            ]}
            onPress={createConversation}
            disabled={selectedUserIds.size === 0}
          >
            <ThemedText style={styles.createButtonText}>
              {selectedUserIds.size === 1
                ? 'Start Chat'
                : `Start Group Chat (${selectedUserIds.size})`}
            </ThemedText>
          </TouchableOpacity>
        )}
      </ThemedView>
    </SafeAreaView>
  );
}

