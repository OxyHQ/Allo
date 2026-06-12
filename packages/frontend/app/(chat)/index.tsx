import React, { useContext, useMemo, useRef, useCallback, useState, useEffect } from 'react';
import {
    Platform,
    StyleSheet,
    View,
    Text,
    TouchableOpacity,
    TextInput,
    useWindowDimensions,
    RefreshControl,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Link, useRouter, usePathname } from 'expo-router';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Menu, MenuOptions, MenuOption, MenuTrigger } from 'react-native-popup-menu';
import * as ImagePicker from 'expo-image-picker';
import { useTranslation } from 'react-i18next';
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
import { Ionicons } from '@expo/vector-icons';
import { toast } from '@/lib/sonner';
import type { Network } from '@allo/shared-types';

// Components
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { GroupAvatar } from '@/components/GroupAvatar';
import { EmptyState } from '@/components/shared/EmptyState';
import { OfflineBanner } from '@/components/shared/OfflineBanner';
import { ChatPicker } from '@/components/shared/ChatPicker';

// Hooks
import { useTheme } from '@/hooks/useTheme';
import { useOxy } from '@oxyhq/services';
import {
    useConversationsStore,
    useConversationSwipePreferencesStore,
    useMessagesStore,
    SwipeActionType,
} from '@/stores';
import { BottomSheetContext } from '@/context/BottomSheetContext';

// Conversation peek preview
import { ConversationPeekPreview } from '@/components/conversation/ConversationPeekPreview';
import { PresenceDot } from '@/components/conversation/PresenceDot';

// Interop bridge (F3.x): network badge for bridged conversations.
import { NetworkBadge } from '@/components/bridge/NetworkBadge';

// Utils
import {
    getConversationDisplayName,
    getConversationAvatar,
    getOtherParticipants,
    getParticipantCount,
    isGroupConversation,
} from '@/utils/conversationUtils';
import { formatConversationTimestamp } from '@/utils/dateUtils';
import { useAvatarShape } from '@/hooks/useAvatarShape';
import { useSubscribePresence } from '@/hooks/usePresence';

// Skeleton dimension lookup tables (module-level to avoid re-allocation per render)
const SKELETON_NAME_WIDTHS = [140, 110, 160, 120, 130, 100, 150, 115, 145, 125] as const;
const SKELETON_MSG_WIDTHS = [200, 170, 220, 180, 150, 210, 190, 160, 230, 175] as const;

// Export types for use in other files
export type ConversationType = 'direct' | 'group';

export interface ConversationParticipant {
    id: string;
    name?: {
        first: string;
        last: string;
    };
    username?: string;
    avatar?: string;
}

/**
 * A person on an EXTERNAL network (Telegram, etc.) who is part of a bridged
 * conversation. Interop bridge (F3.x): mirrors the backend `ExternalParticipant`
 * shape. External people are deliberately kept OUT of `participants[]` — they
 * carry no Oxy user identity — so a bridged direct chat draws its name/avatar
 * from `externalParticipants[0]` instead.
 */
export interface ExternalParticipant {
    network: Network;
    externalId: string;
    displayName?: string;
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
    theme?: string; // Color theme ID (shared with all participants)
    // Group-specific fields
    participants?: ConversationParticipant[]; // All participants (including current user for groups)
    groupName?: string; // Custom group name (optional)
    groupAvatar?: string; // Custom group avatar (optional)
    participantCount?: number; // Number of participants (for groups)
    // Interop bridge (F3.x): the network this conversation rides on. Native Allo
    // chats are 'allo' (default); bridged chats report e.g. 'telegram'. Drives
    // capability gating, the transparency banner, and the E2E-indicator gate.
    network?: Network;
    // Interop bridge (F3.x): external (non-Oxy) people in a bridged conversation.
    externalParticipants?: ExternalParticipant[];
}

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

/**
 * Swipe action rendered inside ReanimatedSwipeable.
 * Must be a component (not a closure) so we can use useAnimatedStyle.
 */
function SwipeAction({
    action,
    direction,
    dragAnimatedValue,
    windowWidth,
}: {
    action: SwipeActionType;
    direction: 'left' | 'right';
    dragAnimatedValue: SharedValue<number>;
    windowWidth: number;
}) {
    const isDelete = action === 'delete';
    const theme = useTheme();

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
                    backgroundColor: isDelete ? theme.colors.error : theme.colors.success,
                },
                animatedStyle,
            ]}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 20 }}>
                <Ionicons
                    name={isDelete ? 'trash-outline' : 'archive-outline'}
                    size={20}
                    color="#FFFFFF"
                />
                <Text style={{ color: '#FFFFFF', fontSize: 14, fontWeight: '600' }}>
                    {isDelete ? 'Delete' : 'Archive'}
                </Text>
            </View>
        </Animated.View>
    );
}

function SkeletonRow({ index, theme }: { index: number; theme: ReturnType<typeof useTheme> }) {
    const opacity = useSharedValue(0.3);

    useEffect(() => {
        opacity.value = withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }, () => {
            opacity.value = withTiming(0.3, { duration: 800, easing: Easing.inOut(Easing.ease) });
        });
        const interval = setInterval(() => {
            opacity.value = withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }, () => {
                opacity.value = withTiming(0.3, { duration: 800, easing: Easing.inOut(Easing.ease) });
            });
        }, 1600);
        return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
    const bone = theme.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

    return (
        <Animated.View style={[{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 12,
            paddingVertical: 10,
            minHeight: 64,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: theme.colors.border,
        }, animStyle]}>
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: bone, marginRight: 12 }} />
            <View style={{ flex: 1, justifyContent: 'center' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <View style={{ width: SKELETON_NAME_WIDTHS[index % SKELETON_NAME_WIDTHS.length], height: 14, borderRadius: 4, backgroundColor: bone }} />
                    <View style={{ width: 40, height: 10, borderRadius: 3, backgroundColor: bone }} />
                </View>
                <View style={{ width: SKELETON_MSG_WIDTHS[index % SKELETON_MSG_WIDTHS.length], height: 12, borderRadius: 4, backgroundColor: bone }} />
            </View>
        </Animated.View>
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
 * Follows Expo Router 54 best practices:
 * - Uses Link components for navigation
 * - Derives selected state from pathname
 * - Supports responsive layouts
 */
export default function ConversationsList() {
    const theme = useTheme();
    const pathname = usePathname();
    const router = useRouter();
    const { t } = useTranslation();
    const { width: windowWidth } = useWindowDimensions();
    const bottomSheet = useContext(BottomSheetContext);
    const sendAttachmentMessage = useMessagesStore(state => state.sendAttachmentMessage);
    // Get conversations from store
    const conversations = useConversationsStore(state => state.conversations);
    const loadCachedConversations = useConversationsStore(state => state.loadCachedConversations);
    const fetchConversations = useConversationsStore(state => state.fetchConversations);
    const refreshConversations = useConversationsStore(state => state.refreshConversations);
    const isLoading = useConversationsStore(state => state.isLoading);
    const isRefreshing = useConversationsStore(state => state.isRefreshing);
    const hasFetchedOnce = useConversationsStore(state => state.hasFetchedOnce);
    const archiveConversation = useConversationsStore(state => state.archiveConversation);
    const unarchiveConversation = useConversationsStore(state => state.unarchiveConversation);
    const removeConversation = useConversationsStore(state => state.removeConversation);
    const leftSwipeAction = useConversationSwipePreferencesStore(state => state.leftSwipeAction);
    const rightSwipeAction = useConversationSwipePreferencesStore(state => state.rightSwipeAction);

    // Offline-first: load cached conversations instantly, then fetch from API in parallel
    // Cache shows data immediately; API fetch updates in the background
    useEffect(() => {
        // Fire both immediately — cache resolves fast, API runs in background
        loadCachedConversations();
        fetchConversations();
    }, [loadCachedConversations, fetchConversations]);

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

    // Get current user ID and oxy services
    const { user, oxyServices, logout } = useOxy();
    const currentUserId = user?.id;

    // Online presence: subscribe to the direct (1:1) partners currently in the
    // list. Group conversations don't show a presence dot, so they're excluded.
    // The hook bootstraps via REST and wires the shared `presence:update`
    // listener; rows read their own dot via the per-user store selector.
    const directPartnerIds = useMemo(() => {
        const ids = new Set<string>();
        for (const conv of conversations) {
            if (isGroupConversation(conv)) continue;
            const partnerId = getOtherParticipants(conv, currentUserId)[0]?.id;
            if (partnerId) ids.add(partnerId);
        }
        return Array.from(ids);
    }, [conversations, currentUserId]);
    useSubscribePresence(directPartnerIds);

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
        menuOptionRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingHorizontal: 12,
            paddingVertical: 10,
        },
        menuOptionText: {
            fontSize: 15,
            color: theme.colors.text,
            fontWeight: '500',
        },
        menuOptionTextDanger: {
            color: theme.colors.error,
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
            backgroundColor: theme.colors.backgroundSecondary,
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
            fontSize: 12,
            color: theme.colors.textSecondary,
        },
        conversationTimestampUnread: {
            color: theme.colors.primary,
            fontWeight: '600',
        },
        conversationBottomRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
        },
        conversationMessage: {
            fontSize: 13,
            color: theme.colors.textSecondary,
            flex: 1,
            marginRight: 8,
        },
        unreadBadge: {
            backgroundColor: theme.colors.primary,
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
            backgroundColor: theme.colors.success,
        },
        swipeActionDelete: {
            backgroundColor: theme.colors.error,
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
        conversationNetworkBadge: {
            marginLeft: 6,
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
        router.push(`/c/${conv.id}` as any);
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
        router.push(`/c/${conversationId}` as any);
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
        removeConversation(conversationId);

        toast.error(`Deleted "${conversationName}"`, {
            duration: 4000,
        });
    }, [removeConversation]);

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

    /**
     * Send a captured photo to the chosen conversation. The store encrypts the
     * local source once and uploads only the ciphertext (E2E media, Fase 1D).
     */
    const sendPhotoToConversation = useCallback(async (
        conversation: Conversation,
        asset: ImagePicker.ImagePickerAsset,
    ) => {
        if (!currentUserId) return;

        const recipient = getOtherParticipants(conversation, currentUserId)[0]?.id;
        if (!recipient) {
            toast.error(t('chat.photoSendFailed'));
            return;
        }

        const toastId = toast.loading(t('chat.uploadingMedia'));
        try {
            const mime = asset.mimeType || 'image/jpeg';
            const result = await sendAttachmentMessage(
                conversation.id,
                {
                    attachmentType: 'image',
                    media: [
                        {
                            id: `local-${Date.now()}`,
                            type: mime === 'image/gif' ? 'gif' : 'image',
                            localUri: asset.uri,
                            width: asset.width,
                            height: asset.height,
                            fileSize: asset.fileSize,
                            mimeType: mime,
                            fileName: asset.fileName || `photo-${Date.now()}.jpg`,
                        },
                    ],
                },
                currentUserId,
                recipient,
            );

            if (result) {
                toast.success(t('chat.photoSent'));
            } else {
                toast.error(t('chat.photoSendFailed'));
            }
        } catch (error) {
            console.error('[ConversationsList] Error sending camera photo:', error);
            toast.error(t('chat.photoSendFailed'));
        } finally {
            toast.dismiss(toastId);
        }
    }, [currentUserId, sendAttachmentMessage, t]);

    /**
     * Camera header button — open the camera, then pick a destination chat.
     */
    const handleCameraPress = useCallback(async () => {
        try {
            if (Platform.OS !== 'web') {
                const perm = await ImagePicker.requestCameraPermissionsAsync();
                if (!perm.granted) {
                    toast.error(t('chat.cameraPermissionDenied'));
                    return;
                }
            }

            const result = await ImagePicker.launchCameraAsync({
                mediaTypes: ImagePicker.MediaTypeOptions.Images,
                quality: 0.9,
                exif: false,
            });
            if (result.canceled || !result.assets?.length) return;

            const asset = result.assets[0];
            const closeSheet = () => bottomSheet.openBottomSheet(false);
            bottomSheet.setBottomSheetContent(
                <ChatPicker
                    title={t('chat.selectChat')}
                    onSelect={(conversation) => {
                        void sendPhotoToConversation(conversation, asset);
                    }}
                    onClose={closeSheet}
                />
            );
            bottomSheet.openBottomSheet(true);
        } catch (error) {
            console.error('[ConversationsList] Camera flow error:', error);
            toast.error(t('chat.photoSendFailed'));
        }
    }, [bottomSheet, sendPhotoToConversation, t]);

    /**
     * Options menu — sign out with confirmation handled by Oxy session manager.
     */
    const handleSignOut = useCallback(async () => {
        // The protected-route guard navigates to the welcome screen automatically
        // once `isAuthenticated` flips; `useAuthCleanup` wipes session state.
        try {
            await logout?.();
        } catch (error) {
            console.error('[ConversationsList] Sign out error:', error);
            toast.error(t('chat.signOutFailed'));
        }
    }, [logout, t]);

    // Animated styles for header background during selection mode
    const headerBackgroundColor = theme.colors.background;
    const headerBorderColor = theme.colors.border;
    const headerSelectionColor = theme.colors.primary;

    const headerAnimatedStyle = useAnimatedStyle(() => ({
        backgroundColor: interpolateColor(
            selectionModeProgress.value,
            [0, 1],
            [headerBackgroundColor, headerSelectionColor],
        ),
        borderBottomColor: interpolateColor(
            selectionModeProgress.value,
            [0, 1],
            [headerBorderColor, headerSelectionColor],
        ),
    }), [headerBackgroundColor, headerBorderColor, headerSelectionColor]);

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
        const SwipeActionRenderer = (_progress: SharedValue<number>, dragX: SharedValue<number>) => {
            if (action === 'none') {
                return null;
            }
            return (
                <SwipeAction
                    action={action}
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

        if (action === 'none') {
            closeSwipeable(conversation.id);
            swipeActionInFlight.current.delete(conversation.id);
            return;
        }

        if (action === 'archive') {
            handleArchiveConversation(conversation.id, conversation.name);
        } else if (action === 'delete') {
            handleDeleteConversation(conversation.id, conversation.name);
        }

        setTimeout(() => {
            closeSwipeable(conversation.id);
            swipeActionInFlight.current.delete(conversation.id);
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
     * Render individual conversation item (useCallback for FlatList stability)
     */
    const renderConversationItem = useCallback(({ item }: { item: Conversation }) => {
        const isActiveConversation = selectedId === item.id;
        const isItemSelected = selectedConversationIds.has(item.id);
        const isGroup = isGroupConversation(item);
        const displayName = getConversationDisplayName(item, currentUserId);
        const avatar = getConversationAvatar(item, currentUserId, oxyServices);
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
                <TouchableOpacity
                    activeOpacity={0.7}
                    onLongPress={() => handleAvatarLongPress(item)}
                    delayLongPress={300}
                    style={styles.avatarContainer}
                >
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
                    {/* Online dot for direct conversations (subscribes to its own user). */}
                    {!isGroup && (
                        <PresenceDot userId={otherParticipants[0]?.id} />
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
                                {/* Interop bridge (F3.x): network pill (hidden for native Allo). */}
                                <View style={styles.conversationNetworkBadge}>
                                    <NetworkBadge network={item.network} size="sm" />
                                </View>
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
                        <ThemedText style={styles.conversationMessage} numberOfLines={1}>
                            {item.lastMessage}
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
                // @ts-expect-error ReanimatedSwipeable expects RefObject but callback ref works at runtime
                ref={(ref: any) => {
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
            </ReanimatedSwipeable>
        );
    }, [selectedId, selectedConversationIds, isSelectionMode, currentUserId, oxyServices, leftSwipeAction, rightSwipeAction, styles, renderSwipeAction, handleSwipeAction, handleConversationLongPress, handleConversationPress, handleAvatarLongPress]);

    // FlashList performance: stable references prevent re-renders
    const ITEM_HEIGHT = 64;
    const keyExtractor = useCallback((item: Conversation) => item.id, []);

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
                                        void handleCameraPress();
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
                                <Menu>
                                    <MenuTrigger
                                        customStyles={{
                                            triggerWrapper: styles.headerIconButton,
                                        }}
                                    >
                                        <Ionicons
                                            name="ellipsis-vertical"
                                            size={24}
                                            color={theme.colors.text}
                                        />
                                    </MenuTrigger>
                                    <MenuOptions
                                        customStyles={{
                                            optionsContainer: {
                                                backgroundColor: theme.colors.card || theme.colors.background,
                                                borderRadius: 12,
                                                paddingVertical: 4,
                                                marginTop: 32,
                                                width: 200,
                                            },
                                        }}
                                    >
                                        <MenuOption onSelect={() => router.push('/new' as any)}>
                                            <View style={styles.menuOptionRow}>
                                                <Ionicons
                                                    name="people-outline"
                                                    size={20}
                                                    color={theme.colors.text}
                                                />
                                                <Text style={styles.menuOptionText}>
                                                    {t('chat.menuNewGroup')}
                                                </Text>
                                            </View>
                                        </MenuOption>
                                        <MenuOption onSelect={() => router.push('/(chat)/settings' as any)}>
                                            <View style={styles.menuOptionRow}>
                                                <Ionicons
                                                    name="settings-outline"
                                                    size={20}
                                                    color={theme.colors.text}
                                                />
                                                <Text style={styles.menuOptionText}>
                                                    {t('chat.menuSettings')}
                                                </Text>
                                            </View>
                                        </MenuOption>
                                        <MenuOption onSelect={() => { void handleSignOut(); }}>
                                            <View style={styles.menuOptionRow}>
                                                <Ionicons
                                                    name="log-out-outline"
                                                    size={20}
                                                    color={theme.colors.error}
                                                />
                                                <Text style={[styles.menuOptionText, styles.menuOptionTextDanger]}>
                                                    {t('chat.menuSignOut')}
                                                </Text>
                                            </View>
                                        </MenuOption>
                                    </MenuOptions>
                                </Menu>
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

                <OfflineBanner />

                {isLoading && !hasFetchedOnce && conversations.length === 0 ? (
                    <ConversationsSkeleton theme={theme} />
                ) : visibleConversations.length > 0 ? (
                    <FlashList
                        data={visibleConversations}
                        renderItem={renderConversationItem}
                        keyExtractor={keyExtractor}
                        extraData={selectedConversationIds}
                        ListHeaderComponent={SearchBarHeader}

                        keyboardShouldPersistTaps="handled"
                        // @ts-expect-error estimatedItemSize exists at runtime but not in this version's types
                        estimatedItemSize={ITEM_HEIGHT}
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
                        <EmptyState
                            lottieSource={require('@/assets/lottie/welcome.json')}
                            title={emptyStateCopy}
                        />
                    </>
                )}

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
