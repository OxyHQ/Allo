import React from "react";
import { View, Text, StyleSheet, Platform, TouchableOpacity } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { useTheme } from "@/hooks/useTheme";
import { colors } from "@/styles/colors";
import { MicIcon } from "@/assets/icons";

interface MicPermissionSheetProps {
    onEnable: () => void;
    onLater: () => void;
}

export const MicPermissionSheet: React.FC<MicPermissionSheetProps> = ({ onEnable, onLater }) => {
    const theme = useTheme();

    return (
        <ThemedView style={styles.container}>
            <View style={styles.iconWrap}>
                <MicIcon size={64} color={theme.colors.primary || colors.buttonPrimary || '#007AFF'} />
            </View>
            <Text style={[styles.title, { color: theme.colors.text }]}>
                Allow Microphone Access
            </Text>
            <Text style={[styles.subtitle, { color: theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5 }]}>
                To record voice messages, we need access to your microphone. Please enable microphone permissions in your device settings.
            </Text>
            <View style={styles.actions}>
                <TouchableOpacity 
                    onPress={onLater} 
                    style={[styles.button, styles.secondary, { borderColor: theme.colors.border || colors.chatInputBorder }]}
                >
                    <Text style={[styles.buttonText, styles.secondaryText, { color: theme.colors.text }]}>
                        Not Now
                    </Text>
                </TouchableOpacity>
                <TouchableOpacity 
                    onPress={onEnable} 
                    style={[styles.button, styles.primary, { backgroundColor: theme.colors.primary || colors.buttonPrimary || '#007AFF' }]}
                >
                    <Text style={[styles.buttonText, styles.primaryText]}>
                        Enable Microphone
                    </Text>
                </TouchableOpacity>
            </View>
        </ThemedView>
    );
};

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 24,
    },
    iconWrap: {
        alignItems: "center",
        justifyContent: "center",
        marginTop: 6,
        marginBottom: 16,
    },
    title: {
        fontSize: 20,
        fontWeight: Platform.OS === 'web' ? 'bold' : '600',
        textAlign: 'center',
        marginBottom: 8,
    },
    subtitle: {
        fontSize: 15,
        textAlign: 'center',
        lineHeight: 22,
        marginHorizontal: 8,
        marginBottom: 24,
    },
    actions: {
        gap: 12,
    },
    button: {
        borderRadius: 12,
        paddingVertical: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    primary: {
        minHeight: 48,
    },
    secondary: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        minHeight: 48,
    },
    buttonText: {
        fontSize: 16,
        fontWeight: Platform.OS === 'web' ? '600' : '600',
    },
    primaryText: {
        color: '#fff',
    },
    secondaryText: {
        // Color set dynamically based on theme
    },
});

export default MicPermissionSheet;

