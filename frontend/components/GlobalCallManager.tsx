import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Modal, TouchableOpacity, Dimensions } from 'react-native';
import { useGlobalCall } from '@/contexts/globalCallContext';
import { useAuth } from '@/contexts/authContext';
import { useCallHistory } from '@/contexts/callHistoryContext';
import { colors, spacingX, spacingY, radius } from '@/constants/theme';
import { Text } from 'react-native-paper';
import Avatar from './Avatar';
import * as Icons from 'phosphor-react-native';
import { answerCall, endCall } from '@/socket/socketEvents';
import { useRouter } from 'expo-router';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

const GlobalCallManager: React.FC = () => {
    const { currentCall, isCallManagerVisible, hideCallManager } = useGlobalCall();
    const { user: currentUser } = useAuth();
    const { updateCallDuration } = useCallHistory();
    const router = useRouter();

    const acceptCall = () => {
        if (currentCall) {
            answerCall({
                callId: currentCall.callId,
                conversationId: currentCall.conversationId,
                answer: 'accept',
            });

            // Add call to history as accepted
            updateCallDuration(currentCall.callId, 'accepted');

            // Navigate to conversation with call state
            router.push({
                pathname: '/(main)/conversation',
                params: {
                    id: currentCall.conversationId,
                    name: currentCall.conversationName || currentCall.callerName,
                    avatar: currentCall.conversationAvatar || '',
                    type: currentCall.isDirect ? 'direct' : 'group',
                    participants: currentCall.participants?.join(',') || '',
                    acceptedCall: 'true', // Flag to indicate call was accepted
                    callType: currentCall.callType,
                    callId: currentCall.callId,
                    callerId: currentCall.callerId,
                    callerName: currentCall.callerName,
                },
            });

            // Hide the global call manager
            hideCallManager();
        }
    };

    const declineCall = () => {
        if (currentCall) {
            answerCall({
                callId: currentCall.callId,
                conversationId: currentCall.conversationId,
                answer: 'decline',
            });

            // Add call to history as declined
            updateCallDuration(currentCall.callId, 'declined');

            hideCallManager();
        }
    };

    if (!isCallManagerVisible || !currentCall) {
        return null;
    }

    return (
        <Modal
            visible={isCallManagerVisible}
            animationType="slide"
            presentationStyle="overFullScreen"
            statusBarTranslucent
        >
            <View style={styles.container}>
                <View style={styles.callHeader}>
                    <Text style={{ color: colors.white, fontSize: 18, fontWeight: "500" }}>
                        Incoming {currentCall.callType} call
                    </Text>
                </View>

                <View style={styles.callerInfo}>
                    <Avatar
                        size={120}
                        uri={currentCall.conversationAvatar || null}
                        isGroup={!currentCall.isDirect}
                    />
                    <Text style={[styles.callerName, { color: colors.white, fontSize: 24, fontWeight: "600" }]}>
                        {currentCall.conversationName || currentCall.callerName}
                    </Text>
                    <Text style={[styles.callStatus, { color: colors.white, fontSize: 16 }]}>
                        {currentCall.callType === 'video' ? 'Incoming video call' : 'Incoming call'}
                    </Text>
                </View>

                <View style={styles.callActions}>
                    <TouchableOpacity
                        style={[styles.callButton, styles.declineButton]}
                        onPress={declineCall}
                    >
                        <Icons.PhoneX color={colors.white} size={28} weight="fill" />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.callButton, styles.acceptButton]}
                        onPress={acceptCall}
                    >
                        <Icons.Phone color={colors.white} size={28} weight="fill" />
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.alloGreenDark,
        justifyContent: 'space-between',
        paddingTop: spacingY._60,
        paddingBottom: spacingY._50,
        paddingHorizontal: spacingX._20,
    },
    callHeader: {
        alignItems: 'center',
        marginTop: spacingY._30,
    },
    callerInfo: {
        alignItems: 'center',
        gap: spacingY._20,
    },
    callerName: {
        textAlign: 'center',
        marginTop: spacingY._10,
    },
    callStatus: {
        textAlign: 'center',
        opacity: 0.8,
    },
    callActions: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        paddingHorizontal: spacingX._40,
    },
    callButton: {
        width: 70,
        height: 70,
        borderRadius: 35,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 8,
        shadowColor: colors.black,
        shadowOffset: {
            width: 0,
            height: 4,
        },
        shadowOpacity: 0.3,
        shadowRadius: 4.65,
    },
    declineButton: {
        backgroundColor: colors.rose,
    },
    acceptButton: {
        backgroundColor: colors.alloGreen,
    },
});

export default GlobalCallManager; 