import React, { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import {
  GestureHandlerRootView,
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import { useTheme } from '@/hooks/useTheme';

const SWIPE_THRESHOLD = 80;
const MAX_SWIPE = 120;

export interface SwipeableMessageProps {
  children: React.ReactNode;
  onSwipeRight?: () => void;
  replyIcon?: React.ReactNode;
  enabled?: boolean;
}

/**
 * SwipeableMessage Component
 * 
 * Wraps a message with swipe-to-reply functionality (like WhatsApp iOS).
 * Swiping left reveals a reply icon and triggers the onSwipeRight callback.
 * 
 * @example
 * ```tsx
 * <SwipeableMessage
 *   onSwipeRight={() => handleReply(message)}
 *   replyIcon={<ReplyIcon />}
 *   enabled={true}
 * >
 *   <MessageBlock {...props} />
 * </SwipeableMessage>
 * ```
 */
export const SwipeableMessage = memo<SwipeableMessageProps>(({
  children,
  onSwipeRight,
  replyIcon,
  enabled = true,
}) => {
  const theme = useTheme();
  const translateX = useSharedValue(0);
  const opacity = useSharedValue(0);

  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onUpdate((event) => {
      if (!enabled) return;
      
      // Only allow left swipe (negative translation)
      if (event.translationX < 0) {
        translateX.value = Math.max(event.translationX, -MAX_SWIPE);
        
        // Calculate opacity based on swipe distance
        const progress = Math.abs(translateX.value) / MAX_SWIPE;
        opacity.value = Math.min(progress, 1);
      }
    })
    .onEnd(() => {
      if (!enabled) return;
      
      const shouldTrigger = Math.abs(translateX.value) >= SWIPE_THRESHOLD;
      
      if (shouldTrigger && onSwipeRight) {
        // Trigger callback
        runOnJS(onSwipeRight)();
        
        // Animate to trigger position briefly (smooth, no bounce)
        translateX.value = withTiming(-SWIPE_THRESHOLD, {
          duration: 150,
          easing: Easing.out(Easing.cubic),
        });
        
        // Then reset
        translateX.value = withTiming(0, { 
          duration: 250,
          easing: Easing.inOut(Easing.cubic),
        });
        opacity.value = withTiming(0, { 
          duration: 250,
          easing: Easing.inOut(Easing.cubic),
        });
      } else {
        // Reset to original position (smooth, no bounce)
        translateX.value = withTiming(0, {
          duration: 300,
          easing: Easing.out(Easing.cubic),
        });
        opacity.value = withTiming(0, { 
          duration: 300,
          easing: Easing.out(Easing.cubic),
        });
      }
    });

  const animatedContainerStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateX: translateX.value }],
    };
  });

  const animatedReplyStyle = useAnimatedStyle(() => {
    return {
      opacity: opacity.value,
      transform: [
        {
          scale: 0.5 + opacity.value * 0.5, // Scale from 0.5 to 1
        },
      ],
    };
  });

  const styles = StyleSheet.create({
    container: {
      position: 'relative',
      overflow: 'visible',
    },
    swipeableContent: {
      position: 'relative',
    },
    replyContainer: {
      position: 'absolute',
      left: 16, // Near the bubble on the left side
      top: '50%',
      marginTop: -20, // Half of icon size
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.colors.primary || '#007AFF',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 10,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.25,
      shadowRadius: 4,
      elevation: 5,
    },
  });

  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <View style={styles.swipeableContent}>
        {/* Reply icon (revealed on swipe) */}
        <Animated.View style={[styles.replyContainer, animatedReplyStyle]}>
          {replyIcon || (
            <View style={{ width: 20, height: 20, backgroundColor: '#FFFFFF', borderRadius: 2 }} />
          )}
        </Animated.View>

        {/* Swipeable message content */}
        <GestureDetector gesture={panGesture}>
          <Animated.View style={animatedContainerStyle}>
            {children}
          </Animated.View>
        </GestureDetector>
      </View>
    </GestureHandlerRootView>
  );
});

SwipeableMessage.displayName = 'SwipeableMessage';

