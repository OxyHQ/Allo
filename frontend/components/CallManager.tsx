import React, { useEffect, useRef, useState } from 'react';
import {
    View,
    StyleSheet,
    Dimensions,
    TouchableOpacity,
    Alert,
    Platform,
    Vibration,
} from 'react-native';
import { Text } from 'react-native-paper';
import * as Icons from 'phosphor-react-native';
import { colors, radius, spacingX, spacingY } from '@/constants/theme';
import Avatar from './Avatar';
import {
    incomingCall,
    callInitiated,
    answerCall,
    callAnswered,
    endCall,
    callEnded,
    webrtcSignal,
} from '@/socket/socketEvents';
import { useAuth } from '@/contexts/authContext';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

// Types
interface Caller {
    id: string;
    name: string;
    avatar?: string;
}

interface CallState {
    isActive: boolean;
    callId: string | null;
    caller: Caller | null;
    callType: 'audio' | 'video';
    status: 'incoming' | 'outgoing' | 'connected' | 'ended';
    conversationId: string | null;
}

interface CallManagerProps {
    visible: boolean;
    onClose: (callInfo?: { duration?: string; callType?: 'audio' | 'video' }) => void;
    conversationId?: string;
    conversationName?: string;
    conversationAvatar?: string;
    isDirect?: boolean;
    initiateCall?: {
        callType: 'audio' | 'video';
        callerId: string;
        callerName: string;
    };
}

const CallManager: React.FC<CallManagerProps> = ({
    visible,
    onClose,
    conversationId,
    conversationName,
    conversationAvatar,
    isDirect,
    initiateCall
}) => {
    const { user } = useAuth();
    const [callState, setCallState] = useState<CallState>({
        isActive: false,
        callId: null,
        caller: null,
        callType: 'audio',
        status: 'incoming',
        conversationId: null,
    });
    const [callDuration, setCallDuration] = useState(0);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoEnabled, setIsVideoEnabled] = useState(true);
    const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(false);
    const callTimer = useRef<number | null>(null);

    // Initialize call state from props or context
    useEffect(() => {
        if (visible && initiateCall) {
            setCallState({
                isActive: true,
                callId: `call_${Date.now()}`,
                caller: {
                    id: initiateCall.callerId,
                    name: initiateCall.callerName,
                    avatar: conversationAvatar || '',
                },
                callType: initiateCall.callType,
                status: 'outgoing',
                conversationId: conversationId || '',
            });
        }
    }, [visible, initiateCall, conversationId, conversationName, conversationAvatar]);

    // Call timer
    useEffect(() => {
        if (callState.status === 'connected') {
            callTimer.current = setInterval(() => {
                setCallDuration(prev => prev + 1);
            }, 1000);
        } else {
            if (callTimer.current) {
                clearInterval(callTimer.current);
                callTimer.current = null;
            }
            setCallDuration(0);
        }

        return () => {
            if (callTimer.current) {
                clearInterval(callTimer.current);
            }
        };
    }, [callState.status]);

    // Vibration for incoming calls
    useEffect(() => {
        if (callState.status === 'incoming' && Platform.OS === 'ios') {
            const vibrationPattern = [1000, 1000, 1000, 1000];
            Vibration.vibrate(vibrationPattern, true);
        } else {
            Vibration.cancel();
        }

        return () => {
            Vibration.cancel();
        };
    }, [callState.status]);

    const formatDuration = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    const handleAcceptCall = async () => {
        try {
            if (!callState.callId || !callState.conversationId) return;

            // Emit answer call event
            answerCall({
                callId: callState.callId,
                conversationId: callState.conversationId,
                answer: 'accept',
            });

            // Update call state
            setCallState(prev => ({
                ...prev,
                status: 'connected',
            }));

            // Initialize WebRTC connection here
            // This would involve setting up media streams and peer connections
            console.log('Call accepted, setting up WebRTC...');

        } catch (error) {
            console.error('Error accepting call:', error);
            Alert.alert('Error', 'Failed to accept call');
        }
    };

    const handleDeclineCall = async () => {
        try {
            if (!callState.callId || !callState.conversationId) return;

            // Emit answer call event
            answerCall({
                callId: callState.callId,
                conversationId: callState.conversationId,
                answer: 'decline',
            });

            // End call
            handleEndCall();

        } catch (error) {
            console.error('Error declining call:', error);
            Alert.alert('Error', 'Failed to decline call');
        }
    };

    const handleEndCall = async () => {
        try {
            if (callState.callId && callState.conversationId) {
                // Emit end call event
                endCall({
                    callId: callState.callId,
                    conversationId: callState.conversationId,
                });
            }

            // Reset call state
            setCallState({
                isActive: false,
                callId: null,
                caller: null,
                callType: 'audio',
                status: 'ended',
                conversationId: null,
            });

            // Reset other states
            setCallDuration(0);
            setIsMuted(false);
            setIsVideoEnabled(true);
            setIsSpeakerEnabled(false);

            // Close call manager
            onClose();

        } catch (error) {
            console.error('Error ending call:', error);
            Alert.alert('Error', 'Failed to end call');
        }
    };

    const handleToggleMute = () => {
        setIsMuted(!isMuted);
        // Here you would mute/unmute the audio track
        console.log('Toggling mute:', !isMuted);
    };

    const handleToggleVideo = () => {
        setIsVideoEnabled(!isVideoEnabled);
        // Here you would enable/disable the video track
        console.log('Toggling video:', !isVideoEnabled);
    };

    const handleToggleSpeaker = () => {
        setIsSpeakerEnabled(!isSpeakerEnabled);
        // Here you would switch between speaker and earpiece
        console.log('Toggling speaker:', !isSpeakerEnabled);
    };

    const handleSwitchCamera = () => {
        // Here you would switch between front and back camera
        console.log('Switching camera');
    };

    if (!visible || !callState.isActive) {
        return null;
    }

    return (
        <View style={styles.container}>
            {/* Incoming Call UI */}
            {callState.status === 'incoming' && (
                <View style={styles.incomingCallContainer}>
                    <View style={styles.callHeader}>
                        <Text style={{ color: colors.white, fontSize: 18, fontWeight: '500' }}>
                            Incoming {callState.callType} call
                        </Text>
                    </View>

                    <View style={styles.callerInfo}>
                        <Avatar size={120} uri={callState.caller?.avatar || null} />
                        <Text style={[{ color: colors.white, fontSize: 24, fontWeight: '600' }, styles.callerName]}>
                            {callState.caller?.name}
                        </Text>
                        <Text style={[{ color: colors.white, fontSize: 16 }, styles.callStatus]}>
                            {callState.callType === 'video' ? 'Incoming video call' : 'Incoming call'}
                        </Text>
                    </View>

                    <View style={styles.incomingCallActions}>
                        <TouchableOpacity
                            style={[styles.callButton, styles.declineButton]}
                            onPress={handleDeclineCall}
                        >
                            <Icons.PhoneX size={32} color={colors.white} weight="fill" />
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.callButton, styles.acceptButton]}
                            onPress={handleAcceptCall}
                        >
                            <Icons.Phone size={32} color={colors.white} weight="fill" />
                        </TouchableOpacity>
                    </View>
                </View>
            )}

            {/* Outgoing Call UI */}
            {callState.status === 'outgoing' && (
                <View style={styles.outgoingCallContainer}>
                    <View style={styles.callHeader}>
                        <Text style={{ color: colors.white, fontSize: 18, fontWeight: '500' }}>
                            {callState.callType === 'video' ? 'Video calling...' : 'Calling...'}
                        </Text>
                    </View>

                    <View style={styles.callerInfo}>
                        <Avatar size={120} uri={callState.caller?.avatar || null} />
                        <Text style={[{ color: colors.white, fontSize: 24, fontWeight: '600' }, styles.callerName]}>
                            {callState.caller?.name}
                        </Text>
                        <Text style={[{ color: colors.white, fontSize: 16 }, styles.callStatus]}>
                            {callState.callType === 'video' ? 'Video calling...' : 'Calling...'}
                        </Text>
                    </View>

                    <View style={styles.outgoingCallActions}>
                        <TouchableOpacity
                            style={[styles.callButton, styles.endCallButton]}
                            onPress={handleEndCall}
                        >
                            <Icons.PhoneX size={32} color={colors.white} weight="fill" />
                        </TouchableOpacity>
                    </View>
                </View>
            )}

            {/* Active Call UI */}
            {callState.status === 'connected' && (
                <View style={styles.activeCallContainer}>
                    <View style={styles.callHeader}>
                        <Text style={{ color: colors.white, fontSize: 16, fontWeight: '500' }}>
                            {callState.caller?.name}
                        </Text>
                        <Text style={[{ color: colors.white, fontSize: 14 }, styles.duration]}>
                            {formatDuration(callDuration)}
                        </Text>
                    </View>

                    {/* Video Call Content */}
                    {callState.callType === 'video' && (
                        <View style={styles.videoCallContent}>
                            {/* Remote video stream placeholder */}
                            <View style={styles.remoteVideoContainer}>
                                {isVideoEnabled ? (
                                    <View style={styles.videoStreamPlaceholder}>
                                        <Icons.VideoCamera size={40} color={colors.white} weight="fill" />
                                        <Text style={[{ color: colors.white, fontSize: 16 }, styles.videoPlaceholder]}>
                                            {callState.caller?.name} video
                                        </Text>
                                        <Text style={[{ color: colors.white, fontSize: 12 }, styles.videoStatus]}>
                                            Connected
                                        </Text>
                                    </View>
                                ) : (
                                    <>
                                        <Avatar size={80} uri={callState.caller?.avatar || null} />
                                        <Text style={[{ color: colors.white, fontSize: 16 }, styles.videoPlaceholder]}>
                                            {isVideoEnabled ? 'Connecting video...' : 'Camera off'}
                                        </Text>
                                    </>
                                )}
                            </View>

                            {/* Local video stream placeholder */}
                            <View style={styles.localVideoContainer}>
                                <View style={styles.localVideoPlaceholder}>
                                    <Icons.User size={24} color={colors.white} weight="fill" />
                                </View>
                            </View>
                        </View>
                    )}

                    {/* Audio Call Content */}
                    {callState.callType === 'audio' && (
                        <View style={styles.audioCallContent}>
                            <Avatar size={150} uri={callState.caller?.avatar || null} />
                        </View>
                    )}

                    {/* Call Controls */}
                    <View style={styles.callControls}>
                        <TouchableOpacity
                            style={[styles.controlButton, isMuted && styles.controlButtonActive]}
                            onPress={handleToggleMute}
                        >
                            <Icons.Microphone size={24} color={colors.white} weight={isMuted ? "fill" : "regular"} />
                        </TouchableOpacity>

                        {callState.callType === 'video' && (
                            <>
                                <TouchableOpacity
                                    style={[styles.controlButton, !isVideoEnabled && styles.controlButtonActive]}
                                    onPress={handleToggleVideo}
                                >
                                    <Icons.VideoCamera size={24} color={colors.white} weight={isVideoEnabled ? "regular" : "fill"} />
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={styles.controlButton}
                                    onPress={handleSwitchCamera}
                                >
                                    <Icons.CameraRotate size={24} color={colors.white} weight="regular" />
                                </TouchableOpacity>
                            </>
                        )}

                        <TouchableOpacity
                            style={[styles.controlButton, isSpeakerEnabled && styles.controlButtonActive]}
                            onPress={handleToggleSpeaker}
                        >
                            <Icons.SpeakerHigh size={24} color={colors.white} weight={isSpeakerEnabled ? "fill" : "regular"} />
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.callButton, styles.endCallButton]}
                            onPress={handleEndCall}
                        >
                            <Icons.PhoneX size={32} color={colors.white} weight="fill" />
                        </TouchableOpacity>
                    </View>
                </View>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.alloGreen,
        zIndex: 1000,
    },
    incomingCallContainer: {
        flex: 1,
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: spacingY._60,
        paddingHorizontal: spacingX._40,
    },
    outgoingCallContainer: {
        flex: 1,
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: spacingY.xl,
        paddingHorizontal: spacingX.lg,
    },
    activeCallContainer: {
        flex: 1,
        justifyContent: 'space-between',
        paddingVertical: spacingY.lg,
        paddingHorizontal: spacingX.lg,
    },
    callHeader: {
        alignItems: 'center',
        marginTop: spacingY.xl,
    },
    callerInfo: {
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
    },
    callerName: {
        marginTop: spacingY.lg,
        textAlign: 'center',
    },
    callStatus: {
        marginTop: spacingY.sm,
        textAlign: 'center',
    },
    duration: {
        marginTop: spacingY.xs,
        textAlign: 'center',
    },
    incomingCallActions: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        width: '100%',
        maxWidth: 300,
    },
    outgoingCallActions: {
        alignItems: 'center',
    },
    callButton: {
        width: 70,
        height: 70,
        borderRadius: 35,
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: colors.black,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 3.84,
        elevation: 5,
    },
    acceptButton: {
        backgroundColor: colors.success,
    },
    declineButton: {
        backgroundColor: colors.error,
    },
    endCallButton: {
        backgroundColor: colors.error,
    },
    videoCallContent: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        marginVertical: spacingY.lg,
    },
    audioCallContent: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        marginVertical: spacingY.lg,
    },
    remoteVideoContainer: {
        width: '100%',
        height: '70%',
        backgroundColor: colors.black,
        borderRadius: radius.md,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: spacingY.lg,
    },
    localVideoContainer: {
        position: 'absolute',
        top: spacingY.lg,
        right: spacingX.lg,
        width: 120,
        height: 160,
        backgroundColor: colors.black,
        borderRadius: radius.md,
        borderWidth: 2,
        borderColor: colors.white,
    },
    localVideoPlaceholder: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.gray,
        borderRadius: radius.md,
    },
    videoStreamPlaceholder: {
        alignItems: 'center',
    },
    videoPlaceholder: {
        marginTop: spacingY.sm,
        textAlign: 'center',
    },
    videoStatus: {
        marginTop: spacingY.xs,
        textAlign: 'center',
    },
    callControls: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingHorizontal: spacingX.lg,
        paddingVertical: spacingY.lg,
    },
    controlButton: {
        width: 50,
        height: 50,
        borderRadius: 25,
        backgroundColor: 'rgba(255, 255, 255, 0.2)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    controlButtonActive: {
        backgroundColor: 'rgba(255, 255, 255, 0.4)',
    },
});

export default CallManager; 