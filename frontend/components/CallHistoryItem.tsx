import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import * as Icons from 'phosphor-react-native';
import { colors, radius, spacingX, spacingY } from '@/constants/theme';
import Typo from './Typo';
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

    return (
        <TouchableOpacity style={styles.container} onPress={handlePress} activeOpacity={0.7}>
            <View style={styles.leftSection}>
                <Avatar
                    size={50}
                    uri={conversationAvatar || null}
                    isGroup={!isDirect}
                />

                <View style={styles.callInfo}>
                    <View style={styles.nameAndIcon}>
                        <Typo
                            size={16}
                            fontWeight="500"
                            color={colors.text}
                            style={styles.name}
                        >
                            {conversationName}
                        </Typo>
                        {getCallIcon()}
                    </View>

                    <View style={styles.callDetails}>
                        <Typo
                            size={14}
                            color={getTextColor()}
                            fontWeight={status === 'missed' ? '500' : '400'}
                        >
                            {getCallText()}
                        </Typo>
                        {duration && (
                            <>
                                <Typo size={14} color={colors.timestampText}> • </Typo>
                                <Typo size={14} color={colors.timestampText}>
                                    {duration}
                                </Typo>
                            </>
                        )}
                    </View>

                    <Typo size={12} color={colors.timestampText} style={styles.timestamp}>
                        {formatTimestamp(timestamp)}
                    </Typo>
                </View>
            </View>

            <TouchableOpacity
                style={styles.callButton}
                onPress={handleCallBack}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
                <Icons.Phone
                    size={20}
                    color={callType === 'video' ? colors.accentBlue : colors.alloGreen}
                    weight="fill"
                />
            </TouchableOpacity>
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacingX._15,
        paddingVertical: spacingY._12,
        backgroundColor: colors.white,
    },
    leftSection: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        gap: spacingX._12,
    },
    callInfo: {
        flex: 1,
        gap: spacingY._5,
    },
    nameAndIcon: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacingX._10,
    },
    name: {
        flex: 1,
    },
    callDetails: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    timestamp: {
        marginTop: spacingY._5,
    },
    callButton: {
        padding: spacingX._10,
        borderRadius: radius._20,
        backgroundColor: colors.neutral100,
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: spacingX._12,
    },
});

export default CallHistoryItem; 