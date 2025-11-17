import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import {
    StyleSheet,
    View,
    Text,
    FlatList,
    TouchableOpacity,
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

// Components
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { GroupAvatar } from '@/components/GroupAvatar';

// Hooks
import { useTheme } from '@/hooks/useTheme';
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
    // Get conversations from store
    const conversations = useConversationsStore(state => state.conversations);
    const archiveConversation = useConversationsStore(state => state.archiveConversation);
    const removeConversation = useConversationsStore(state => state.removeConversation);
    const leftSwipeAction = useConversationSwipePreferencesStore(state => state.leftSwipeAction);
    const rightSwipeAction = useConversationSwipePreferencesStore(state => state.rightSwipeAction);
    const visibleConversations = useMemo(
        () => conversations.filter(conv => !conv.isArchived),
        [conversations]
    );
    const hasArchivedOnly = conversations.length > 0 && visibleConversations.length === 0;
    const emptyStateCopy = hasArchivedOnly
        ? 'All of your conversations are archived.\nAdjust swipe settings if you want them to stay visible.'
        : 'No conversations yet.\nStart a new chat to get started!';
    
    // Track selected conversation from pathname
    // Matches both /c/:id format and legacy /(chat)/:id format
    const selectedId = useMemo(() => {
        const cMatch = pathname?.match(/\/c\/([^/]+)$/);
        const chatMatch = pathname?.match(/\/(chat)\/([^/]+)$/);
        return cMatch?.[1] || chatMatch?.[2] || null;
    }, [pathname]);

    // Mock current user ID - replace with actual user ID from your auth system
    const currentUserId = 'current-user';
    const swipeableRefs = useRef<Record<string, Swipeable | null>>({});
    const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(
        () => new Set()
    );
    const selectionModeProgress = useSharedValue(0);
    const isSelectionMode = selectedConversationIds.size > 0;
    const selectedCount = selectedConversationIds.size;

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
            height: 64,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
            backgroundColor: theme.colors.background,
        },
        headerContent: {
            position: 'absolute',
            left: 16,
            right: 16,
            top: 8,
            bottom: 8,
            flexDirection: 'row',
            alignItems: 'center',
        },
        headerTitle: {
            fontSize: 20,
            fontWeight: 'bold',
            color: theme.colors.text,
        },
        selectionHeaderContent: {
            position: 'absolute',
            left: 16,
            right: 16,
            top: 8,
            bottom: 8,
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
            backgroundColor: colors.primaryLight_1,
        },
        conversationItemMultiSelected: {
            backgroundColor: colors.primaryLight_2,
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
            backgroundColor: 'rgba(0,0,0,0.45)',
            borderWidth: 2,
            borderColor: theme.colors.card,
        },
        selectionOverlaySelected: {
            backgroundColor: colors.primaryColor,
            borderColor: colors.primaryColor,
        },
        selectionOverlayUnselected: {
            backgroundColor: 'rgba(0,0,0,0.35)',
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
        swipeActionContainer: {
            width: 96,
            height: '100%',
            justifyContent: 'center',
            alignItems: 'center',
        },
        swipeActionArchive: {
            backgroundColor: colors.chatTypingIndicator,
        },
        swipeActionDelete: {
            backgroundColor: colors.chatUnreadBadge,
        },
        swipeActionText: {
            color: '#FFFFFF',
            fontSize: 13,
            fontWeight: '600',
            textTransform: 'uppercase',
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

    const clearSelection = useCallback(() => {
        setSelectedConversationIds(new Set());
    }, []);

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

    const handleConversationPress = useCallback((conversationId: string) => {
        if (isSelectionMode) {
            toggleConversationSelection(conversationId);
            return;
        }
        router.push(`/c/${conversationId}` as any);
    }, [isSelectionMode, toggleConversationSelection, router]);

    const handleBulkArchive = useCallback(() => {
        const ids = Array.from(selectedConversationIds);
        ids.forEach((id) => archiveConversation(id));
        clearSelection();
    }, [selectedConversationIds, archiveConversation, clearSelection]);

    const handleBulkDelete = useCallback(() => {
        const ids = Array.from(selectedConversationIds);
        ids.forEach((id) => removeConversation(id));
        clearSelection();
    }, [selectedConversationIds, removeConversation, clearSelection]);

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

    const defaultHeaderAnimatedStyle = useAnimatedStyle(() => ({
        opacity: 1 - selectionModeProgress.value,
        transform: [
            {
                translateY: selectionModeProgress.value * -8,
            },
        ],
    }));

    const selectionHeaderAnimatedStyle = useAnimatedStyle(() => ({
        opacity: selectionModeProgress.value,
        transform: [
            {
                translateY: (1 - selectionModeProgress.value) * 8,
            },
        ],
    }));

    const closeSwipeable = useCallback((id: string) => {
        swipeableRefs.current[id]?.close();
    }, []);

    const renderSwipeActionPreview = useCallback((action: SwipeActionType) => {
        if (action === 'none') {
            return null;
        }

        const isDelete = action === 'delete';

        return (
            <View
                style={[
                    styles.swipeActionContainer,
                    isDelete ? styles.swipeActionDelete : styles.swipeActionArchive,
                ]}
            >
                <Text style={styles.swipeActionText}>
                    {isDelete ? 'Delete' : 'Archive'}
                </Text>
            </View>
        );
    }, [
        styles.swipeActionArchive,
        styles.swipeActionContainer,
        styles.swipeActionDelete,
        styles.swipeActionText,
    ]);

    const handleSwipeAction = useCallback((direction: 'left' | 'right', conversation: Conversation) => {
        const action = direction === 'left' ? leftSwipeAction : rightSwipeAction;

        if (action === 'none') {
            closeSwipeable(conversation.id);
            return;
        }

        if (action === 'archive') {
            archiveConversation(conversation.id);
        } else if (action === 'delete') {
            removeConversation(conversation.id);
        }

        setTimeout(() => {
            closeSwipeable(conversation.id);
        }, 200);
    }, [
        archiveConversation,
        removeConversation,
        leftSwipeAction,
        rightSwipeAction,
        closeSwipeable,
    ]);

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
            isActiveConversation && styles.conversationItemSelected,
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
                    leftEnabled ? () => renderSwipeActionPreview(leftSwipeAction) : undefined
                }
                renderRightActions={
                    rightEnabled ? () => renderSwipeActionPreview(rightSwipeAction) : undefined
                }
                overshootLeft={false}
                overshootRight={false}
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
                    <Animated.View
                        pointerEvents={isSelectionMode ? 'none' : 'auto'}
                        style={[styles.headerContent, defaultHeaderAnimatedStyle]}
                    >
                        <ThemedText style={styles.headerTitle}>Messages</ThemedText>
                    </Animated.View>

                    <Animated.View
                        pointerEvents={isSelectionMode ? 'auto' : 'none'}
                        style={[styles.selectionHeaderContent, selectionHeaderAnimatedStyle]}
                    >
                        <View style={styles.selectionHeaderLeft}>
                            <TouchableOpacity
                                style={styles.selectionCloseButton}
                                onPress={clearSelection}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
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
                            >
                                <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
                            </TouchableOpacity>
                        </View>
                    </Animated.View>
                </Animated.View>

                {visibleConversations.length > 0 ? (
                    <FlatList
                        style={styles.list}
                        data={visibleConversations}
                        renderItem={renderConversationItem}
                        keyExtractor={(item) => item.id}
                        extraData={selectedConversationIds}
                        contentContainerStyle={{ flexGrow: 1 }}
                    />
                ) : (
                    <View style={styles.emptyState}>
                        <ThemedText style={styles.emptyStateText}>
                            {emptyStateCopy}
                        </ThemedText>
                    </View>
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
