import React, { memo, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  useWindowDimensions,
  ScrollView,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  Easing,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { colors } from '@/styles/colors';
import Avatar from '@/components/Avatar';
import { GroupAvatar } from '@/components/GroupAvatar';
import { MessageBlock } from '@/components/messages/MessageBlock';
import { DaySeparator } from '@/components/messages/DaySeparator';
import { useMessagesStore } from '@/stores/messagesStore';
import type { Conversation } from '@/app/(chat)/index';
import {
  getConversationDisplayName,
  getOtherParticipants,
  isGroupConversation,
} from '@/utils/conversationUtils';
import {
  groupMessagesByTime,
  formatMessageGroupsWithDays,
} from '@/utils/messageGrouping';

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);

const MAX_PREVIEW_MESSAGES = 6;

// Stable empty array to prevent Zustand selector from creating new references each render
const EMPTY_MESSAGES: any[] = [];

// No-op handlers for read-only preview
const NOOP = () => {};

interface ConversationPeekPreviewProps {
  visible: boolean;
  conversation: Conversation | null;
  currentUserId?: string;
  onClose: () => void;
  onOpen: () => void;
}

/**
 * Telegram-style conversation peek preview.
 * Shows a blurred overlay with recent messages when the user
 * long-presses a conversation avatar.
 * Uses the same MessageBlock + DaySeparator rendering pipeline as ConversationView.
 */
export const ConversationPeekPreview = memo<ConversationPeekPreviewProps>(({
  visible,
  conversation,
  currentUserId,
  onClose,
  onOpen,
}) => {
  const theme = useTheme();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  // Animation shared values
  const blurIntensity = useSharedValue(0);
  const cardOpacity = useSharedValue(0);
  const cardScale = useSharedValue(0.92);

  // Get messages from store (use stable empty ref to prevent infinite re-render loop)
  const conversationId = conversation?.id;
  const messages = useMessagesStore((state) =>
    conversationId ? (state.messagesByConversation[conversationId] || EMPTY_MESSAGES) : EMPTY_MESSAGES
  );

  // Take last N messages and group them using the same pipeline as ConversationView
  const messageGroups = useMemo(() => {
    if (messages.length === 0) return [];
    const recent = messages.slice(-MAX_PREVIEW_MESSAGES);
    const groups = groupMessagesByTime(recent);
    return formatMessageGroupsWithDays(groups);
  }, [messages]);

  const isGroup = conversation ? isGroupConversation(conversation) : false;
  const displayName = conversation ? getConversationDisplayName(conversation, currentUserId) : '';
  const otherParticipants = conversation ? getOtherParticipants(conversation, currentUserId) : [];

  // Sender info callbacks (same pattern as ConversationView via useSenderInfo)
  const getSenderName = useCallback((senderId: string): string | undefined => {
    if (!isGroup || !conversation?.participants) return undefined;
    const participant = conversation.participants.find((p) => p.id === senderId);
    return participant?.name?.first || participant?.username;
  }, [isGroup, conversation?.participants]);

  const getSenderAvatar = useCallback((senderId: string): string | undefined => {
    if (!conversation?.participants) return undefined;
    const participant = conversation.participants.find((p) => p.id === senderId);
    return participant?.avatar;
  }, [conversation?.participants]);

  // Dummy getMediaUrl for preview (media won't be interactive)
  const getMediaUrl = useCallback((mediaId: string): string => {
    return `media://${mediaId}`;
  }, []);

  // Animate in/out
  useEffect(() => {
    if (visible) {
      blurIntensity.value = withTiming(60, {
        duration: 250,
        easing: Easing.out(Easing.cubic),
      });
      cardOpacity.value = withTiming(1, {
        duration: 200,
        easing: Easing.out(Easing.quad),
      });
      cardScale.value = withSpring(1, {
        damping: 18,
        stiffness: 200,
        mass: 0.8,
      });
    } else {
      blurIntensity.value = withTiming(0, {
        duration: 180,
        easing: Easing.in(Easing.cubic),
      });
      cardOpacity.value = withTiming(0, {
        duration: 150,
        easing: Easing.in(Easing.cubic),
      });
      cardScale.value = withTiming(0.92, {
        duration: 150,
        easing: Easing.in(Easing.cubic),
      });
    }
  }, [visible]); // shared values are stable refs — not needed in deps

  const blurStyle = useAnimatedStyle(() => ({
    opacity: blurIntensity.value / 60, // normalized 0-1
  }));

  const cardAnimatedStyle = useAnimatedStyle(() => ({
    opacity: cardOpacity.value,
    transform: [{ scale: cardScale.value }],
  }));

  const cardWidth = Math.min(screenWidth - 40, 380);

  const styles = useMemo(() => StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    blur: {
      ...StyleSheet.absoluteFillObject,
    },
    card: {
      width: cardWidth,
      maxHeight: screenHeight * 0.6,
      borderRadius: 16,
      backgroundColor: theme.colors.background,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.25,
      shadowRadius: 16,
      elevation: 12,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.background,
    },
    headerInfo: {
      flex: 1,
      marginLeft: 12,
    },
    headerName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    headerSubtitle: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginTop: 1,
    },
    messagesContainer: {
      paddingVertical: 8,
    },
    emptyMessages: {
      paddingVertical: 32,
      alignItems: 'center',
    },
    emptyText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    footer: {
      flexDirection: 'row',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
    },
    footerButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 12,
      gap: 6,
    },
    footerButtonText: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.primary || colors.primaryColor,
    },
    footerDivider: {
      width: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.border,
    },
  }), [theme, cardWidth, screenHeight]);

  if (!conversation) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={styles.overlay}
        activeOpacity={1}
        onPress={onClose}
      >
        {/* Blur backdrop */}
        <AnimatedBlurView
          intensity={60}
          tint={theme.isDark ? 'dark' : 'light'}
          style={[styles.blur, blurStyle]}
        />

        {/* Preview card */}
        <Animated.View style={[styles.card, cardAnimatedStyle]}>
          {/* Header with avatar and name */}
          <View style={styles.header}>
            {isGroup && otherParticipants.length > 0 ? (
              <GroupAvatar
                participants={otherParticipants}
                size={40}
                maxAvatars={2}
              />
            ) : (
              <Avatar
                size={40}
                source={
                  otherParticipants[0]?.avatar
                    ? { uri: otherParticipants[0].avatar }
                    : undefined
                }
                label={displayName.charAt(0).toUpperCase()}
              />
            )}
            <View style={styles.headerInfo}>
              <Text style={styles.headerName} numberOfLines={1}>
                {displayName}
              </Text>
              {isGroup && conversation.participantCount && (
                <Text style={styles.headerSubtitle}>
                  {conversation.participantCount} participants
                </Text>
              )}
            </View>
          </View>

          {/* Message preview — uses same MessageBlock + DaySeparator as ConversationView */}
          <ScrollView
            style={styles.messagesContainer}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 4 }}
          >
            {messageGroups.length > 0 ? (
              messageGroups.map((group, index) => (
                <View key={`group-${index}`}>
                  {group.showDaySeparator && (
                    <DaySeparator date={group.timestamp} />
                  )}
                  <MessageBlock
                    group={group}
                    isGroup={isGroup}
                    getSenderName={getSenderName}
                    getSenderAvatar={getSenderAvatar}
                    getMediaUrl={getMediaUrl}
                    onMessagePress={NOOP}
                  />
                </View>
              ))
            ) : (
              <View style={styles.emptyMessages}>
                <Text style={styles.emptyText}>No messages yet</Text>
              </View>
            )}
          </ScrollView>

          {/* Footer actions */}
          <View style={styles.footer}>
            <TouchableOpacity
              style={styles.footerButton}
              onPress={onOpen}
              activeOpacity={0.7}
            >
              <Ionicons
                name="chatbubble-outline"
                size={18}
                color={theme.colors.primary || colors.primaryColor}
              />
              <Text style={styles.footerButtonText}>Open</Text>
            </TouchableOpacity>
            <View style={styles.footerDivider} />
            <TouchableOpacity
              style={styles.footerButton}
              onPress={onClose}
              activeOpacity={0.7}
            >
              <Ionicons
                name="close-outline"
                size={18}
                color={theme.colors.primary || colors.primaryColor}
              />
              <Text style={styles.footerButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </TouchableOpacity>
    </Modal>
  );
});

ConversationPeekPreview.displayName = 'ConversationPeekPreview';
