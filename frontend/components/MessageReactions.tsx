import React from "react";
import { View, TouchableOpacity, StyleSheet } from "react-native";
import { Text } from "react-native-paper";
import { colors, radius, spacingX, spacingY } from "@/constants/theme";
import { useAuth } from "@/contexts/authContext";

type ReactionProps = {
    userId: string;
    emoji: string;
    createdAt: string;
};

type MessageReactionsProps = {
    reactions?: ReactionProps[];
    onReactionPress?: (emoji: string) => void;
    onReactionLongPress?: (emoji: string) => void;
    isMe?: boolean;
};

const MessageReactions = ({
    reactions = [],
    onReactionPress,
    onReactionLongPress,
    isMe = false
}: MessageReactionsProps) => {
    const { user: currentUser } = useAuth();

    if (!reactions || reactions.length === 0) {
        return null;
    }

    // Group reactions by emoji and count them
    const groupedReactions = reactions.reduce((acc, reaction) => {
        if (!acc[reaction.emoji]) {
            acc[reaction.emoji] = {
                emoji: reaction.emoji,
                count: 0,
                users: [],
                hasCurrentUser: false,
            };
        }
        acc[reaction.emoji].count++;
        acc[reaction.emoji].users.push(reaction.userId);
        if (reaction.userId === currentUser?.id) {
            acc[reaction.emoji].hasCurrentUser = true;
        }
        return acc;
    }, {} as Record<string, { emoji: string; count: number; users: string[]; hasCurrentUser: boolean }>);

    const reactionEntries = Object.values(groupedReactions);

    return (
        <View style={[
            styles.reactionsContainer,
            isMe ? styles.reactionsContainerRight : styles.reactionsContainerLeft
        ]}>
            {reactionEntries.map(({ emoji, count, hasCurrentUser }) => (
                <TouchableOpacity
                    key={emoji}
                    style={[
                        styles.reactionBubble,
                        hasCurrentUser && styles.reactionBubbleActive,
                    ]}
                    onPress={() => onReactionPress?.(emoji)}
                    onLongPress={() => onReactionLongPress?.(emoji)}
                    activeOpacity={0.7}
                >
                    <Text style={[styles.reactionEmoji, { fontSize: 14 }]}>
                        {emoji}
                    </Text>
                    {count > 1 && (
                        <Text
                            style={[
                                styles.reactionCount,
                                { fontSize: 12, color: hasCurrentUser ? colors.accentBlue : colors.timestampText, fontWeight: "600" }
                            ]}
                        >
                            {count}
                        </Text>
                    )}
                </TouchableOpacity>
            ))}
        </View>
    );
};

const styles = StyleSheet.create({
    reactionsContainer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginTop: -4,
        gap: spacingX._5,
    },
    reactionsContainerRight: {
        justifyContent: 'flex-end',
        alignSelf: 'flex-end',
    },
    reactionsContainerLeft: {
        justifyContent: 'flex-start',
        alignSelf: 'flex-start',
    },
    reactionBubble: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.neutral100,
        borderRadius: radius._15,
        paddingHorizontal: spacingX._7,
        paddingVertical: 2,
        borderWidth: 1,
        borderColor: colors.neutral200,
        minHeight: 24,
    },
    reactionBubbleActive: {
        backgroundColor: '#e3f2fd', // Light blue for user's own reaction
        borderColor: colors.accentBlue,
    },
    reactionEmoji: {
        marginRight: 2,
    },
    reactionCount: {
        marginLeft: 2,
    },
});

export default MessageReactions; 