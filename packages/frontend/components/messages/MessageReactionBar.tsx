import React, { memo, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, useWindowDimensions } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  Easing,
  interpolate,
} from 'react-native-reanimated';
import { useTheme } from '@/hooks/useTheme';

export interface MessageReactionBarProps {
  visible: boolean;
  position?: { x: number; y: number; width?: number; height?: number };
  messageElement?: React.ReactNode;
  onReactionSelect?: (emoji: string) => void;
  onClose?: () => void;
}

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);

/**
 * MessageReactionBar Component
 * 
 * Displays emoji reactions above a message (like WhatsApp iOS).
 * Appears on long press of a message.
 */
export const MessageReactionBar = memo<MessageReactionBarProps>(({
  visible,
  position,
  messageElement,
  onReactionSelect,
  onClose,
}) => {
  const theme = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  
  // Shared values for animations
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.85);
  const blurIntensity = useSharedValue(0);
  const messageOpacity = useSharedValue(0);

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
      
      // Animate reactions bar with spring for natural feel
      opacity.value = withTiming(1, {
        duration: 250,
        easing: Easing.out(Easing.cubic),
      });
      scale.value = withSpring(1, {
        damping: 15,
        stiffness: 200,
        mass: 0.8,
      });
    } else {
      // Animate out
      opacity.value = withTiming(0, {
        duration: 150,
        easing: Easing.in(Easing.cubic),
      });
      scale.value = withTiming(0.85, {
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
    }
  }, [visible, opacity, scale, blurIntensity, messageOpacity]);

  // Calculate reaction bar position above the message
  const barPosition = useMemo(() => {
    if (!position) {
      return { top: 0, left: 0 };
    }

    const emojiCount = EMOJIS.length;
    const barWidth = emojiCount * 44 + 8; // 44px per emoji + padding
    const barHeight = 44;
    const messageX = position.x || 0;
    const messageY = position.y || 0;
    const messageWidth = position.width || 200;
    
    // Position above message, centered horizontally relative to message
    let top = messageY - barHeight - 8; // 8px spacing above message
    let left = messageX + (messageWidth / 2) - (barWidth / 2); // Center horizontally relative to message
    
    // Adjust if bar goes off screen horizontally
    if (left < 16) {
      left = 16;
    } else if (left + barWidth > screenWidth - 16) {
      left = screenWidth - barWidth - 16;
    }
    
    // Adjust if bar goes above screen
    if (top < 16) {
      top = messageY + (position.height || 50) + 8; // Position below message instead
    }
    
    return { top, left };
  }, [position, screenWidth]);

  // Animated style for reactions bar
  const animatedStyle = useAnimatedStyle(() => {
    const translateY = interpolate(
      scale.value,
      [0.85, 1],
      [10, 0] // Start slightly below, animate to position
    );

    return {
      opacity: opacity.value,
      transform: [
        { scale: scale.value },
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

  const styles = useMemo(() => StyleSheet.create({
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
  }), [theme]);

  if (!visible || !position) {
    return null;
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
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
        {messageElement && position && (
          <Animated.View
            style={[
              styles.messageContainer,
              {
                top: position.y || 0,
                left: position.x || 0,
              },
              animatedMessageStyle,
            ]}
            pointerEvents="none"
          >
            {messageElement}
          </Animated.View>
        )}
        
        {/* Reaction bar positioned above message - HORIZONTAL LAYOUT */}
        <Animated.View 
          style={[
            styles.reactionContainer,
            {
              top: barPosition.top,
              left: barPosition.left,
            },
            animatedStyle,
          ]}
        >
          {EMOJIS.map((emoji, index) => (
            <TouchableOpacity
              key={index}
              style={styles.emojiButton}
              onPress={() => {
                onReactionSelect?.(emoji);
                onClose?.();
              }}
              activeOpacity={0.7}
            >
              <Text style={styles.emojiText}>{emoji}</Text>
            </TouchableOpacity>
          ))}
        </Animated.View>
      </TouchableOpacity>
    </Modal>
  );
});

MessageReactionBar.displayName = 'MessageReactionBar';
