import React, { memo, useMemo, useEffect, useRef, useState } from 'react';
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
const SNAPSHOT_CAPTURE_DELAY = 16;

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
  const centerProgress = useSharedValue(0);
  const [snapshotSize, setSnapshotSize] = useState<{ width: number; height: number } | null>(null);
  const [renderedElement, setRenderedElement] = useState<React.ReactNode>(null);
  const captureTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
    if (visible && messageElement) {
      if (captureTimeout.current) {
        clearTimeout(captureTimeout.current);
      }
      captureTimeout.current = setTimeout(() => {
        setRenderedElement(messageElement);
      }, SNAPSHOT_CAPTURE_DELAY);
    } else {
      if (captureTimeout.current) {
        clearTimeout(captureTimeout.current);
        captureTimeout.current = null;
      }
      setRenderedElement(null);
      setSnapshotSize(null);
    }
  }, [visible, messageElement]);

  useEffect(() => {
    return () => {
      if (captureTimeout.current) {
        clearTimeout(captureTimeout.current);
      }
    };
  }, []);

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
      centerProgress.value = withTiming(1, {
        duration: 280,
        easing: Easing.out(Easing.cubic),
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
      centerProgress.value = withTiming(0, {
        duration: 200,
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
  }, [visible, menuOpacity, menuScale, blurIntensity, messageOpacity, reactionsOpacity, reactionsScale, centerProgress]);

  const placement = useMemo(() => {
    const width = snapshotSize?.width ?? messagePosition?.width ?? 220;
    const height = snapshotSize?.height ?? messagePosition?.height ?? 88;
    const startX = messagePosition?.x ?? (screenWidth - width) / 2;
    const startY = messagePosition?.y ?? (screenHeight - height) / 2;
    const targetX = (screenWidth - width) / 2;
    const targetY = Math.max(64, (screenHeight - height) / 2 - 60);
    return { width, height, startX, startY, targetX, targetY };
  }, [messagePosition, screenWidth, screenHeight, snapshotSize]);

  const menuGeometry = useMemo(() => {
    const menuWidth = 240;
    const menuHeight = actions.length * 56 + 16;

    const clampHorizontal = (candidate: number) => {
      if (candidate < 16) return 16;
      if (candidate + menuWidth > screenWidth - 16) return screenWidth - menuWidth - 16;
      return candidate;
    };
    const clampVertical = (candidate: number) => {
      if (candidate + menuHeight > screenHeight - 48) {
        return Math.max(screenHeight - 48 - menuHeight, 32);
      }
      if (candidate < 32) return 32;
      return candidate;
    };

    // Target aligned with centered message
    let targetTop = placement.targetY + placement.height + 24;
    targetTop = clampVertical(targetTop);
    let targetLeft = placement.targetX + (placement.width / 2) - (menuWidth / 2);
    targetLeft = clampHorizontal(targetLeft);

    // Start aligned with original message location if available
    let startTop = messagePosition
      ? (messagePosition.y ?? placement.startY) + (messagePosition.height ?? placement.height) + 12
      : targetTop;
    startTop = clampVertical(startTop);
    let startLeft = messagePosition
      ? clampHorizontal((messagePosition.x ?? placement.startX) + ((messagePosition.width ?? placement.width) / 2) - (menuWidth / 2))
      : targetLeft;

    return { startTop, startLeft, targetTop, targetLeft };
  }, [actions.length, placement, screenWidth, screenHeight, messagePosition]);

  const reactionGeometry = useMemo(() => {
    if (!shouldShowReactions) {
      return null;
    }

    const emojiCount = reactionEmojis.length;
    const barWidth = emojiCount * 44 + 8;
    const barHeight = 44;

    const clampHorizontal = (candidate: number) => {
      if (candidate < 16) return 16;
      if (candidate + barWidth > screenWidth - 16) return screenWidth - barWidth - 16;
      return candidate;
    };
    const clampVertical = (candidate: number) => {
      if (candidate < 16) return 16;
      if (candidate > screenHeight - barHeight - 16) return screenHeight - barHeight - 16;
      return candidate;
    };

    let targetLeft = clampHorizontal(placement.targetX + (placement.width / 2) - (barWidth / 2));
    let targetTop = clampVertical(placement.targetY - barHeight - 12);
    if (targetTop < 16) {
      targetTop = clampVertical(placement.targetY + placement.height + 12);
    }

    let startLeft = messagePosition
      ? clampHorizontal((messagePosition.x ?? placement.startX) + ((messagePosition.width ?? placement.width) / 2) - (barWidth / 2))
      : targetLeft;
    let startTop = messagePosition
      ? clampVertical((messagePosition.y ?? placement.startY) - barHeight - 8)
      : targetTop;
    if (startTop < 16) {
      startTop = clampVertical((messagePosition?.y ?? placement.startY) + (messagePosition?.height ?? placement.height) + 8);
    }

    return {
      startLeft,
      startTop,
      deltaX: targetLeft - startLeft,
      deltaY: targetTop - startTop,
    };
  }, [shouldShowReactions, reactionEmojis.length, placement, messagePosition, screenWidth, screenHeight]);

  // Animated style for menu
  const animatedMenuStyle = useAnimatedStyle(() => {
    const springTranslateY = interpolate(menuScale.value, [0.9, 1], [5, 0]);
    const deltaX = menuGeometry.targetLeft - menuGeometry.startLeft;
    const deltaY = menuGeometry.targetTop - menuGeometry.startTop;

    return {
      opacity: menuOpacity.value,
      transform: [
        { translateX: deltaX * centerProgress.value },
        { translateY: deltaY * centerProgress.value + springTranslateY },
        { scale: menuScale.value },
      ],
    };
  });

  // Animated style for blur
  const animatedBlurStyle = useAnimatedStyle(() => ({
    opacity: interpolate(blurIntensity.value, [0, 80], [0, 1]),
  }));

  // Animated style for message
  const animatedMessageStyle = useAnimatedStyle(() => {
    const translateX = (placement.targetX - placement.startX) * centerProgress.value;
    const translateY = (placement.targetY - placement.startY) * centerProgress.value;
    return {
      opacity: messageOpacity.value,
      width: placement.width,
      height: placement.height,
      transform: [
        { translateX },
        { translateY },
      ],
    };
  });

  const reactionBarPosition = useMemo(() => {
    if (!shouldShowReactions) {
      return null;
    }

    const emojiCount = reactionEmojis.length;
    const barWidth = emojiCount * 44 + 8;
    const barHeight = 44;
    const { width: messageWidth, targetX, targetY, height: messageHeight } = placement;

    let top = targetY - barHeight - 12;
    let left = targetX + (messageWidth / 2) - (barWidth / 2);

    if (left < 16) {
      left = 16;
    } else if (left + barWidth > screenWidth - 16) {
      left = screenWidth - barWidth - 16;
    }

    if (top < 16) {
      top = targetY + messageHeight + 12;
    }

    return { top, left };
  }, [shouldShowReactions, reactionEmojis.length, placement, screenWidth]);

  const reactionAnimatedStyle = useAnimatedStyle(() => {
    const translateY = interpolate(reactionsScale.value, [0.85, 1], [10, 0]);
    return {
      opacity: reactionsOpacity.value,
      transform: [
        { translateX: reactionGeometry ? reactionGeometry.deltaX * centerProgress.value : 0 },
        { translateY: (reactionGeometry ? reactionGeometry.deltaY * centerProgress.value : 0) + translateY },
        { scale: reactionsScale.value },
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
      left: placement.startX,
      top: placement.startY,
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
        
        {/* Message element morphing to center */}
        {renderedElement && (
          <Animated.View
            style={[
              styles.messageContainer,
              {
                top: placement.startY,
                left: placement.startX,
              },
              animatedMessageStyle,
            ]}
            onLayout={(event) => {
              const { width, height } = event.nativeEvent.layout;
              if (!snapshotSize || Math.abs(snapshotSize.width - width) > 1 || Math.abs(snapshotSize.height - height) > 1) {
                setSnapshotSize({ width, height });
              }
            }}
            pointerEvents="none"
          >
            {renderedElement}
          </Animated.View>
        )}

        {shouldShowReactions && reactionGeometry && (
          <Animated.View
            style={[
              styles.reactionContainer,
              {
                top: reactionGeometry.startTop,
                left: reactionGeometry.startLeft,
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
              top: menuGeometry.startTop,
              left: menuGeometry.startLeft,
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
