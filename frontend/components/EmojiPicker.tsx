import React from "react";
import { View, StyleSheet } from "react-native";
import { Modal, Portal, IconButton, Text } from "react-native-paper";
import { colors, radius, spacingX, spacingY } from "@/constants/theme";

type EmojiPickerProps = {
    visible: boolean;
    onClose: () => void;
    onEmojiSelect: (emoji: string) => void;
    position?: { x: number; y: number };
};

const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '👍', '👎', '🙏'];

const EmojiPicker = ({
    visible,
    onClose,
    onEmojiSelect,
    position = { x: 0, y: 0 }
}: EmojiPickerProps) => {
    const handleEmojiPress = (emoji: string) => {
        onEmojiSelect(emoji);
        onClose();
    };

    return (
        <Portal>
            <Modal
                visible={visible}
                onDismiss={onClose}
                contentContainerStyle={[
                    styles.container,
                    {
                        top: Math.max(position.y - 60, 50), // Position above the message
                        left: Math.max(Math.min(position.x - 150, 300), 20), // Center and stay within bounds
                    }
                ]}
            >
                <View style={styles.picker}>
                    {QUICK_REACTIONS.map((emoji) => (
                        <IconButton
                            key={emoji}
                            icon={() => (
                                <Text variant="headlineMedium" style={styles.emoji}>
                                    {emoji}
                                </Text>
                            )}
                            onPress={() => handleEmojiPress(emoji)}
                            style={styles.emojiButton}
                            size={36}
                        />
                    ))}
                </View>
                <View style={styles.arrow} />
            </Modal>
        </Portal>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        zIndex: 1000,
    },
    picker: {
        flexDirection: 'row',
        backgroundColor: colors.white,
        borderRadius: radius._20,
        paddingHorizontal: spacingX._10,
        paddingVertical: spacingY._7,
        shadowColor: '#000',
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.25,
        shadowRadius: 8,
        elevation: 5,
        gap: spacingX._5,
    },
    emojiButton: {
        padding: spacingX._5,
        borderRadius: radius._10,
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 36,
        minHeight: 36,
    },
    emoji: {
        textAlign: 'center',
    },
    arrow: {
        position: 'absolute',
        bottom: -8,
        left: '50%',
        marginLeft: -8,
        width: 0,
        height: 0,
        borderLeftWidth: 8,
        borderRightWidth: 8,
        borderTopWidth: 8,
        borderLeftColor: 'transparent',
        borderRightColor: 'transparent',
        borderTopColor: colors.white,
    },
});

export default EmojiPicker; 