import React, { useState, useMemo } from 'react';
import {
    StyleSheet,
    View,
    Text,
    FlatList,
    TouchableOpacity,
    useWindowDimensions,
} from 'react-native';
import { Link, usePathname } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { colors } from '@/styles/colors';
import Avatar from '@/components/Avatar';
import { GroupAvatar } from '@/components/GroupAvatar';
import {
    getConversationDisplayName,
    getConversationAvatar,
    getOtherParticipants,
    getParticipantCount,
    isGroupConversation,
} from '@/utils/conversationUtils';
import { useConversations } from '@/hooks/useConversation';

// Export types for use in other files
export type ConversationType = 'direct' | 'group';

export interface ConversationParticipant {
    id: string;
    name: string;
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
    // Group-specific fields
    participants?: ConversationParticipant[]; // All participants (including current user for groups)
    groupName?: string; // Custom group name (optional)
    groupAvatar?: string; // Custom group avatar (optional)
    participantCount?: number; // Number of participants (for groups)
}

export default function ConversationsList() {
    const theme = useTheme();
    const pathname = usePathname();
    const { width } = useWindowDimensions();
    const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });
    const conversations = useConversations(); // Use hook instead of local state
    
    // Track selected conversation from pathname - check both /c/:id and /(chat)/:id
    const selectedId = pathname?.match(/\/c\/([^/]+)$/)?.[1] || 
                       pathname?.match(/\/(chat)\/([^/]+)$/)?.[2] || 
                       null;

    // Mock current user ID - replace with actual user ID from your auth system
    const currentUserId = 'current-user';

    const styles = useMemo(() => StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: theme.colors.background,
        },
        header: {
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
            backgroundColor: theme.colors.background,
        },
        headerTitle: {
            fontSize: 20,
            fontWeight: 'bold',
            color: theme.colors.text,
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
        avatarContainer: {
            width: 44,
            height: 44,
            marginRight: 12,
            alignItems: 'center',
            justifyContent: 'center',
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


    const renderConversationItem = ({ item }: { item: Conversation }) => {
        const isSelected = selectedId === item.id;
        const isGroup = isGroupConversation(item);
        const displayName = getConversationDisplayName(item, currentUserId);
        const avatar = getConversationAvatar(item, currentUserId);
        const otherParticipants = getOtherParticipants(item, currentUserId);
        const participantCount = getParticipantCount(item, currentUserId);

        return (
            <Link
                href={`/c/${item.id}` as any}
                style={[
                    styles.conversationItem,
                    isSelected && styles.conversationItemSelected,
                ]}
                asChild
            >
                <TouchableOpacity activeOpacity={0.7}>
                    <View style={styles.avatarContainer}>
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
            </Link>
        );
    };

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            <ThemedView style={styles.container}>
                <View style={styles.header}>
                    <ThemedText style={styles.headerTitle}>Messages</ThemedText>
                </View>

                {conversations.length > 0 ? (
                    <FlatList
                        style={styles.list}
                        data={conversations}
                        renderItem={renderConversationItem}
                        keyExtractor={(item) => item.id}
                        contentContainerStyle={{ flexGrow: 1 }}
                    />
                ) : (
                    <View style={styles.emptyState}>
                        <ThemedText style={styles.emptyStateText}>
                            No conversations yet.{'\n'}Start a new chat to get started!
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
