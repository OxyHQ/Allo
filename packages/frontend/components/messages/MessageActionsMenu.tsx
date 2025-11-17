import React, { memo, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, useWindowDimensions } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  Easing,
  interpolate,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { useTheme } from '@/hooks/useTheme';

export interface MessageAction {
  label: string;
  icon?: React.ReactNode;
  onPress: () => void;
  destructive?: boolean;
}

export interface MessageActionsMenuProps {
  visible: boolean;
  actions: MessageAction[];
  onClose: () => void;
  messagePosition?: { x: number; y: number; width?: number; height?: number };
  messageElement?: React.ReactNode;
  showReactions?: boolean;
  reactions?: string[];
  onReactionSelect?: (emoji: string) => void;
}

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);
const DEFAULT_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/**
 * MessageActionsMenu Component
 * 
 * Displays a context menu for message actions (like WhatsApp iOS)
 */
export const MessageActionsMenu = memo<MessageActionsMenuProps>(({
  visible,
  actions,
  onClose,
  messagePosition,
  messageElement,
  showReactions = true,
  reactions,
  onReactionSelect,
}) => {
  const theme = useTheme();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const reactionEmojis = useMemo(
    () => (reactions && reactions.length > 0 ? reactions : DEFAULT_REACTIONS),
    [reactions]
  );
  const shouldShowReactions = showReactions && reactionEmojis.length > 0;
  
  // Shared values for animations
  const menuOpacity = useSharedValue(0);
  const menuScale = useSharedValue(0.9);
  const blurIntensity = useSharedValue(0);
  const messageOpacity = useSharedValue(0);
  const reactionsOpacity = useSharedValue(0);
  const reactionsScale = useSharedValue(0.85);
  
  useEffect(() => {
    if (visible) {
      // Animate blur intensity
      blurIntensity.value = withTiming(80, {
        duration: 250,
        easing: Easing.out(Easing.cubic),
      });
      
      // Animate message fade in
      messageOpacity.value = withTiming(1, {
        duration: 200,
        easing: Easing.out(Easing.quad),
      });
      
      // Animate menu with spring for natural feel
      menuOpacity.value = withTiming(1, {
        duration: 250,
        easing: Easing.out(Easing.cubic),
      });
      menuScale.value = withSpring(1, {
        damping: 15,
        stiffness: 200,
        mass: 0.8,
      });
      reactionsOpacity.value = withTiming(1, {
        duration: 250,
        easing: Easing.out(Easing.cubic),
      });
      reactionsScale.value = withSpring(1, {
        damping: 15,
        stiffness: 200,
        mass: 0.8,
      });
    } else {
      // Animate out
      menuOpacity.value = withTiming(0, {
        duration: 150,
        easing: Easing.in(Easing.cubic),
      });
      menuScale.value = withTiming(0.9, {
        duration: 150,
        easing: Easing.in(Easing.cubic),
      });
      blurIntensity.value = withTiming(0, {
        duration: 200,
        easing: Easing.in(Easing.cubic),
      });
      messageOpacity.value = withTiming(0, {
        duration: 150,
        easing: Easing.in(Easing.cubic),
      });
      reactionsOpacity.value = withTiming(0, {
        duration: 150,
        easing: Easing.in(Easing.cubic),
      });
      reactionsScale.value = withTiming(0.85, {
        duration: 150,
        easing: Easing.in(Easing.cubic),
      });
    }
  }, [visible, menuOpacity, menuScale, blurIntensity, messageOpacity, reactionsOpacity, reactionsScale]);

  // Calculate menu position below the message
  const menuPosition = useMemo(() => {
    if (!messagePosition) {
      return { top: 0, left: 0 };
    }

    const { width: messageWidth = 0, height: messageHeight = 0 } = messagePosition;
    const menuHeight = actions.length * 56 + 16; // Approximate menu height
    const menuWidth = 240; // Fixed menu width
    const messageX = messagePosition.x || 0;
    const messageY = messagePosition.y || 0;
    const safeBottom = 32;
    
    // Position menu below the message, centered horizontally relative to message
    let top = messageY + messageHeight + 12; // Below message with 12px spacing
    let left = messageX + (messageWidth / 2) - (menuWidth / 2); // Center horizontally relative to message

    // Adjust if menu goes off screen horizontally
    if (left < 16) {
      left = 16;
    } else if (left + menuWidth > screenWidth - 16) {
      left = screenWidth - menuWidth - 16;
    }

    // Adjust if menu goes below screen
    if (top + menuHeight > screenHeight - safeBottom) {
      // Position above message if there isn't enough room below
      top = messageY - menuHeight - 12;
      if (top < 16) {
        top = 16;
      }
    }

    return { top, left };
  }, [messagePosition, actions.length, screenWidth, screenHeight]);

  // Animated style for menu
  const animatedMenuStyle = useAnimatedStyle(() => {
    const translateY = interpolate(
      menuScale.value,
      [0.9, 1],
      [5, 0] // Start slightly above, animate to position
    );

    return {
      opacity: menuOpacity.value,
      transform: [
        { scale: menuScale.value },
        { translateY },
      ],
    };
  });

  // Animated style for blur
  const animatedBlurStyle = useAnimatedStyle(() => ({
    opacity: interpolate(blurIntensity.value, [0, 80], [0, 1]),
  }));

  // Animated style for message
  const animatedMessageStyle = useAnimatedStyle(() => ({
    opacity: messageOpacity.value,
  }));

  const reactionBarPosition = useMemo(() => {
    if (!messagePosition || !shouldShowReactions) {
      return null;
    }

    const emojiCount = reactionEmojis.length;
    const barWidth = emojiCount * 44 + 8;
    const barHeight = 44;
    const messageX = messagePosition.x || 0;
    const messageY = messagePosition.y || 0;
    const messageWidth = messagePosition.width || 200;

    let top = messageY - barHeight - 8;
    let left = messageX + (messageWidth / 2) - (barWidth / 2);

    if (left < 16) {
      left = 16;
    } else if (left + barWidth > screenWidth - 16) {
      left = screenWidth - barWidth - 16;
    }

    if (top < 16) {
      top = messageY + (messagePosition.height || 50) + 8;
    }

    return { top, left };
  }, [messagePosition, reactionEmojis.length, screenWidth, shouldShowReactions]);

  const reactionAnimatedStyle = useAnimatedStyle(() => {
    const translateY = interpolate(reactionsScale.value, [0.85, 1], [10, 0]);
    return {
      opacity: reactionsOpacity.value,
      transform: [
        { scale: reactionsScale.value },
        { translateY },
      ],
    };
  });

  const styles = StyleSheet.create({
    overlay: {
      flex: 1,
    },
    blurOverlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 0,
    },
    messageContainer: {
      position: 'absolute',
      zIndex: 100,
    },
    container: {
      width: 240,
      position: 'absolute',
      zIndex: 101,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 12,
      elevation: 8,
      backgroundColor: theme.colors.background || 'rgba(255, 255, 255, 0.95)',
      borderRadius: 12,
      overflow: 'hidden',
    },
    action: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border || '#E5E5E5',
    },
    actionLast: {
      borderBottomWidth: 0,
    },
    actionText: {
      fontSize: 17,
      color: theme.colors.text || '#000000',
      fontWeight: '400',
    },
    actionTextDestructive: {
      color: '#FF3B30',
    },
    iconContainer: {
      marginRight: 12,
      width: 24,
      height: 24,
      justifyContent: 'center',
      alignItems: 'center',
    },
    reactionContainer: {
      position: 'absolute',
      zIndex: 102,
      backgroundColor: theme.colors.background || '#FFFFFF',
      borderRadius: 22,
      paddingHorizontal: 4,
      paddingVertical: 4,
      flexDirection: 'row',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.25,
      shadowRadius: 12,
      elevation: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border || '#E5E5E5',
    },
    emojiButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      justifyContent: 'center',
      alignItems: 'center',
      marginHorizontal: 2,
    },
    emojiText: {
      fontSize: 24,
    },
  });

  if (!visible) {
    return null;
  }
  
  if (actions.length === 0) {
    return null;
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={styles.overlay}
        activeOpacity={1}
        onPress={onClose}
      >
        {/* Blur background with animated intensity */}
        <AnimatedBlurView
          intensity={80}
          tint={theme.isDark ? 'dark' : 'light'}
          style={[styles.blurOverlay, animatedBlurStyle]}
          pointerEvents="none"
        />
        
        {/* Message element - positioned at original location, on top of blur */}
        {messageElement && messagePosition && (
          <Animated.View
            style={[
              styles.messageContainer,
              {
                top: messagePosition.y || 0,
                left: messagePosition.x || 0,
              },
              animatedMessageStyle,
            ]}
            pointerEvents="none"
          >
            {messageElement}
          </Animated.View>
        )}

        {shouldShowReactions && reactionBarPosition && (
          <Animated.View
            style={[
              styles.reactionContainer,
              {
                top: reactionBarPosition.top,
                left: reactionBarPosition.left,
              },
              reactionAnimatedStyle,
            ]}
          >
            {reactionEmojis.map((emoji, index) => (
              <TouchableOpacity
                key={index}
                style={styles.emojiButton}
                onPress={() => {
                  onReactionSelect?.(emoji);
                  onClose();
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.emojiText}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </Animated.View>
        )}
        
        {/* Menu positioned below message */}
        <Animated.View 
          style={[
            styles.container,
            {
              top: menuPosition.top,
              left: menuPosition.left,
            },
            animatedMenuStyle,
          ]}
        >
          {actions.map((action, index) => (
            <TouchableOpacity
              key={index}
              style={[
                styles.action,
                index === actions.length - 1 && styles.actionLast,
              ]}
              onPress={() => {
                action.onPress();
                onClose();
              }}
              activeOpacity={0.7}
            >
              {action.icon && (
                <View style={styles.iconContainer}>
                  {action.icon}
                </View>
              )}
              <Text
                style={[
                  styles.actionText,
                  action.destructive && styles.actionTextDestructive,
                ]}
              >
                {action.label}
              </Text>
            </TouchableOpacity>
          ))}
        </Animated.View>
      </TouchableOpacity>
    </Modal>
  );
});

MessageActionsMenu.displayName = 'MessageActionsMenu';
