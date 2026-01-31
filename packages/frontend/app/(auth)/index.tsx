import React from 'react';
import { View, StyleSheet, Text, Image } from 'react-native';
import { OxySignInButton } from '@oxyhq/services';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';

export default function WelcomeScreen() {
    const theme = useTheme();

    return (
        <ThemedView style={styles.container}>
            <View style={styles.animationContainer}>
                <Image
                    source={require('@/assets/images/welcome.png')}
                    style={styles.welcomeImage}
                    resizeMode="contain"
                />
            </View>

            <ThemedText style={[styles.title, { color: theme.colors.text }]}>
                Welcome to Allo
            </ThemedText>

            <Text style={[styles.privacyText, { color: theme.colors.textSecondary }]}>
                Read our{' '}
                <Text style={{ color: theme.colors.primary }}>Privacy Policy</Text>
                . Tap &quot;Continue&quot; to accept the{' '}
                <Text style={{ color: theme.colors.primary }}>Terms of Service</Text>.
            </Text>

            <View style={styles.signInButtonContainer}>
                <OxySignInButton />
            </View>
        </ThemedView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    animationContainer: {
        marginBottom: 40,
    },
    welcomeImage: {
        width: 280,
        height: 280,
    },
    title: {
        fontSize: 28,
        fontWeight: 'bold',
        marginBottom: 24,
        textAlign: 'center',
    },
    privacyText: {
        fontSize: 14,
        textAlign: 'center',
        lineHeight: 20,
        marginBottom: 32,
        maxWidth: 340,
    },
    signInButtonContainer: {
        width: '100%',
        maxWidth: 400,
    },
});
