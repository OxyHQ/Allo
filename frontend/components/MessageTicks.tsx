import React from "react";
import { View, StyleSheet } from "react-native";
import { Check } from "phosphor-react-native";
import { colors } from "@/constants/theme";

type MessageTicksProps = {
    status?: 'sent' | 'delivered' | 'read';
    size?: number;
};

const MessageTicks = ({ status = 'sent', size = 12 }: MessageTicksProps) => {
    const getTickColor = () => {
        switch (status) {
            case 'read':
                return colors.accentBlue; // Blue for read messages
            case 'delivered':
            case 'sent':
            default:
                return colors.timestampText; // Gray for sent/delivered
        }
    };

    const tickColor = getTickColor();

    return (
        <View style={styles.tickContainer}>
            {/* Single tick for sent, double ticks for delivered/read */}
            {status === 'sent' ? (
                <Check
                    size={size}
                    color={tickColor}
                    weight="bold"
                />
            ) : (
                <>
                    {/* First tick (slightly offset) */}
                    <Check
                        size={size}
                        color={tickColor}
                        weight="bold"
                        style={[styles.firstTick, { marginRight: -size * 0.4 }]}
                    />
                    {/* Second tick */}
                    <Check
                        size={size}
                        color={tickColor}
                        weight="bold"
                    />
                </>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    tickContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 2,
    },
    firstTick: {
        opacity: 0.7, // Slightly faded for depth effect
    },
});

export default MessageTicks; 