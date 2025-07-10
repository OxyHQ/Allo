import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import * as Icons from 'phosphor-react-native';
import { colors, radius, spacingX, spacingY } from '@/constants/theme';
import Typo from './Typo';

interface CallEventMessageProps {
    callType: 'audio' | 'video';
    callStatus: 'missed' | 'incoming' | 'outgoing';
    duration?: string; // e.g., "2:30"
    timestamp: string;
    isMe: boolean;
    onCallBack?: () => void;
}

const CallEventMessage: React.FC<CallEventMessageProps> = ({
    callType,
    callStatus,
    duration,
    timestamp,
    isMe,
    onCallBack,
}) => {
    const getCallIcon = () => {
        if (callType === 'video') {
            return <Icons.VideoCamera size={16} color={getIconColor()} weight="fill" />;
        }

        if (callStatus === 'missed') {
            return <Icons.PhoneX size={16} color={colors.rose} weight="fill" />;
        }

        if (callStatus === 'incoming') {
            return <Icons.PhoneIncoming size={16} color={colors.alloGreen} weight="fill" />;
        }

        return <Icons.PhoneOutgoing size={16} color={colors.alloGreen} weight="fill" />;
    };

    const getIconColor = () => {
        if (callStatus === 'missed') return colors.rose;
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

        if (callStatus === 'missed') {
            return `Missed ${baseText.toLowerCase()}`;
        }

        if (callStatus === 'incoming') {
            return `Incoming ${baseText.toLowerCase()}`;
        }

        if (callStatus === 'outgoing') {
            return `Outgoing ${baseText.toLowerCase()}`;
        }

        return baseText;
    };

    const getTextColor = () => {
        if (callStatus === 'missed') return colors.rose;
        return colors.text;
    };

    return (
        <View style={[
            styles.container,
            isMe ? styles.outgoingContainer : styles.incomingContainer
        ]}>
            <TouchableOpacity
                style={styles.callContent}
                onPress={onCallBack}
                activeOpacity={0.7}
            >
                <View style={styles.callInfo}>
                    <View style={styles.iconAndText}>
                        {getCallIcon()}
                        <View style={styles.textContainer}>
                            <Typo
                                size={14}
                                color={getTextColor()}
                                fontWeight={callStatus === 'missed' ? '500' : '400'}
                            >
                                {getCallText()}
                            </Typo>
                            {duration && (
                                <Typo size={12} color={colors.timestampText}>
                                    {duration}
                                </Typo>
                            )}
                        </View>
                    </View>

                    {/* Call back button */}
                    <TouchableOpacity
                        style={styles.callBackButton}
                        onPress={onCallBack}
                    >
                        <Icons.Phone
                            size={18}
                            color={callType === 'video' ? colors.accentBlue : colors.alloGreen}
                            weight="fill"
                        />
                    </TouchableOpacity>
                </View>

                <Typo size={11} color={colors.timestampText} style={styles.timestamp}>
                    {timestamp}
                </Typo>
            </TouchableOpacity>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        marginVertical: spacingY._5,
        maxWidth: '80%',
    },
    outgoingContainer: {
        alignSelf: 'flex-end',
        marginLeft: '20%',
    },
    incomingContainer: {
        alignSelf: 'flex-start',
        marginRight: '20%',
    },
    callContent: {
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        borderRadius: radius._15,
        padding: spacingY._12,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.2)',
    },
    callInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    iconAndText: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        gap: spacingX._7,
    },
    textContainer: {
        flex: 1,
    },
    callBackButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: 'rgba(255, 255, 255, 0.2)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    timestamp: {
        textAlign: 'right',
        marginTop: spacingY._5,
    },
});

export default CallEventMessage; 