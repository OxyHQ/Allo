import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import {
    StyleSheet,
    View,
    Text,
    FlatList,
    TouchableOpacity,
    TextInput,
    useWindowDimensions,
    RefreshControl,
    ActivityIndicator,
} from 'react-native';
import { Link, useRouter, usePathname } from 'expo-router';
import { Swipeable } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
    Easing,
    FadeIn,
    FadeOut,
    LinearTransition,
    interpolateColor,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { toast } from '@/lib/sonner';

// Components
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { GroupAvatar } from '@/components/GroupAvatar';

// Hooks
import { useTheme } from '@/hooks/useTheme';
import { useOxy } from '@oxyhq/services';
import {
    useConversationsStore,
    useConversationSwipePreferencesStore,
    SwipeActionType,
} from '@/stores';

// Utils
import { colors } from '@/styles/colors';
import {
    getConversationDisplayName,
    getConversationAvatar,
    getOtherParticipants,
    getParticipantCount,
    isGroupConversation,
} from '@/utils/conversationUtils';

// Export types for use in other files
export type ConversationType = 'direct' | 'group';

export interface ConversationParticipant {
    id: string;
    name: {
        first: string;
        last: string;
    };
    username?: string;
    avatar?: string;
}

export interface Conversation {
    id: string;
    type: ConversationType;
    name: string; // For direct: contact name, for group: group name or generated name
    lastMessage: string;
    timestamp: string;
    unreadCount: number;
    avatar?: string; // For direct: contact avatar, for group: group avatar or first participant avatar
    isArchived?: boolean;
    // Group-specific fields
    participants?: ConversationParticipant[]; // All participants (including current user for groups)
    groupName?: string; // Custom group name (optional)
    groupAvatar?: string; // Custom group avatar (optional)
    participantCount?: number; // Number of participants (for groups)
}

/**
 * Conversations list component
 * Displays list of all conversations with support for direct and group chats
 * 
 * Follows Expo Router 54 best practices:
 * - Uses Link components for navigation
 * - Derives selected state from pathname
 * - Supports responsive layouts
 */
export default function ConversationsList() {
    const theme = useTheme();
    const pathname = usePathname();
    const router = useRouter();
    const { width: windowWidth } = useWindowDimensions();
    // Get conversations from store
    const conversations = useConversationsStore(state => state.conversations);
    const fetchConversations = useConversationsStore(state => state.fetchConversations);
    const refreshConversations = useConversationsStore(state => state.refreshConversations);
    const isLoading = useConversationsStore(state => state.isLoading);
    const isRefreshing = useConversationsStore(state => state.isRefreshing);
    const archiveConversation = useConversationsStore(state => state.archiveConversation);
    const unarchiveConversation = useConversationsStore(state => state.unarchiveConversation);
    const removeConversation = useConversationsStore(state => state.removeConversation);
    const leftSwipeAction = useConversationSwipePreferencesStore(state => state.leftSwipeAction);
    const rightSwipeAction = useConversationSwipePreferencesStore(state => state.rightSwipeAction);

    // Fetch conversations on mount
    useEffect(() => {
        fetchConversations();
    }, [fetchConversations]);

    // Search state
    const [searchQuery, setSearchQuery] = useState('');

    // Filter conversations based on search query and archived status
    const visibleConversations = useMemo(() => {
        let filtered = conversations.filter(conv => !conv.isArchived);

        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            filtered = filtered.filter(conv =>
                conv.name.toLowerCase().includes(query) ||
                conv.lastMessage.toLowerCase().includes(query)
            );
        }

        return filtered;
    }, [conversations, searchQuery]);
    // Determine empty state messaging
    const hasArchivedOnly = conversations.length > 0 && visibleConversations.length === 0 && !searchQuery.trim();
    const noSearchResults = searchQuery.trim() && visibleConversations.length === 0;

    const emptyStateCopy = noSearchResults
        ? 'No conversations found.\nTry a different search term.'
        : hasArchivedOnly
            ? 'All of your conversations are archived.\nAdjust swipe settings if you want them to stay visible.'
            : 'No conversations yet.\nStart a new chat to get started!';

    // Track selected conversation from pathname
    // Matches both /c/:id format and legacy /(chat)/:id format
    const selectedId = useMemo(() => {
        const cMatch = pathname?.match(/\/c\/([^/]+)$/);
        const chatMatch = pathname?.match(/\/(chat)\/([^/]+)$/);
        return cMatch?.[1] || chatMatch?.[2] || null;
    }, [pathname]);

    // Mock current user ID - replace with actual user ID from auth system
    const { user } = useOxy();
    const currentUserId = user?.id;

    // Multi-selection state
    const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(() => new Set());
    const isSelectionMode = selectedConversationIds.size > 0;
    const selectedCount = selectedConversationIds.size;

    // Animation and refs
    const swipeableRefs = useRef<Record<string, Swipeable | null>>({});
    const selectionModeProgress = useSharedValue(0);

    // Sync animation progress with selection mode
    useEffect(() => {
        selectionModeProgress.value = withTiming(isSelectionMode ? 1 : 0, {
            duration: 220,
            easing: Easing.out(Easing.cubic),
        });
    }, [isSelectionMode, selectionModeProgress]);

    const styles = useMemo(() => StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: theme.colors.background,
        },
        header: {
            position: 'relative',
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
            backgroundColor: theme.colors.background,
        },
        headerTop: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
        },
        headerTitle: {
            fontSize: 24,
            fontWeight: 'bold',
            color: theme.colors.text,
        },
        headerRight: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 16,
        },
        headerIconButton: {
            padding: 4,
        },
        searchBarContainer: {
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 8,
            backgroundColor: theme.colors.background,
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
        selectionHeaderContent: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
        },
        selectionHeaderLeft: {
            flexDirection: 'row',
            alignItems: 'center',
        },
        selectionHeaderTitle: {
            fontSize: 18,
            fontWeight: '600',
            color: '#FFFFFF',
            marginLeft: 8,
        },
        selectionHeaderActions: {
            flexDirection: 'row',
            alignItems: 'center',
        },
        selectionActionButton: {
            padding: 6,
            borderRadius: 18,
            marginLeft: 12,
        },
        selectionActionButtonDisabled: {
            opacity: 0.4,
        },
        selectionCloseButton: {
            padding: 6,
            borderRadius: 18,
            marginLeft: 0,
        },
        list: {
            flex: 1,
        },
        conversationItem: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 12,
            paddingVertical: 10,
            minHeight: 64,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: theme.colors.border,
            backgroundColor: theme.colors.background,
        },
        conversationItemSelected: {
            backgroundColor: theme.colors.backgroundSecondary,
        },
        conversationItemMultiSelected: {
            backgroundColor: theme.colors.backgroundSecondary,
        },
        selectionOverlay: {
            position: 'absolute',
            top: 4,
            left: 4,
            width: 36,
            height: 36,
            borderRadius: 18,
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 3,
            backgroundColor: theme.isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
            borderWidth: 2,
            borderColor: theme.colors.border,
        },
        selectionOverlaySelected: {
            backgroundColor: theme.colors.primary,
            borderColor: theme.colors.primary,
        },
        selectionOverlayUnselected: {
            backgroundColor: theme.isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)',
            borderColor: theme.colors.border,
        },
        avatarContainer: {
            width: 44,
            height: 44,
            marginRight: 12,
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
        },
        conversationContent: {
            flex: 1,
            justifyContent: 'center',
        },
        conversationHeader: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 4,
        },
        conversationName: {
            fontSize: 15,
            fontWeight: '600',
            color: theme.colors.text,
        },
        conversationTimestamp: {
            fontSize: 11,
            color: theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5,
        },
        conversationMessage: {
            fontSize: 13,
            color: theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5,
        },
        unreadBadge: {
            backgroundColor: colors.chatUnreadBadge,
            borderRadius: 10,
            minWidth: 20,
            height: 20,
            paddingHorizontal: 6,
            justifyContent: 'center',
            alignItems: 'center',
        },
        unreadText: {
            color: '#FFFFFF',
            fontSize: 12,
            fontWeight: '600',
        },
        emptyState: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 32,
        },
        emptyStateText: {
            fontSize: 16,
            color: theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5,
            textAlign: 'center',
        },
        loadingContainer: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 32,
        },
        loadingText: {
            marginTop: 16,
            fontSize: 16,
            color: theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5,
        },
        swipeActionContainer: {
            justifyContent: 'center',
            alignItems: 'center',
            overflow: 'hidden',
        },
        swipeActionContent: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            paddingHorizontal: 20,
        },
        swipeActionArchive: {
            backgroundColor: colors.chatTypingIndicator,
        },
        swipeActionDelete: {
            backgroundColor: colors.chatUnreadBadge,
        },
        swipeActionText: {
            color: '#FFFFFF',
            fontSize: 14,
            fontWeight: '600',
        },
        settingsButton: {
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
        },
        settingsButtonText: {
            fontSize: 15,
            color: theme.colors.text,
            fontWeight: '500',
        },
    }), [theme]);

    /**
     * Clear all selected conversations
     */
    const clearSelection = useCallback(() => {
        setSelectedConversationIds(new Set());
    }, []);

    /**
     * Toggle selection state for a single conversation
     */
    const toggleConversationSelection = useCallback((conversationId: string) => {
        setSelectedConversationIds((prev) => {
            const next = new Set(prev);
            if (next.has(conversationId)) {
                next.delete(conversationId);
            } else {
                next.add(conversationId);
            }
            return next;
        });
    }, []);

    /**
     * Handle long press to enter/exit selection mode
     */
    const handleConversationLongPress = useCallback((conversationId: string) => {
        setSelectedConversationIds((prev) => {
            if (prev.size === 0) {
                return new Set([conversationId]);
            }
            const next = new Set(prev);
            if (next.has(conversationId)) {
                next.delete(conversationId);
            } else {
                next.add(conversationId);
            }
            return next;
        });
    }, []);

    /**
     * Handle conversation press - navigate or toggle selection
     */
    const handleConversationPress = useCallback((conversationId: string) => {
        if (isSelectionMode) {
            toggleConversationSelection(conversationId);
            return;
        }
        // Use /u/:id for direct conversations, /c/[id] for others
        const conversation = conversations.find(c => c.id === conversationId);
        const route = conversation?.type === 'direct' 
          ? (() => {
              const otherParticipant = conversation.participants?.find(p => p.id !== currentUserId);
              return otherParticipant?.id ? `/u/${otherParticipant.id}` : `/c/${conversationId}`;
            })()
          : `/c/${conversationId}`;
        router.push(route as any);
    }, [isSelectionMode, toggleConversationSelection, router]);

    /**
     * Archive a conversation with toast notification and undo
     */
    const handleArchiveConversation = useCallback((conversationId: string, conversationName: string) => {
        archiveConversation(conversationId);

        toast.success(`Archived "${conversationName}"`, {
            action: {
                label: 'Undo',
                onClick: () => {
                    unarchiveConversation(conversationId);
                    toast.success('Archive undone');
                },
            },
            duration: 4000,
        });
    }, [archiveConversation, unarchiveConversation]);

    /**
     * Delete a conversation with toast notification and undo
     * Note: For undo to work, we'd need to store deleted conversations temporarily
     */
    const handleDeleteConversation = useCallback((conversationId: string, conversationName: string) => {
        const conversation = conversations.find(c => c.id === conversationId);

        removeConversation(conversationId);

        toast.error(`Deleted "${conversationName}"`, {
            action: conversation ? {
                label: 'Undo',
                onClick: () => {
                    // Re-add the conversation (this would need proper implementation in the store)
                    toast.info('Delete undone - restoring conversation');
                    // TODO: Implement proper restore functionality in the store
                },
            } : undefined,
            duration: 4000,
        });
    }, [removeConversation, conversations]);

    /**
     * Archive all selected conversations
     */
    const handleBulkArchive = useCallback(() => {
        const ids = Array.from(selectedConversationIds);
        const count = ids.length;

        ids.forEach((id) => archiveConversation(id));
        clearSelection();

        toast.success(`Archived ${count} conversation${count !== 1 ? 's' : ''}`, {
            action: {
                label: 'Undo',
                onClick: () => {
                    ids.forEach((id) => unarchiveConversation(id));
                    toast.success('Archive undone');
                },
            },
            duration: 4000,
        });
    }, [selectedConversationIds, archiveConversation, unarchiveConversation, clearSelection]);

    /**
     * Delete all selected conversations
     */
    const handleBulkDelete = useCallback(() => {
        const ids = Array.from(selectedConversationIds);
        const count = ids.length;

        ids.forEach((id) => removeConversation(id));
        clearSelection();

        toast.error(`Deleted ${count} conversation${count !== 1 ? 's' : ''}`, {
            duration: 4000,
        });
    }, [selectedConversationIds, removeConversation, clearSelection]);

    // Animated styles for header background during selection mode
    const headerBackgroundColor = theme.colors.background;
    const headerBorderColor = theme.colors.border;

    const headerAnimatedStyle = useAnimatedStyle(() => ({
        backgroundColor: interpolateColor(
            selectionModeProgress.value,
            [0, 1],
            [headerBackgroundColor, colors.primaryColor],
        ),
        borderBottomColor: interpolateColor(
            selectionModeProgress.value,
            [0, 1],
            [headerBorderColor, colors.primaryColor],
        ),
    }), [headerBackgroundColor, headerBorderColor]);

    /**
     * Close a swipeable row
     */
    const closeSwipeable = useCallback((id: string) => {
        swipeableRefs.current[id]?.close();
    }, []);

    /**
     * Render swipe action with animated width that fills space
     */
    const renderSwipeAction = useCallback((action: SwipeActionType, direction: 'left' | 'right') => {
        return (progress: any, dragX: any) => {
            if (action === 'none') {
                return null;
            }

            const isDelete = action === 'delete';

            const swipeGapWidth = dragX.interpolate({
                inputRange: direction === 'left'
                    ? [0, windowWidth]
                    : [-windowWidth, 0],
                outputRange: [0, windowWidth],
                extrapolate: 'clamp',
            });

            return (
                <Animated.View
                    style={[
                        styles.swipeActionContainer,
                        isDelete ? styles.swipeActionDelete : styles.swipeActionArchive,
                        {
                            width: swipeGapWidth,
                            maxWidth: windowWidth,
                        },
                    ]}
                >
                    <View style={styles.swipeActionContent}>
                        <Ionicons
                            name={isDelete ? 'trash-outline' : 'archive-outline'}
                            size={20}
                            color="#FFFFFF"
                        />
                        <Text style={styles.swipeActionText}>
                            {isDelete ? 'Delete' : 'Archive'}
                        </Text>
                    </View>
                </Animated.View>
            );
        };
    }, [styles, windowWidth]);

    /**
     * Handle swipe action on a conversation
     */
    const handleSwipeAction = useCallback((direction: 'left' | 'right', conversation: Conversation) => {
        const action = direction === 'left' ? leftSwipeAction : rightSwipeAction;

        if (action === 'none') {
            closeSwipeable(conversation.id);
            return;
        }

        if (action === 'archive') {
            handleArchiveConversation(conversation.id, conversation.name);
        } else if (action === 'delete') {
            handleDeleteConversation(conversation.id, conversation.name);
        }

        setTimeout(() => {
            closeSwipeable(conversation.id);
        }, 200);
    }, [leftSwipeAction, rightSwipeAction, closeSwipeable, handleArchiveConversation, handleDeleteConversation]);

    /**
     * Search bar header component (memoized to prevent re-renders)
     */
    const SearchBarHeader = useMemo(() => {
        if (isSelectionMode) return null;

        return (
            <View style={styles.searchBarContainer}>
                <View style={styles.searchInputWrapper}>
                    <Ionicons
                        name="search"
                        size={20}
                        color={theme.colors.textSecondary}
                    />
                    <TextInput
                        style={styles.searchInput}
                        placeholder="Ask Oxy AI or Search"
                        placeholderTextColor={theme.colors.textSecondary}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        returnKeyType="search"
                        accessibilityLabel="Search input"
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    {searchQuery.length > 0 && (
                        <TouchableOpacity
                            onPress={() => setSearchQuery('')}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            accessibilityLabel="Clear search"
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
        );
    }, [isSelectionMode, searchQuery, theme.colors.textSecondary, styles.searchBarContainer, styles.searchInputWrapper, styles.searchInput]);

    /**
     * Render individual conversation item
     */
    const renderConversationItem = ({ item }: { item: Conversation }) => {
        const isActiveConversation = selectedId === item.id;
        const isItemSelected = selectedConversationIds.has(item.id);
        const isGroup = isGroupConversation(item);
        const displayName = getConversationDisplayName(item, currentUserId);
        const avatar = getConversationAvatar(item, currentUserId);
        const otherParticipants = getOtherParticipants(item, currentUserId);
        const participantCount = getParticipantCount(item, currentUserId);
        const leftEnabled = leftSwipeAction !== 'none';
        const rightEnabled = rightSwipeAction !== 'none';
        const swipeEnabled = !isSelectionMode && (leftEnabled || rightEnabled);

        const wrapperStyles = [
            styles.conversationItem,
            !isSelectionMode && isActiveConversation && styles.conversationItemSelected,
            isItemSelected && styles.conversationItemMultiSelected,
        ];

        const rowContent = (
            <TouchableOpacity
                activeOpacity={0.7}
                onLongPress={() => handleConversationLongPress(item.id)}
                onPress={() => handleConversationPress(item.id)}
                style={wrapperStyles}
            >
                <View style={styles.avatarContainer}>
                    {isSelectionMode && (
                        <Animated.View
                            layout={LinearTransition.springify().damping(20)}
                            style={[
                                styles.selectionOverlay,
                                isItemSelected
                                    ? styles.selectionOverlaySelected
                                    : styles.selectionOverlayUnselected,
                            ]}
                        >
                            {isItemSelected && (
                                <Animated.View
                                    entering={FadeIn.duration(150)}
                                    exiting={FadeOut.duration(120)}
                                >
                                    <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                                </Animated.View>
                            )}
                        </Animated.View>
                    )}
                    {isGroup && otherParticipants.length > 0 ? (
                        <GroupAvatar
                            participants={otherParticipants}
                            size={44}
                            maxAvatars={2}
                        />
                    ) : (
                        <Avatar
                            size={44}
                            source={avatar ? { uri: avatar } : undefined}
                            label={displayName.charAt(0).toUpperCase()}
                        />
                    )}
                </View>
                <View style={styles.conversationContent}>
                    <View style={styles.conversationHeader}>
                        <View style={{ flex: 1, marginRight: 8 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                                <ThemedText style={styles.conversationName} numberOfLines={1}>
                                    {displayName}
                                </ThemedText>
                                {isGroup && participantCount > 0 && (
                                    <ThemedText
                                        style={[
                                            styles.conversationTimestamp,
                                            { marginLeft: 4 },
                                        ]}
                                        numberOfLines={1}
                                    >
                                        ({participantCount})
                                    </ThemedText>
                                )}
                            </View>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <ThemedText style={styles.conversationTimestamp} numberOfLines={1}>
                                {item.timestamp}
                            </ThemedText>
                            {item.unreadCount > 0 && (
                                <View style={styles.unreadBadge}>
                                    <Text style={styles.unreadText}>
                                        {item.unreadCount > 99 ? '99+' : item.unreadCount}
                                    </Text>
                                </View>
                            )}
                        </View>
                    </View>
                    <ThemedText style={styles.conversationMessage} numberOfLines={1}>
                        {item.lastMessage}
                    </ThemedText>
                </View>
            </TouchableOpacity>
        );

        return (
            <Swipeable
                ref={(ref) => {
                    swipeableRefs.current[item.id] = ref;
                }}
                enabled={swipeEnabled}
                renderLeftActions={
                    leftEnabled ? renderSwipeAction(leftSwipeAction, 'left') : undefined
                }
                renderRightActions={
                    rightEnabled ? renderSwipeAction(rightSwipeAction, 'right') : undefined
                }
                overshootLeft={true}
                overshootRight={true}
                onSwipeableOpen={(direction) => {
                    if (direction === 'left' || direction === 'right') {
                        handleSwipeAction(direction, item);
                    }
                }}
            >
                {rowContent}
            </Swipeable>
        );
    };

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            <ThemedView style={styles.container}>
                <Animated.View style={[styles.header, headerAnimatedStyle]}>
                    {!isSelectionMode ? (
                        <Animated.View
                            entering={FadeIn.duration(200)}
                            exiting={FadeOut.duration(150)}
                            style={styles.headerTop}
                        >
                            <ThemedText style={styles.headerTitle}>Allo</ThemedText>
                            <View style={styles.headerRight}>
                                <TouchableOpacity
                                    style={styles.headerIconButton}
                                    onPress={() => {
                                        router.push('/new' as any);
                                    }}
                                    accessibilityLabel="New Chat"
                                    accessibilityRole="button"
                                >
                                    <Ionicons
                                        name="create-outline"
                                        size={24}
                                        color={theme.colors.text}
                                    />
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.headerIconButton}
                                    onPress={() => {
                                        // TODO: Implement camera functionality
                                        console.log('Camera pressed');
                                    }}
                                    accessibilityLabel="Camera"
                                    accessibilityRole="button"
                                >
                                    <Ionicons
                                        name="camera-outline"
                                        size={24}
                                        color={theme.colors.text}
                                    />
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.headerIconButton}
                                    onPress={() => {
                                        // TODO: Implement options menu
                                        console.log('Options pressed');
                                    }}
                                    accessibilityLabel="More options"
                                    accessibilityRole="button"
                                >
                                    <Ionicons
                                        name="ellipsis-vertical"
                                        size={24}
                                        color={theme.colors.text}
                                    />
                                </TouchableOpacity>
                            </View>
                        </Animated.View>
                    ) : (
                        <Animated.View
                            entering={FadeIn.duration(200)}
                            exiting={FadeOut.duration(150)}
                            style={[styles.selectionHeaderContent]}
                        >
                            <View style={styles.selectionHeaderLeft}>
                                <TouchableOpacity
                                    style={styles.selectionCloseButton}
                                    onPress={clearSelection}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    accessibilityLabel="Exit selection mode"
                                    accessibilityRole="button"
                                >
                                    <Ionicons name="arrow-back" size={22} color="#FFFFFF" />
                                </TouchableOpacity>
                                <Text style={styles.selectionHeaderTitle}>
                                    {selectedCount} selected
                                </Text>
                            </View>
                            <View style={styles.selectionHeaderActions}>
                                <TouchableOpacity
                                    style={[
                                        styles.selectionActionButton,
                                        selectedCount === 0 && styles.selectionActionButtonDisabled,
                                    ]}
                                    onPress={handleBulkArchive}
                                    disabled={selectedCount === 0}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    accessibilityLabel={`Archive ${selectedCount} conversation${selectedCount !== 1 ? 's' : ''}`}
                                    accessibilityRole="button"
                                >
                                    <Ionicons name="archive-outline" size={20} color="#FFFFFF" />
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[
                                        styles.selectionActionButton,
                                        selectedCount === 0 && styles.selectionActionButtonDisabled,
                                    ]}
                                    onPress={handleBulkDelete}
                                    disabled={selectedCount === 0}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    accessibilityLabel={`Delete ${selectedCount} conversation${selectedCount !== 1 ? 's' : ''}`}
                                    accessibilityRole="button"
                                >
                                    <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
                                </TouchableOpacity>
                            </View>
                        </Animated.View>
                    )}
                </Animated.View>

                {isLoading && conversations.length === 0 ? (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="large" color={theme.colors.primary} />
                        <ThemedText style={styles.loadingText}>Loading conversations...</ThemedText>
                    </View>
                ) : visibleConversations.length > 0 ? (
                    <FlatList
                        style={styles.list}
                        data={visibleConversations}
                        renderItem={renderConversationItem}
                        keyExtractor={(item) => item.id}
                        extraData={selectedConversationIds}
                        ListHeaderComponent={SearchBarHeader}
                        contentContainerStyle={{ flexGrow: 1 }}
                        keyboardShouldPersistTaps="handled"
                        refreshControl={
                            <RefreshControl
                                refreshing={isRefreshing}
                                onRefresh={refreshConversations}
                                tintColor={theme.colors.primary}
                                colors={[theme.colors.primary]}
                            />
                        }
                    />
                ) : (
                    <>
                        {SearchBarHeader}
                        <View style={styles.emptyState}>
                            <ThemedText style={styles.emptyStateText}>
                                {emptyStateCopy}
                            </ThemedText>
                        </View>
                    </>
                )}

                <Link
                    href="/(chat)/settings" as any
                    style={styles.settingsButton}
                    asChild
                >
                    <TouchableOpacity activeOpacity={0.7}>
                        <ThemedText style={styles.settingsButtonText}>Settings</ThemedText>
                    </TouchableOpacity>
                </Link>
            </ThemedView>
        </SafeAreaView>
    );
}
