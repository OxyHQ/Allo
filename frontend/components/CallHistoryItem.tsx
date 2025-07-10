import React from 'react';
import { View, StyleSheet } from 'react-native';
import { List, IconButton, Text } from 'react-native-paper';
import * as Icons from 'phosphor-react-native';
import { colors, radius, spacingX, spacingY } from '@/constants/theme';
import Avatar from './Avatar';
import { useRouter } from 'expo-router';

interface CallHistoryItemProps {
    id: string;
    conversationId: string;
    conversationName: string;
    conversationAvatar?: string;
    callType: 'audio' | 'video';
    status: 'missed' | 'incoming' | 'outgoing';
    duration?: string;
    timestamp: string;
    participants: string[];
    isDirect: boolean;
    onCallBack?: (callType: 'audio' | 'video') => void;
}

const CallHistoryItem: React.FC<CallHistoryItemProps> = ({
    id,
    conversationId,
    conversationName,
    conversationAvatar,
    callType,
    status,
    duration,
    timestamp,
    participants,
    isDirect,
    onCallBack,
}) => {
    const router = useRouter();

    const getCallIcon = () => {
        if (callType === 'video') {
            return <Icons.VideoCamera size={20} color={getIconColor()} weight="fill" />;
        }

        if (status === 'missed') {
            return <Icons.PhoneX size={20} color={colors.rose} weight="fill" />;
        }

        if (status === 'incoming') {
            return <Icons.PhoneIncoming size={20} color={colors.alloGreen} weight="fill" />;
        }

        return <Icons.PhoneOutgoing size={20} color={colors.alloGreen} weight="fill" />;
    };

    const getIconColor = () => {
        if (status === 'missed') return colors.rose;
        if (callType === 'video') return colors.accentBlue;
        return colors.alloGreen;
    };

    const getCallText = () => {
        let baseText = '';

        if (callType === 'video') {
            baseText = 'Video call';
        } else {
            baseText = 'Call';
        }

        if (status === 'missed') {
            return `Missed ${baseText.toLowerCase()}`;
        }

        if (status === 'incoming') {
            return `Incoming ${baseText.toLowerCase()}`;
        }

        if (status === 'outgoing') {
            return `Outgoing ${baseText.toLowerCase()}`;
        }

        return baseText;
    };

    const getTextColor = () => {
        if (status === 'missed') return colors.rose;
        return colors.text;
    };

    const formatTimestamp = (isoString: string) => {
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return `${diffDays}d ago`;

        return date.toLocaleDateString();
    };

    const handlePress = () => {
        // Navigate to conversation
        router.push({
            pathname: '/(main)/conversation',
            params: {
                id: conversationId,
                name: conversationName,
                avatar: conversationAvatar || '',
                type: isDirect ? 'direct' : 'group',
                participants: participants.join(','),
            },
        });
    };

    const handleCallBack = () => {
        if (onCallBack) {
            onCallBack(callType);
        }
    };

    const renderAvatar = () => (
        <Avatar
            size={50}
            uri={conversationAvatar || null}
            isGroup={!isDirect}
        />
    );

    const renderDescription = () => (
        <View style={styles.descriptionContainer}>
            <View style={styles.callDetails}>
                {getCallIcon()}
                <Text
                    variant="bodyMedium"
                    style={[
                        styles.callText,
                        {
                            color: getTextColor(),
                            fontWeight: status === 'missed' ? '500' : '400'
                        }
                    ]}
                >
                    {getCallText()}
                </Text>
                {duration && (
                    <>
                        <Text variant="bodyMedium" style={{ color: colors.timestampText }}> • </Text>
                        <Text variant="bodyMedium" style={{ color: colors.timestampText }}>
                            {duration}
                        </Text>
                    </>
                )}
            </View>
            <Text variant="labelSmall" style={[styles.timestamp, { color: colors.timestampText }]}>
                {formatTimestamp(timestamp)}
            </Text>
        </View>
    );

    const renderRight = () => (
        <IconButton
            icon="phone"
            onPress={handleCallBack}
            iconColor={callType === 'video' ? colors.accentBlue : colors.alloGreen}
            size={20}
        />
    );

    return (
        <List.Item
            title={conversationName}
            description={renderDescription}
            left={renderAvatar}
            right={renderRight}
            onPress={handlePress}
            style={styles.container}
            titleStyle={styles.titleStyle}
        />
    );
};

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: spacingX._15,
        backgroundColor: colors.white,
    },
    titleStyle: {
        fontSize: 16,
        fontWeight: "500",
        color: colors.text,
    },
    descriptionContainer: {
        flex: 1,
    },
    callDetails: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: spacingY._5,
    },
    callText: {
        marginLeft: spacingX._5,
    },
    timestamp: {
        marginTop: spacingY._5,
    },
});

export default CallHistoryItem; 