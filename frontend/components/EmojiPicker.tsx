import React from "react";
import { View, TouchableOpacity, StyleSheet, Modal } from "react-native";
import Typo from "./Typo";
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
        <Modal
            visible={visible}
            transparent={true}
            animationType="fade"
            onRequestClose={onClose}
        >
            <TouchableOpacity
                style={styles.overlay}
                activeOpacity={1}
                onPress={onClose}
            >
                <View
                    style={[
                        styles.container,
                        {
                            top: Math.max(position.y - 60, 50), // Position above the message
                            left: Math.max(Math.min(position.x - 150, 300), 20), // Center and stay within bounds
                        }
                    ]}
                >
                    <View style={styles.picker}>
                        {QUICK_REACTIONS.map((emoji) => (
                            <TouchableOpacity
                                key={emoji}
                                style={styles.emojiButton}
                                onPress={() => handleEmojiPress(emoji)}
                                activeOpacity={0.7}
                            >
                                <Typo size={24} style={styles.emoji}>
                                    {emoji}
                                </Typo>
                            </TouchableOpacity>
                        ))}
                    </View>
                    <View style={styles.arrow} />
                </View>
            </TouchableOpacity>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.1)',
    },
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