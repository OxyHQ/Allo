import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import {
    StyleSheet,
    View,
    Text,
    TouchableOpacity,
    useWindowDimensions,
    RefreshControl,
    type ViewStyle,
    type TextStyle,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Link, useRouter, usePathname, type Href } from 'expo-router';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
    Easing,
    FadeIn,
    FadeOut,
    LinearTransition,
    interpolate,
    interpolateColor,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import Ionicons from '@expo/vector-icons/Ionicons';
import { toast } from '@oxy.so/bloom/toast';
import { useConversationActions, useSyncState } from '@allo/react';

// Components
import { Search } from '@oxy.so/bloom/search';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useTranslation } from 'react-i18next';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { GroupAvatar } from '@/components/GroupAvatar';
import { EmptyState } from '@/components/shared/EmptyState';

// Hooks
import { useTheme } from '@/hooks/useTheme';
import { useOxy } from '@oxy.so/services';
import { useChatConversations } from '@/hooks/useChatConversations';
import { useUnreachableMembers } from '@/hooks/useUnreachableMembers';
import {
    useConversationSwipePreferencesStore,
    useUsersStore,
    SwipeActionType,
} from '@/stores';

// Conversation peek preview
import { ConversationPeekPreview } from '@/components/conversation/ConversationPeekPreview';
import { HistoryTransferBanner } from '@/components/conversation/HistoryTransferBanner';

// Utils
import { colors } from '@/styles/colors';
import {
    useConversationDisplayName,
    useConversationAvatar,
    getConversationDisplayName,
    getOtherParticipants,
    getParticipantCount,
    isGroupConversation,
} from '@/utils/conversationUtils';
import { formatConversationTimestamp } from '@/utils/dateUtils';
import { useAvatarShape } from '@/hooks/useAvatarShape';
import { useBottomChrome } from '@/context/BottomChromeContext';
import { confirmDialog } from '@/utils/alerts';
import { logger } from '@/utils/logger';
import type { Conversation } from '@/lib/chat/model';

// Skeleton dimension lookup tables (module-level to avoid re-allocation per render)
const SKELETON_NAME_WIDTHS = [140, 110, 160, 120, 130, 100, 150, 115, 145, 125] as const;
const SKELETON_MSG_WIDTHS = [200, 170, 220, 180, 150, 210, 190, 160, 230, 175] as const;

// The chat view-model types live in `@/lib/chat/model`; re-exported for the
// modules that historically imported them from this screen.
export type { Conversation, ConversationParticipant, ConversationType } from '@/lib/chat/model';

/**
 * Direct conversation avatar with shape support.
 * Extracts userId from participants to look up avatar shape.
 */
function ShapedConversationAvatar({
    userId,
    avatar,
    displayName,
    size = 44,
}: {
    userId?: string;
    avatar?: string;
    displayName: string;
    size?: number;
}) {
    const shape = useAvatarShape(userId);

    return (
        <Avatar
            size={size}
            source={avatar ? { uri: avatar } : undefined}
            label={displayName.charAt(0).toUpperCase()}
            shape={shape}
        />
    );
}

/** Subset of the conversation-list stylesheet consumed by a single row. */
interface ConversationRowStyles {
    conversationItem: ViewStyle;
    conversationItemSelected: ViewStyle;
    conversationItemMultiSelected: ViewStyle;
    avatarContainer: ViewStyle;
    selectionOverlay: ViewStyle;
    selectionOverlaySelected: ViewStyle;
    selectionOverlayUnselected: ViewStyle;
    conversationContent: ViewStyle;
    conversationHeader: ViewStyle;
    conversationNameContainer: ViewStyle;
    conversationNameRow: ViewStyle;
    conversationName: TextStyle;
    conversationTimestamp: TextStyle;
    participantCountLabel: TextStyle;
    conversationTimestampUnread: TextStyle;
    conversationBottomRow: ViewStyle;
    conversationMessage: TextStyle;
    conversationMessageHeld: TextStyle;
    unreadBadge: ViewStyle;
    unreadText: TextStyle;
}

interface ConversationRowProps {
    item: Conversation;
    currentUserId?: string;
    isActive: boolean;
    isSelected: boolean;
    isSelectionMode: boolean;
    leftSwipeAction: SwipeActionType;
    rightSwipeAction: SwipeActionType;
    styles: ConversationRowStyles;
    onPress: (conversationId: string) => void;
    onLongPress: (conversationId: string) => void;
    onAvatarLongPress: (conversation: Conversation) => void;
    renderSwipeAction: (
        action: SwipeActionType,
        direction: 'left' | 'right',
    ) => (
        progress: SharedValue<number>,
        translation: SharedValue<number>,
        methods: SwipeableMethods,
    ) => React.ReactNode;
    onSwipeAction: (direction: 'left' | 'right', conversation: Conversation) => void;
    registerSwipeableRef: (id: string, ref: SwipeableMethods | null) => void;
}

/**
 * A single conversation-list row.
 *
 * Its own component so it can SUBSCRIBE to its participants' Oxy user data via
 * `useConversationDisplayName`. When the people cache is filled later, the
 * store subscription re-renders exactly this row with the real display name —
 * no out-of-band `getState()` read that the React Compiler could freeze on a
 * stale first value.
 */
const ConversationRow = React.memo(function ConversationRow({
    item,
    currentUserId,
    isActive,
    isSelected,
    isSelectionMode,
    leftSwipeAction,
    rightSwipeAction,
    styles,
    onPress,
    onLongPress,
    onAvatarLongPress,
    renderSwipeAction,
    onSwipeAction,
    registerSwipeableRef,
}: ConversationRowProps) {
    const isGroup = isGroupConversation(item);
    // Reactive: subscribes to this conversation's participant user cache.
    const displayName = useConversationDisplayName(item, currentUserId);
    const avatar = useConversationAvatar(item, currentUserId);
    // "Waiting for <name>" in place of the preview while the last message is
    // an own echo held for somebody who has not set up Allo.
    const { waiting } = useUnreachableMembers(item);
    const otherParticipants = getOtherParticipants(item, currentUserId);
    const participantCount = getParticipantCount(item, currentUserId);
    const leftEnabled = leftSwipeAction !== 'none';
    const rightEnabled = rightSwipeAction !== 'none';
    const swipeEnabled = !isSelectionMode && (leftEnabled || rightEnabled);

    const wrapperStyles = [
        styles.conversationItem,
        !isSelectionMode && isActive && styles.conversationItemSelected,
        isSelected && styles.conversationItemMultiSelected,
    ];

    const rowContent = (
        <TouchableOpacity
            activeOpacity={0.7}
            onLongPress={() => onLongPress(item.id)}
            onPress={() => onPress(item.id)}
            style={wrapperStyles}
        >
            <TouchableOpacity
                activeOpacity={0.7}
                onLongPress={() => onAvatarLongPress(item)}
                delayLongPress={300}
                style={styles.avatarContainer}
            >
                {isSelectionMode && (
                    <Animated.View
                        layout={LinearTransition.springify().damping(20)}
                        style={[
                            styles.selectionOverlay,
                            isSelected
                                ? styles.selectionOverlaySelected
                                : styles.selectionOverlayUnselected,
                        ]}
                    >
                        {isSelected && (
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
                        maxAvatars={6}
                    />
                ) : (
                    <ShapedConversationAvatar
                        userId={otherParticipants[0]?.id}
                        avatar={avatar}
                        displayName={displayName}
                        size={44}
                    />
                )}
            </TouchableOpacity>
            <View style={styles.conversationContent}>
                <View style={styles.conversationHeader}>
                    <View style={styles.conversationNameContainer}>
                        <View style={styles.conversationNameRow}>
                            <ThemedText style={styles.conversationName} numberOfLines={1}>
                                {displayName}
                            </ThemedText>
                            {isGroup && participantCount > 0 && (
                                <ThemedText
                                    style={[
                                        styles.conversationTimestamp,
                                        styles.participantCountLabel,
                                    ]}
                                    numberOfLines={1}
                                >
                                    ({participantCount})
                                </ThemedText>
                            )}
                        </View>
                    </View>
                    <ThemedText
                        style={[
                            styles.conversationTimestamp,
                            item.unreadCount > 0 && styles.conversationTimestampUnread,
                        ]}
                        numberOfLines={1}
                    >
                        {formatConversationTimestamp(item.timestamp)}
                    </ThemedText>
                </View>
                <View style={styles.conversationBottomRow}>
                    <ThemedText
                        style={[styles.conversationMessage, item.lastMessageHold !== undefined && styles.conversationMessageHeld]}
                        numberOfLines={1}
                        testID={item.lastMessageHold !== undefined ? 'conversation-waiting' : undefined}
                    >
                        {item.lastMessageHold !== undefined ? (waiting ?? '') : item.lastMessage}
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
        </TouchableOpacity>
    );

    return (
        <ReanimatedSwipeable
            ref={(ref: SwipeableMethods | null) => {
                registerSwipeableRef(item.id, ref);
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
                    onSwipeAction(direction, item);
                }
            }}
        >
            {rowContent}
        </ReanimatedSwipeable>
    );
});

/**
 * Swipe action rendered inside ReanimatedSwipeable.
 * Must be a component (not a closure) so we can use useAnimatedStyle.
 */
function SwipeAction({
    direction,
    dragAnimatedValue,
    windowWidth,
}: {
    direction: 'left' | 'right';
    dragAnimatedValue: SharedValue<number>;
    windowWidth: number;
}) {
    const animatedStyle = useAnimatedStyle(() => {
        const drag = dragAnimatedValue.value;
        const width = interpolate(
            drag,
            direction === 'left' ? [0, windowWidth] : [-windowWidth, 0],
            [0, windowWidth],
            'clamp',
        );
        return { width, maxWidth: windowWidth };
    });

    return (
        <Animated.View
            style={[
                {
                    justifyContent: 'center',
                    alignItems: 'center',
                    overflow: 'hidden',
                    backgroundColor: colors.chatUnreadBadge,
                },
                animatedStyle,
            ]}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 20 }}>
                <Ionicons
                    name="trash-outline"
                    size={20}
                    color="#FFFFFF"
                />
                <Text style={{ color: '#FFFFFF', fontSize: 14, fontWeight: '600' }}>
                    Delete
                </Text>
            </View>
        </Animated.View>
    );
}

function SkeletonRow({ index, theme }: { index: number; theme: ReturnType<typeof useTheme> }) {
    // Compuesto con las primitivas de `Skeleton` de Bloom en vez de con vistas y
    // una animación propias: el brillo vive en la librería compartida.
    return (
        <Skeleton.Row
            style={{
                paddingHorizontal: 12,
                paddingVertical: 10,
                minHeight: 64,
                alignItems: 'center',
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: theme.colors.border,
            }}
        >
            <Skeleton.Circle size={44} style={{ marginRight: 12 }} />
            <Skeleton.Col style={{ flex: 1, justifyContent: 'center' }}>
                <Skeleton.Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Skeleton.Box
                        width={SKELETON_NAME_WIDTHS[index % SKELETON_NAME_WIDTHS.length]}
                        height={14}
                        borderRadius={4}
                    />
                    <Skeleton.Box width={40} height={10} borderRadius={3} />
                </Skeleton.Row>
                <Skeleton.Box
                    width={SKELETON_MSG_WIDTHS[index % SKELETON_MSG_WIDTHS.length]}
                    height={12}
                    borderRadius={4}
                />
            </Skeleton.Col>
        </Skeleton.Row>
    );
}

function ConversationsSkeleton({ theme }: { theme: ReturnType<typeof useTheme> }) {
    return (
        <View style={{ flex: 1 }}>
            {Array.from({ length: 10 }, (_, i) => (
                <SkeletonRow key={i} index={i} theme={theme} />
            ))}
        </View>
    );
}

/**
 * Conversations list component
 * Displays list of all conversations with support for direct and group chats
 *
 * The list is the SDK's (`useChatConversations`), already decrypted on this
 * device and kept live by its sync. There is no archive: the platform has no
 * such state, and a swipe that "deletes" a conversation LEAVES it.
 */
export default function ConversationsList() {
    const theme = useTheme();
    const { t } = useTranslation();
    const { contentClearance: bottomBarClearance } = useBottomChrome();
    const pathname = usePathname();
    const router = useRouter();
    const { width: windowWidth } = useWindowDimensions();
    const conversations = useChatConversations();
    const syncState = useSyncState();
    const { leave, refresh } = useConversationActions();
    const leftSwipeAction = useConversationSwipePreferencesStore(state => state.leftSwipeAction);
    const rightSwipeAction = useConversationSwipePreferencesStore(state => state.rightSwipeAction);
    const usersById = useUsersStore((state) => state.usersById);

    // Get current user ID
    const { user } = useOxy();
    const currentUserId = user?.id;

    const [isRefreshing, setIsRefreshing] = useState(false);
    const handleRefresh = useCallback(async () => {
        setIsRefreshing(true);
        try {
            await refresh();
        } catch (error: unknown) {
            logger.warn('[Conversations] refresh failed', error);
        } finally {
            setIsRefreshing(false);
        }
    }, [refresh]);

    // Search state
    const [searchQuery, setSearchQuery] = useState('');

    // Filter conversations based on search query
    const visibleConversations = useMemo(() => {
        if (!searchQuery.trim()) {
            return conversations;
        }
        const query = searchQuery.toLowerCase();
        const getUser = (id: string) => usersById[id]?.data;
        return conversations.filter(conv =>
            getConversationDisplayName(conv, currentUserId, getUser).toLowerCase().includes(query) ||
            conv.lastMessage.toLowerCase().includes(query)
        );
    }, [conversations, searchQuery, usersById, currentUserId]);
    // Determine empty state messaging
    const noSearchResults = searchQuery.trim() && visibleConversations.length === 0;

    const emptyStateCopy = noSearchResults
        ? 'No conversations found.\nTry a different search term.'
        : 'No conversations yet.\nStart a new chat to get started!';

    // Track selected conversation from pathname
    // Matches both /c/:id format and legacy /(chat)/:id format
    const selectedId = useMemo(() => {
        const cMatch = pathname?.match(/\/c\/([^/]+)$/);
        const chatMatch = pathname?.match(/\/(chat)\/([^/]+)$/);
        return cMatch?.[1] || chatMatch?.[2] || null;
    }, [pathname]);

    // Multi-selection state
    const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(() => new Set());
    const isSelectionMode = selectedConversationIds.size > 0;
    const selectedCount = selectedConversationIds.size;

    // Peek preview state
    const [peekConversation, setPeekConversation] = useState<Conversation | null>(null);
    const peekVisible = peekConversation !== null;

    // Animation and refs
    const swipeableRefs = useRef<Record<string, { close: () => void } | null>>({});
    const swipeActionInFlight = useRef<Set<string>>(new Set());
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
            fontSize: 12,
            color: theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5,
        },
        conversationTimestampUnread: {
            color: colors.primaryColor,
            fontWeight: '600',
        },
        conversationBottomRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
        },
        conversationMessage: {
            fontSize: 13,
            color: theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5,
            flex: 1,
            marginRight: 8,
        },
        conversationMessageHeld: {
            fontStyle: 'italic',
        },
        unreadBadge: {
            backgroundColor: colors.primaryColor,
            borderRadius: 12,
            minWidth: 22,
            height: 22,
            paddingHorizontal: 6,
            justifyContent: 'center',
            alignItems: 'center',
        },
        unreadText: {
            color: '#FFFFFF',
            fontSize: 11,
            fontWeight: '700',
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
        conversationNameContainer: {
            flex: 1,
            marginRight: 8,
        },
        conversationNameRow: {
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
        },
        participantCountLabel: {
            marginLeft: 4,
        },
        syncBanner: {
            paddingHorizontal: 16,
            paddingVertical: 6,
            backgroundColor: theme.colors.backgroundSecondary,
        },
        syncBannerText: {
            fontSize: 12,
            color: theme.colors.textSecondary,
            textAlign: 'center',
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
        toggleConversationSelection(conversationId);
    }, [toggleConversationSelection]);

    /**
     * Handle avatar long-press to show peek preview (Telegram-style)
     */
    const handleAvatarLongPress = useCallback((conversation: Conversation) => {
        if (isSelectionMode) return; // Don't peek in selection mode
        setPeekConversation(conversation);
    }, [isSelectionMode]);

    /**
     * Handle opening the conversation from peek preview
     */
    const handlePeekOpen = useCallback(() => {
        if (!peekConversation) return;
        const conv = peekConversation;
        setPeekConversation(null);
        // Use unified /c/:id route for all conversations
        router.push(`/c/${conv.id}` as Href);
    }, [peekConversation, router]);

    /**
     * Handle conversation press - navigate or toggle selection
     */
    const handleConversationPress = useCallback((conversationId: string) => {
        if (isSelectionMode) {
            toggleConversationSelection(conversationId);
            return;
        }
        // Use unified /c/:id route for all conversations
        router.push(`/c/${conversationId}` as Href);
    }, [isSelectionMode, toggleConversationSelection, router]);

    /**
     * Leave conversations. There is no undo: leaving is a commit on the
     * group that every other member's device applies, so it is confirmed
     * first rather than offered as a toast to take back.
     */
    const leaveConversations = useCallback(async (ids: readonly string[]) => {
        if (ids.length === 0) return;
        const confirmed = await confirmDialog({
            title: ids.length === 1 ? t('chat.leave.conversation', 'Delete conversation') : t('chat.leave.many', 'Delete {{count}} conversations', { count: ids.length }),
            message: t('chat.leave.confirm', 'You will stop receiving messages here, and this device will no longer be able to read them.'),
            okText: t('common.delete', 'Delete'),
            cancelText: t('common.cancel', 'Cancel'),
            destructive: true,
        });
        if (!confirmed) return false;
        let failed = 0;
        for (const id of ids) {
            try {
                await leave(id);
            } catch (error: unknown) {
                failed += 1;
                logger.error('[Conversations] leave failed:', error);
            }
        }
        if (failed > 0) {
            toast.error(t('chat.leave.failed', 'The conversation could not be left'));
        } else {
            toast.success(ids.length === 1 ? t('chat.leave.done', 'Conversation deleted') : t('chat.leave.doneMany', 'Deleted {{count}} conversations', { count: ids.length }));
        }
        return true;
    }, [leave, t]);

    /**
     * Delete all selected conversations
     */
    const handleBulkDelete = useCallback(() => {
        const ids = Array.from(selectedConversationIds);
        void leaveConversations(ids).then((done) => {
            if (done) clearSelection();
        });
    }, [selectedConversationIds, leaveConversations, clearSelection]);

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
     * Register/clear a swipeable row's imperative handle.
     */
    const registerSwipeableRef = useCallback((id: string, ref: SwipeableMethods | null) => {
        swipeableRefs.current[id] = ref;
    }, []);

    /**
     * Render swipe action with animated width that fills space
     */
    const renderSwipeAction = useCallback((action: SwipeActionType, direction: 'left' | 'right') => {
        const SwipeActionRenderer = (_progress: SharedValue<number>, dragX: SharedValue<number>) => {
            if (action === 'none') {
                return null;
            }
            return (
                <SwipeAction
                    direction={direction}
                    dragAnimatedValue={dragX}
                    windowWidth={windowWidth}
                />
            );
        };
        SwipeActionRenderer.displayName = `SwipeActionRenderer(${action})`;
        return SwipeActionRenderer;
    }, [windowWidth]);

    /**
     * Handle swipe action on a conversation
     */
    const handleSwipeAction = useCallback((direction: 'left' | 'right', conversation: Conversation) => {
        // Guard against onSwipeableOpen firing twice for the same gesture
        if (swipeActionInFlight.current.has(conversation.id)) return;
        swipeActionInFlight.current.add(conversation.id);

        const action = direction === 'left' ? leftSwipeAction : rightSwipeAction;

        if (action === 'delete') {
            void leaveConversations([conversation.id]);
        }

        setTimeout(() => {
            closeSwipeable(conversation.id);
            swipeActionInFlight.current.delete(conversation.id);
        }, 200);
    }, [leftSwipeAction, rightSwipeAction, closeSwipeable, leaveConversations]);

    /**
     * Search bar header component (memoized to prevent re-renders)
     */
    const SearchBarHeader = useMemo(() => {
        if (isSelectionMode) return null;

        return (
            <View style={styles.searchBarContainer}>
                <Search
                    label="Ask Oxy AI or Search"
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    onClearText={() => setSearchQuery('')}
                />
            </View>
        );
    }, [isSelectionMode, searchQuery, styles.searchBarContainer]);

    /**
     * Render individual conversation item (useCallback for FlatList stability)
     */
    const renderConversationItem = useCallback(({ item }: { item: Conversation }) => (
        <ConversationRow
            item={item}
            currentUserId={currentUserId}
            isActive={selectedId === item.id}
            isSelected={selectedConversationIds.has(item.id)}
            isSelectionMode={isSelectionMode}
            leftSwipeAction={leftSwipeAction}
            rightSwipeAction={rightSwipeAction}
            styles={styles}
            onPress={handleConversationPress}
            onLongPress={handleConversationLongPress}
            onAvatarLongPress={handleAvatarLongPress}
            renderSwipeAction={renderSwipeAction}
            onSwipeAction={handleSwipeAction}
            registerSwipeableRef={registerSwipeableRef}
        />
    ), [selectedId, selectedConversationIds, isSelectionMode, currentUserId, leftSwipeAction, rightSwipeAction, styles, renderSwipeAction, handleSwipeAction, handleConversationLongPress, handleConversationPress, handleAvatarLongPress, registerSwipeableRef]);

    // FlashList performance: stable references prevent re-renders
    const keyExtractor = useCallback((item: Conversation) => item.id, []);

    // The first sync of a fresh device has nothing to show yet; the skeleton
    // covers it and nothing else. `idle` is before the client has started.
    const isFirstSync = conversations.length === 0 && (syncState === 'idle' || syncState === 'syncing');

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
                                        // TODO: Implement camera functionality
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

                {syncState === 'offline' && (
                    <View style={styles.syncBanner}>
                        <ThemedText style={styles.syncBannerText}>{t('chat.sync.offline', 'Offline — showing what this device has')}</ThemedText>
                    </View>
                )}
                <HistoryTransferBanner />

                <>
                    {isFirstSync ? (
                        <ConversationsSkeleton theme={theme} />
                    ) : visibleConversations.length > 0 ? (
                        <FlashList
                            data={visibleConversations}
                            renderItem={renderConversationItem}
                            keyExtractor={keyExtractor}
                            extraData={selectedConversationIds}
                            ListHeaderComponent={SearchBarHeader}
                            contentContainerStyle={{ paddingBottom: bottomBarClearance }}

                            keyboardShouldPersistTaps="handled"
                            refreshControl={
                                <RefreshControl
                                    refreshing={isRefreshing}
                                    onRefresh={() => { void handleRefresh(); }}
                                    tintColor={theme.colors.primary}
                                    colors={[theme.colors.primary]}
                                />
                            }
                        />
                    ) : (
                        <>
                            {SearchBarHeader}
                            <EmptyState
                                lottieSource={require('@/assets/lottie/welcome.json')}
                                title={emptyStateCopy}
                            />
                        </>
                    )}
                </>

                <Link
                    href="/(chat)/settings"
                    style={styles.settingsButton}
                    asChild
                >
                    <TouchableOpacity activeOpacity={0.7}>
                        <ThemedText style={styles.settingsButtonText}>Settings</ThemedText>
                    </TouchableOpacity>
                </Link>

                {/* Telegram-style peek preview on avatar long-press */}
                <ConversationPeekPreview
                    visible={peekVisible}
                    conversation={peekConversation}
                    currentUserId={currentUserId}
                    onClose={() => setPeekConversation(null)}
                    onOpen={handlePeekOpen}
                />
            </ThemedView>
        </SafeAreaView>
    );
}
