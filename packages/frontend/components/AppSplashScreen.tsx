import React, { useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Animated, StyleSheet, Platform } from 'react-native';
import { LogoIcon } from '@/assets/logo';
import LoadingSpinner from './LoadingSpinner';
import { useTheme } from '@/hooks/useTheme';

interface AppSplashScreenProps {
    onFadeComplete?: () => void;
    startFade?: boolean;
}

const FADE_DURATION = 200;
const LOGO_SIZE = 100;
const SPINNER_SIZE = 28;

const AppSplashScreen: React.FC<AppSplashScreenProps> = ({
    onFadeComplete,
    startFade = false
}) => {
    const theme = useTheme();
    const fadeAnim = useRef(new Animated.Value(1)).current;
    const animationRef = useRef<Animated.CompositeAnimation | null>(null);

    const handleFadeComplete = useCallback(
        (finished: boolean) => {
            if (finished && onFadeComplete) {
                onFadeComplete();
            }
        },
        [onFadeComplete],
    );

    useEffect(() => {
        if (startFade) {
            // Cancel any existing animation
            animationRef.current?.stop();

            // Start fade out animation
            animationRef.current = Animated.timing(fadeAnim, {
                toValue: 0,
                duration: FADE_DURATION,
                useNativeDriver: Platform.OS !== 'web',
            });

            animationRef.current.start(({ finished }) => {
                handleFadeComplete(finished);
            });
        }

        return () => {
            animationRef.current?.stop();
        };
    }, [startFade, fadeAnim, handleFadeComplete]);

    // Memoized styles
    const containerStyle = useMemo(
        () => [styles.container, { opacity: fadeAnim }],
        [fadeAnim]
    );

    const backgroundColor = theme.isDark ? '#000000' : '#FFFFFF';
    const contentColor = theme.isDark ? '#FFFFFF' : '#000000';

    return (
        <Animated.View style={containerStyle}>
            <View style={[styles.background, { backgroundColor }]}>
                <View style={styles.logoContainer}>
                    <LogoIcon size={LOGO_SIZE} color={contentColor} />
                    <View style={styles.spinnerContainer}>
                        <LoadingSpinner size={SPINNER_SIZE} color={contentColor} showText={false} />
                    </View>
                </View>
            </View>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    background: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    logoContainer: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    spinnerContainer: {
        marginTop: 32,
    },
});

export default React.memo(AppSplashScreen);
