import React, { useCallback, useEffect } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolate,
  type SharedValue,
} from 'react-native-reanimated';
import {
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import { SendIcon } from '@/assets/icons/send-icon';
import { useTheme } from '@/hooks/useTheme';
import { colors } from '@/styles/colors';

const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 24;
const SLIDER_HEIGHT = 200;
const SLIDER_TRACK_WIDTH = 4;
const BUTTON_SIZE = 40;
const ANIMATION_DURATION = 200;

interface SendButtonWithSizeAdjustmentProps {
  onSend: (size?: number) => void;
  currentSize: number;
  tempSize: number;
  isAdjusting: boolean;
  onSizeChange: (size: number) => void;
  onAdjustingChange: (adjusting: boolean) => void;
  baseSizeRef: React.MutableRefObject<number>;
  panY: SharedValue<number>;
  scale: SharedValue<number>;
}

export const SendButtonWithSizeAdjustment: React.FC<SendButtonWithSizeAdjustmentProps> = ({
  onSend,
  currentSize,
  tempSize,
  isAdjusting,
  onSizeChange,
  onAdjustingChange,
  baseSizeRef,
  panY,
  scale,
}) => {
  const theme = useTheme();

  // Shared values
  const longPressActive = useSharedValue(false);
  const sliderPosition = useSharedValue(0.5); // 0 = min (bottom), 1 = max (top)
  const sliderOpacity = useSharedValue(0);
  const panStartY = useSharedValue(0);
  const panStartPosition = useSharedValue(0.5);
  const lastSize = useSharedValue(tempSize);
  const isAdjustingValue = useSharedValue(isAdjusting);

  // Sync isAdjustingValue with prop
  useEffect(() => {
    isAdjustingValue.value = isAdjusting;
  }, [isAdjusting, isAdjustingValue]);

  // Initialize slider position from current size
  useEffect(() => {
    baseSizeRef.current = currentSize;
    const position = (currentSize - FONT_SIZE_MIN) / (FONT_SIZE_MAX - FONT_SIZE_MIN);
    sliderPosition.value = position;
    panStartPosition.value = position;
  }, [currentSize, baseSizeRef, sliderPosition, panStartPosition]);

  // Sync lastSize with tempSize
  useEffect(() => {
    lastSize.value = tempSize;
  }, [tempSize, lastSize]);

  // Convert position (0-1) to font size
  const positionToSize = useCallback((position: number): number => {
    const clamped = Math.max(0, Math.min(1, position));
    return Math.round(FONT_SIZE_MIN + (FONT_SIZE_MAX - FONT_SIZE_MIN) * clamped);
  }, []);

  // Convert font size to position (0-1)
  const sizeToPosition = useCallback((size: number): number => {
    return Math.max(0, Math.min(1, (size - FONT_SIZE_MIN) / (FONT_SIZE_MAX - FONT_SIZE_MIN)));
  }, []);

  const handleLongPressStart = useCallback(() => {
    longPressActive.value = true;
    baseSizeRef.current = currentSize;
    onAdjustingChange(true);
    isAdjustingValue.value = true;

    // Animate scale and opacity
    scale.value = withTiming(1.2, { duration: ANIMATION_DURATION });
    sliderOpacity.value = withTiming(1, { duration: ANIMATION_DURATION });

    // Initialize position from current size
    const position = sizeToPosition(currentSize);
    sliderPosition.value = position;
    panStartPosition.value = position;
    panY.value = 0;
    lastSize.value = currentSize;
  }, [
    currentSize,
    baseSizeRef,
    onAdjustingChange,
    isAdjustingValue,
    scale,
    sliderOpacity,
    sliderPosition,
    panStartPosition,
    panY,
    sizeToPosition,
    lastSize,
  ]);

  const handleLongPressEnd = useCallback(() => {
    if (!longPressActive.value) return;

    longPressActive.value = false;
    onAdjustingChange(false);
    isAdjustingValue.value = false;

    // Animate back to normal
    scale.value = withTiming(1, { duration: ANIMATION_DURATION });
    sliderOpacity.value = withTiming(0, { duration: ANIMATION_DURATION });
    panY.value = withTiming(0, { duration: ANIMATION_DURATION });

    // Reset position to current size
    const resetPosition = sizeToPosition(currentSize);
    sliderPosition.value = withTiming(resetPosition, { duration: ANIMATION_DURATION });

    // Send message with adjusted size
    onSend(tempSize);
  }, [
    onAdjustingChange,
    isAdjustingValue,
    scale,
    sliderOpacity,
    panY,
    sliderPosition,
    currentSize,
    sizeToPosition,
    tempSize,
    onSend,
    longPressActive,
  ]);

  const handlePanUpdate = useCallback((translationY: number) => {
    'worklet';
    if (!longPressActive.value) return;

    // Calculate new position from pan movement
    // Up (negative Y) = larger size = higher position (closer to 1)
    // Down (positive Y) = smaller size = lower position (closer to 0)
    const delta = -translationY / SLIDER_HEIGHT;
    const newPosition = Math.max(0, Math.min(1, panStartPosition.value + delta));

    // Update position directly for smooth tracking
    sliderPosition.value = newPosition;
    panY.value = translationY;

    // Calculate and update size
    const newSize = positionToSize(newPosition);
    if (newSize !== lastSize.value) {
      lastSize.value = newSize;
      runOnJS(onSizeChange)(newSize);
    }
  }, [
    onSizeChange,
    positionToSize,
    panStartPosition,
    lastSize,
    longPressActive,
    sliderPosition,
    panY,
  ]);

  // Pan gesture handler
  const panGesture = Gesture.Pan()
    .onStart((event) => {
      'worklet';
      if (!longPressActive.value) {
        runOnJS(handleLongPressStart)();
      }
      panStartY.value = event.y;
      panStartPosition.value = sliderPosition.value;
    })
    .onUpdate((event) => {
      'worklet';
      if (longPressActive.value) {
        const translationY = event.y - panStartY.value;
        handlePanUpdate(translationY);
      }
    })
    .onEnd(() => {
      'worklet';
      if (longPressActive.value) {
        runOnJS(handleLongPressEnd)();
      }
    })
    .onFinalize(() => {
      'worklet';
      if (longPressActive.value) {
        runOnJS(handleLongPressEnd)();
      }
    });

  // Long press gesture handler
  const longPressGesture = Gesture.LongPress()
    .minDuration(150)
    .onStart(() => {
      'worklet';
      runOnJS(handleLongPressStart)();
    });

  // Combined gesture
  const combinedGesture = Gesture.Simultaneous(longPressGesture, panGesture);

  // Button animated style - constrained to track bounds
  const buttonAnimatedStyle = useAnimatedStyle(() => {
    // Calculate translateY so button center stays within track
    // At position 0: button center at bottom of track (translateY = 0)
    // At position 1: button center at top of track (translateY = -SLIDER_HEIGHT + BUTTON_SIZE/2)
    // This ensures the button never goes outside the track
    const maxTranslate = -(SLIDER_HEIGHT - BUTTON_SIZE / 2);
    const translateY = isAdjustingValue.value
      ? interpolate(
        sliderPosition.value,
        [0, 1],
        [0, maxTranslate],
        Extrapolate.CLAMP
      )
      : 0;

    return {
      transform: [
        { scale: scale.value },
        { translateY },
      ],
      zIndex: 10,
    };
  });

  // Slider track style
  const sliderTrackStyle = useAnimatedStyle(() => ({
    opacity: sliderOpacity.value,
  }));


  const handleQuickPress = useCallback(() => {
    if (!isAdjusting && !longPressActive.value) {
      onSend();
    }
  }, [isAdjusting, onSend, longPressActive]);

  return (
    <View style={styles.container}>
      {/* Slider Track */}
      {isAdjusting && (
        <Animated.View
          style={[
            styles.sliderTrack,
            { backgroundColor: theme.colors.border || 'rgba(0,0,0,0.2)' },
            sliderTrackStyle,
          ]}
          pointerEvents="none"
        />
      )}

      {/* Send Button */}
      <GestureDetector gesture={combinedGesture}>
        <Animated.View style={buttonAnimatedStyle}>
          <TouchableOpacity
            style={styles.sendButton}
            onPress={handleQuickPress}
            activeOpacity={0.8}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <SendIcon color="#FFFFFF" size={20} />
          </TouchableOpacity>
        </Animated.View>
      </GestureDetector>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'flex-end',
    width: BUTTON_SIZE,
    minHeight: BUTTON_SIZE,
    overflow: 'visible',
  },
  sliderTrack: {
    position: 'absolute',
    width: SLIDER_TRACK_WIDTH,
    height: SLIDER_HEIGHT,
    borderRadius: SLIDER_TRACK_WIDTH / 2,
    bottom: 0,
    alignSelf: 'center',
    opacity: 0,
  },
  sendButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    backgroundColor: colors.buttonPrimary || '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: colors.buttonPrimary || '#007AFF',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 2,
    zIndex: 10,
  },
});
