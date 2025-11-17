import React, { useCallback, useEffect, useRef, useState, useContext } from 'react';
import { View, StyleSheet, TouchableOpacity, Platform, Text, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    useAnimatedReaction,
    withTiming,
    withSpring,
    runOnJS,
    interpolate,
    Extrapolate,
    type SharedValue,
} from 'react-native-reanimated';
import {
    Gesture,
    GestureDetector,
} from 'react-native-gesture-handler';
import {
    useAudioRecorder,
    RecordingPresets,
    getRecordingPermissionsAsync,
    requestRecordingPermissionsAsync,
    setAudioModeAsync,
    useAudioRecorderState,
} from 'expo-audio';
import { SendIcon } from '@/assets/icons/send-icon';
import { MicIcon } from '@/assets/icons';
import { useTheme } from '@/hooks/useTheme';
import { colors } from '@/styles/colors';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { MicPermissionSheet } from './MicPermissionSheet';

const BUTTON_SIZE = 40;
const ANIMATION_DURATION = 200;
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 24;
const SLIDER_HEIGHT = 200;
const SLIDER_TRACK_WIDTH = 4;

interface MicSendButtonProps {
    hasText: boolean;
    onSend: (size?: number) => void;
    onRecordStart?: () => void;
    onRecordEnd?: (uri: string, duration: number) => void;
    onRecordCancel?: () => void;
    currentSize?: number;
    tempSize?: number;
    isAdjusting?: boolean;
    onSizeChange?: (size: number) => void;
    onAdjustingChange?: (adjusting: boolean) => void;
    baseSizeRef?: React.MutableRefObject<number>;
    panY?: SharedValue<number>;
    scale?: SharedValue<number>;
}

// Lock indicator content component
const LockIndicatorContent: React.FC<{
    isLocked: boolean;
    isInCancelZone: SharedValue<number>;
    dragY: SharedValue<number>;
}> = ({
    isLocked,
    isInCancelZone,
    dragY
}) => {
        const [cancelZoneValue, setCancelZoneValue] = useState(0);
        const [dragValue, setDragValue] = useState(0);

        // Use animated style to read values and update state
        useAnimatedReaction(
            () => ({
                cancel: isInCancelZone.value,
                drag: dragY.value
            }),
            (values) => {
                'worklet';
                runOnJS(setCancelZoneValue)(values.cancel);
                runOnJS(setDragValue)(values.drag);
            }
        );

        const inCancelZone = cancelZoneValue === 1;
        const isDragging = Math.abs(dragValue) > 10;

        if (isLocked) {
            return (
                <View style={styles.lockIndicatorContent}>
                    {inCancelZone && isDragging ? (
                        <>
                            <Ionicons name="close-circle" size={24} color="#FFFFFF" />
                            <Text style={styles.lockIndicatorText}>Slide to cancel</Text>
                        </>
                    ) : (
                        <>
                            <Ionicons name="lock-closed" size={24} color="#FFFFFF" />
                            <Text style={styles.lockIndicatorText}>Locked</Text>
                        </>
                    )}
                </View>
            );
        }

        return (
            <View style={styles.lockIndicatorContent}>
                <Ionicons name="lock-open" size={24} color="#FFFFFF" />
                <Text style={styles.lockIndicatorText}>Slide to lock</Text>
            </View>
        );
    };

export const MicSendButton: React.FC<MicSendButtonProps> = ({
    hasText,
    onSend,
    onRecordStart,
    onRecordEnd,
    onRecordCancel,
    currentSize,
    tempSize,
    isAdjusting = false,
    onSizeChange,
    onAdjustingChange,
    baseSizeRef,
    panY,
    scale,
}) => {
    const theme = useTheme();
    const bottomSheet = useContext(BottomSheetContext);
    const [hasPermission, setHasPermission] = useState<boolean | null>(null);
    const [isLocked, setIsLocked] = useState(false); // Recording lock state

    // Create audio recorder with high quality preset
    const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
    const recorderState = useAudioRecorderState(audioRecorder);

    // Animation values
    const buttonScale = useSharedValue(1);
    const isRecordingValue = useSharedValue(false);
    const lockProgress = useSharedValue(0); // 0 = not locked, 1 = locked
    const dragY = useSharedValue(0);
    const isHolding = useSharedValue(false); // Track if actively holding during long press
    const showLockIndicator = useSharedValue(0); // Show lock/cancel indicator (0 = hidden, 1 = visible)
    const isInCancelZone = useSharedValue(0); // Track if in cancel zone (0 = false, 1 = true)

    // Font size adjustment state
    const longPressActive = useSharedValue(false);
    const sliderPosition = useSharedValue(0.5); // 0 = min (bottom), 1 = max (top)
    const sliderOpacity = useSharedValue(0);
    const panStartY = useSharedValue(0);
    const panStartPosition = useSharedValue(0.5);
    const lastSize = useSharedValue(tempSize || currentSize || 16);
    const isAdjustingValue = useSharedValue(isAdjusting);

    // Use provided scale/panY or create new ones
    const sizeAdjustmentScale = scale || useSharedValue(1);
    const sizeAdjustmentPanY = panY || useSharedValue(0);

    // Sync isAdjustingValue with prop
    useEffect(() => {
        isAdjustingValue.value = isAdjusting;
    }, [isAdjusting, isAdjustingValue]);

    // Initialize slider position from current size when it changes
    useEffect(() => {
        if (currentSize && baseSizeRef) {
            baseSizeRef.current = currentSize;
            const position = (currentSize - FONT_SIZE_MIN) / (FONT_SIZE_MAX - FONT_SIZE_MIN);
            sliderPosition.value = position;
            panStartPosition.value = position;
        }
    }, [currentSize, baseSizeRef, sliderPosition, panStartPosition]);

    // Sync lastSize with tempSize
    useEffect(() => {
        if (tempSize) {
            lastSize.value = tempSize;
        }
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

    // Check microphone permissions
    const checkPermissions = useCallback(async (): Promise<boolean> => {
        try {
            const response = await getRecordingPermissionsAsync();
            const granted = response.granted;
            setHasPermission(granted);
            return granted;
        } catch (error) {
            console.error('Error checking audio permissions:', error);
            setHasPermission(false);
            return false;
        }
    }, []);

    // Request microphone permissions
    const requestPermissions = useCallback(async (): Promise<boolean> => {
        try {
            const response = await requestRecordingPermissionsAsync();
            const granted = response.granted;
            setHasPermission(granted);

            if (granted) {
                // Configure audio mode for recording
                await setAudioModeAsync({
                    playsInSilentMode: true,
                    allowsRecording: true,
                });
            }

            return granted;
        } catch (error) {
            console.error('Error requesting audio permissions:', error);
            setHasPermission(false);
            return false;
        }
    }, []);

    // Show permission sheet
    const showPermissionSheet = useCallback(() => {
        if (!bottomSheet) return;

        bottomSheet.setBottomSheetContent(
            <MicPermissionSheet
                onEnable={async () => {
                    const granted = await requestPermissions();
                    bottomSheet.openBottomSheet(false);
                    if (granted) {
                        // Permission granted, can start recording
                        return;
                    }
                }}
                onLater={() => {
                    bottomSheet.openBottomSheet(false);
                }}
            />
        );
        bottomSheet.openBottomSheet(true);
    }, [bottomSheet, requestPermissions]);

    // Sync recording state with recorderState
    useEffect(() => {
        isRecordingValue.value = recorderState.isRecording;
        if (recorderState.isRecording) {
            buttonScale.value = withSpring(1.2);
        } else {
            buttonScale.value = withSpring(1);
            // Reset lock state when recording stops
            setIsLocked(false);
            lockProgress.value = withTiming(0);
        }
    }, [recorderState.isRecording, isRecordingValue, buttonScale, lockProgress]);

    // Check permissions on mount
    useEffect(() => {
        if (!hasText) {
            checkPermissions();
        }
    }, [hasText, checkPermissions]);

    // Configure audio mode on mount
    useEffect(() => {
        (async () => {
            try {
                await setAudioModeAsync({
                    playsInSilentMode: true,
                    allowsRecording: true,
                });
            } catch (error) {
                console.error('Error setting audio mode:', error);
            }
        })();
    }, []);

    // Start recording with expo-audio
    const startRecording = useCallback(async () => {
        try {
            // Check permissions first
            const hasMicPermission = await checkPermissions();
            if (!hasMicPermission) {
                // Show permission sheet
                showPermissionSheet();
                return;
            }

            // Configure audio mode for recording
            await setAudioModeAsync({
                playsInSilentMode: true,
                allowsRecording: true,
            });

            // Prepare recorder if not already prepared
            if (!recorderState.canRecord) {
                await audioRecorder.prepareToRecordAsync();
            }

            // Start recording
            audioRecorder.record();
            onRecordStart?.();
        } catch (error: any) {
            console.error('Failed to start recording:', error);
            // Check if error is permission-related
            const errorMessage = error?.message || error?.toString() || '';
            if (errorMessage.toLowerCase().includes('permission') ||
                errorMessage.toLowerCase().includes('denied') ||
                errorMessage.toLowerCase().includes('microphone')) {
                setHasPermission(false);
                showPermissionSheet();
                return;
            }
        }
    }, [audioRecorder, recorderState.canRecord, checkPermissions, showPermissionSheet, onRecordStart]);

    // Stop recording with expo-audio
    const stopRecording = useCallback(async (cancel: boolean = false) => {
        try {
            if (!recorderState.isRecording) {
                return;
            }

            await audioRecorder.stop();
            const uri = audioRecorder.uri;
            const duration = recorderState.durationMillis / 1000; // Convert to seconds

            if (!cancel && duration > 0.5 && uri) {
                onRecordEnd?.(uri, duration);
            } else {
                onRecordCancel?.();
            }
        } catch (error) {
            console.error('Failed to stop recording:', error);
            onRecordCancel?.();
        }
    }, [audioRecorder, recorderState.isRecording, recorderState.durationMillis, onRecordEnd, onRecordCancel]);

    // Handle font size adjustment long press start
    const handleSizeAdjustmentLongPressStart = useCallback(() => {
        if (!hasText || !currentSize || !baseSizeRef) return;

        longPressActive.value = true;
        baseSizeRef.current = currentSize;
        onAdjustingChange?.(true);
        isAdjustingValue.value = true;

        // Animate scale and opacity
        sizeAdjustmentScale.value = withTiming(1.2, { duration: ANIMATION_DURATION });
        sliderOpacity.value = withTiming(1, { duration: ANIMATION_DURATION });

        // Initialize position from current size
        const position = sizeToPosition(currentSize);
        sliderPosition.value = position;
        panStartPosition.value = position;
        sizeAdjustmentPanY.value = 0;
        lastSize.value = currentSize;
    }, [
        hasText,
        currentSize,
        baseSizeRef,
        onAdjustingChange,
        isAdjustingValue,
        sizeAdjustmentScale,
        sliderOpacity,
        sliderPosition,
        panStartPosition,
        sizeAdjustmentPanY,
        sizeToPosition,
        lastSize,
    ]);

    // Handle font size adjustment long press end
    const handleSizeAdjustmentLongPressEnd = useCallback(() => {
        if (!longPressActive.value || !currentSize) return;

        longPressActive.value = false;
        onAdjustingChange?.(false);
        isAdjustingValue.value = false;

        // Animate back to normal
        sizeAdjustmentScale.value = withTiming(1, { duration: ANIMATION_DURATION });
        sliderOpacity.value = withTiming(0, { duration: ANIMATION_DURATION });
        sizeAdjustmentPanY.value = withTiming(0, { duration: ANIMATION_DURATION });

        // Reset position to current size
        const resetPosition = sizeToPosition(currentSize);
        sliderPosition.value = withTiming(resetPosition, { duration: ANIMATION_DURATION });

        // Send message with adjusted size
        onSend(tempSize || currentSize);
    }, [
        longPressActive,
        currentSize,
        tempSize,
        onAdjustingChange,
        isAdjustingValue,
        sizeAdjustmentScale,
        sliderOpacity,
        sizeAdjustmentPanY,
        sliderPosition,
        sizeToPosition,
        onSend,
    ]);

    // Handle pan update for font size adjustment
    const handleSizeAdjustmentPanUpdate = useCallback((translationY: number) => {
        'worklet';
        if (!longPressActive.value || !hasText) return;

        // Calculate new position from pan movement
        // Up (negative Y) = larger size = higher position (closer to 1)
        // Down (positive Y) = smaller size = lower position (closer to 0)
        const delta = -translationY / SLIDER_HEIGHT;
        const newPosition = Math.max(0, Math.min(1, panStartPosition.value + delta));

        // Update position directly for smooth tracking
        sliderPosition.value = newPosition;
        sizeAdjustmentPanY.value = translationY;

        // Calculate and update size
        const newSize = positionToSize(newPosition);
        if (newSize !== lastSize.value) {
            lastSize.value = newSize;
            runOnJS(onSizeChange || (() => { }))(newSize);
        }
    }, [
        hasText,
        longPressActive,
        panStartPosition,
        sliderPosition,
        sizeAdjustmentPanY,
        positionToSize,
        lastSize,
        onSizeChange,
    ]);

    // Handle quick press (send or mic tap)
    const handleQuickPress = useCallback(() => {
        if (hasText && !recorderState.isRecording && !isAdjusting && !longPressActive.value) {
            onSend();
        } else if (!hasText && !recorderState.isRecording) {
            // Just a tap on mic - does nothing, only long press records
        } else if (recorderState.isRecording && isLocked) {
            // When locked, tap button to stop and send
            stopRecording(false);
        }
    }, [hasText, recorderState.isRecording, isAdjusting, longPressActive, isLocked, onSend, stopRecording]);

    // Handle recording long press start
    const handleRecordingLongPressStart = useCallback(() => {
        if (!hasText && !recorderState.isRecording) {
            startRecording();
        }
    }, [hasText, recorderState.isRecording, startRecording]);

    // Handle recording long press end
    const handleRecordingLongPressEnd = useCallback(() => {
        // Only stop if not locked - if locked, recording continues
        if (recorderState.isRecording && !isLocked) {
            stopRecording(false);
        }
    }, [recorderState.isRecording, isLocked, stopRecording]);

    const handleRecordingPanUpdate = useCallback((translationY: number) => {
        'worklet';
        // Only process if recording or about to record
        if (!isRecordingValue.value && !isHolding.value) {
            showLockIndicator.value = 0;
            return;
        }

        dragY.value = translationY;
        showLockIndicator.value = 1; // Show indicator when dragging

        const lockThreshold = -60; // Distance to swipe up to lock (negative = up)
        const cancelThreshold = -120; // Distance to swipe up to cancel when locked

        if (isLocked) {
            // When locked, check if swiping up to cancel
            if (translationY < cancelThreshold) {
                isInCancelZone.value = 1;
                // Don't cancel yet - wait for user to release or go further
            } else {
                isInCancelZone.value = 0;
            }
            // Calculate cancel progress for visual feedback
            const cancelProgress = Math.max(0, Math.min(1, (-translationY - lockThreshold) / (cancelThreshold - lockThreshold)));
            lockProgress.value = 1 + cancelProgress; // 1 = locked, 1+ = heading to cancel
        } else {
            // Not locked - swipe up to lock
            isInCancelZone.value = 0;
            const progress = Math.max(0, Math.min(1, -translationY / lockThreshold));
            lockProgress.value = progress;

            if (translationY < lockThreshold) {
                runOnJS(setIsLocked)(true);
                // Once locked, we can release the hold
                isHolding.value = false;
            }
        }
    }, [isRecordingValue, isHolding, stopRecording, isLocked, dragY, lockProgress, showLockIndicator, isInCancelZone]);

    // Long press gesture for recording (when no text)
    const recordingLongPressGesture = Gesture.LongPress()
        .minDuration(150)
        .enabled(!hasText && !recorderState.isRecording && !isLocked)
        .onStart(() => {
            'worklet';
            isHolding.value = true;
            runOnJS(handleRecordingLongPressStart)();
        })
        .onEnd(() => {
            'worklet';
            isHolding.value = false;
            // Only stop recording if not locked - if locked, recording continues
            if (isRecordingValue.value && !isLocked) {
                runOnJS(handleRecordingLongPressEnd)();
            }
        });

    // Pan gesture for lock/unlock recording (swipe up to lock, swipe up more to cancel)
    const recordingPanGesture = Gesture.Pan()
        .enabled(!hasText) // Only enabled when no text (recording mode)
        .onStart((event) => {
            'worklet';
            // Reset drag position when starting
            dragY.value = 0;
        })
        .onUpdate((event) => {
            'worklet';
            // Only handle pan updates if recording or if we're holding
            if (isRecordingValue.value || isHolding.value) {
                handleRecordingPanUpdate(event.translationY);
            }
        })
        .onEnd(() => {
            'worklet';
            isHolding.value = false;

            // If in cancel zone when released, cancel the recording
            if (isLocked && isInCancelZone.value === 1) {
                runOnJS(stopRecording)(true);
                lockProgress.value = withTiming(0);
                dragY.value = withTiming(0);
                showLockIndicator.value = withTiming(0);
                isInCancelZone.value = 0;
            } else {
                // Reset drag position on end, but keep lock state
                if (!isLocked) {
                    dragY.value = withTiming(0);
                    lockProgress.value = withTiming(0);
                }
                showLockIndicator.value = withTiming(0);
            }
        });

    // Long press gesture for font size adjustment (when has text)
    const sizeAdjustmentLongPressGesture = Gesture.LongPress()
        .minDuration(150)
        .enabled(hasText && !recorderState.isRecording)
        .onStart(() => {
            'worklet';
            runOnJS(handleSizeAdjustmentLongPressStart)();
        });

    // Pan gesture for font size adjustment
    const sizeAdjustmentPanGesture = Gesture.Pan()
        .enabled(hasText)
        .onStart((event) => {
            'worklet';
            if (!longPressActive.value && hasText) {
                runOnJS(handleSizeAdjustmentLongPressStart)();
            }
            panStartY.value = event.y;
            panStartPosition.value = sliderPosition.value;
        })
        .onUpdate((event) => {
            'worklet';
            if (longPressActive.value && hasText) {
                const translationY = event.y - panStartY.value;
                handleSizeAdjustmentPanUpdate(translationY);
            }
        })
        .onEnd(() => {
            'worklet';
            if (longPressActive.value) {
                runOnJS(handleSizeAdjustmentLongPressEnd)();
            }
        })
        .onFinalize(() => {
            'worklet';
            if (longPressActive.value) {
                runOnJS(handleSizeAdjustmentLongPressEnd)();
            }
        });

    // Combined gestures - different behaviors based on hasText
    const combinedGesture = hasText
        ? Gesture.Simultaneous(sizeAdjustmentLongPressGesture, sizeAdjustmentPanGesture)
        : Gesture.Simultaneous(recordingLongPressGesture, recordingPanGesture);

    // Slider track style for font size adjustment
    const sliderTrackStyle = useAnimatedStyle(() => ({
        opacity: sliderOpacity.value,
    }));

    // Lock indicator animated style
    const lockIndicatorStyle = useAnimatedStyle(() => {
        const opacity = showLockIndicator.value ? 1 : 0;
        const translateY = dragY.value;

        return {
            opacity,
            transform: [
                { translateY: Math.min(0, translateY) }, // Move up with finger
            ],
        };
    });

    // Button animated style - constrained to track bounds when adjusting size
    const buttonAnimatedStyle = useAnimatedStyle(() => {
        // For font size adjustment, translate button along slider track
        const maxTranslate = -(SLIDER_HEIGHT - BUTTON_SIZE / 2);
        const translateY = hasText && isAdjustingValue.value
            ? interpolate(
                sliderPosition.value,
                [0, 1],
                [0, maxTranslate],
                Extrapolate.CLAMP
            )
            : 0;

        // Use different scale based on mode
        const activeScale = hasText && isAdjustingValue.value
            ? sizeAdjustmentScale.value
            : buttonScale.value;

        return {
            transform: [
                { scale: activeScale },
                { translateY },
            ],
            zIndex: 10,
        };
    });

    const buttonBackgroundColor = hasText
        ? (colors.buttonPrimary || theme.colors.primary || '#007AFF')
        : (recorderState.isRecording
            ? '#FF3B30'
            : 'transparent');

    const iconColor = hasText
        ? '#FFFFFF'
        : (recorderState.isRecording
            ? '#FFFFFF'
            : (theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5 || '#666666'));

    // Get window dimensions and safe area to ensure indicator stays on screen
    const { height: windowHeight } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const safeTop = insets.top + 20; // Safe top margin (status bar + padding)

    // Estimate button position (near bottom in input area)
    // Input area is typically ~100px from bottom, button is in it
    const estimatedButtonScreenY = windowHeight - 100;
    const maxUpwardPixels = estimatedButtonScreenY - safeTop - 50; // Leave 50px margin from top

    // Lock indicator text and icon
    const lockIndicatorAnimatedStyle = useAnimatedStyle(() => {
        const opacity = showLockIndicator.value;
        const dragYValue = dragY.value;

        // Base position above button (-80px from button in container)
        const baseOffset = -80;
        // Follow finger movement (only upward, clamp to max)
        const fingerOffset = Math.min(0, dragYValue);
        const clampedOffset = Math.max(fingerOffset, -maxUpwardPixels);

        return {
            opacity,
            transform: [
                { translateY: baseOffset + clampedOffset },
            ],
        };
    });

    return (
        <View style={styles.container}>
            {/* Slider Track for font size adjustment */}
            {isAdjusting && hasText && (
                <Animated.View
                    style={[
                        styles.sliderTrack,
                        { backgroundColor: theme.colors.border || 'rgba(0,0,0,0.2)' },
                        sliderTrackStyle,
                    ]}
                    pointerEvents="none"
                />
            )}

            {/* Lock/Cancel Indicator (WhatsApp-style) */}
            {recorderState.isRecording && (
                <Animated.View
                    style={[
                        styles.lockIndicator,
                        lockIndicatorAnimatedStyle,
                    ]}
                    pointerEvents="none"
                >
                    <LockIndicatorContent
                        isLocked={isLocked}
                        isInCancelZone={isInCancelZone}
                        dragY={dragY}
                    />
                </Animated.View>
            )}

            <GestureDetector gesture={combinedGesture}>
                <Animated.View style={buttonAnimatedStyle}>
                    <TouchableOpacity
                        style={[
                            styles.button,
                            { backgroundColor: buttonBackgroundColor },
                        ]}
                        onPress={handleQuickPress}
                        activeOpacity={0.8}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        disabled={recorderState.isRecording && !isLocked}
                    >
                        {hasText ? (
                            <SendIcon color={iconColor} size={20} />
                        ) : (
                            <MicIcon color={iconColor} size={20} />
                        )}
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
    button: {
        width: BUTTON_SIZE,
        height: BUTTON_SIZE,
        borderRadius: BUTTON_SIZE / 2,
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
        elevation: 2,
        zIndex: 10,
    },
    lockIndicator: {
        position: 'absolute',
        top: -80,
        left: '50%',
        marginLeft: -100,
        width: 200,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: 0,
        zIndex: 100,
    },
    lockIndicatorContent: {
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        borderRadius: 20,
        paddingHorizontal: 20,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    lockIndicatorText: {
        color: '#FFFFFF',
        fontSize: 15,
        fontWeight: '600',
    },
});

