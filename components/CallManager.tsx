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
import WebRTCService from '@/services/webrtcService';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

// Types
interface Caller {
    id: string;
    name: string;
    avatar?: string;
}

interface CallState {
    isActive: boolean;
    callId: string;
    caller: Caller;
    callType: 'audio' | 'video';
    status: 'incoming' | 'outgoing' | 'connected' | 'ended';
    duration?: number;
    conversationId: string;
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
    const [callState, setCallState] = useState<CallState | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoEnabled, setIsVideoEnabled] = useState(true);
    const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(false);
    const [callDuration, setCallDuration] = useState(0);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const webrtcService = useRef<WebRTCService>(new WebRTCService());

    // Initialize call state from props
    useEffect(() => {
        if (visible && initiateCall && conversationId) {
            console.log('Initializing call with:', { initiateCall, conversationId });
            setCallState({
                isActive: true,
                callId: `call_${Date.now()}`,
                caller: {
                    id: initiateCall.callerId,
                    name: initiateCall.callerName || conversationName || 'Unknown',
                    avatar: conversationAvatar,
                },
                callType: initiateCall.callType,
                status: 'outgoing',
                conversationId: conversationId,
            });

            // Set up WebRTC callbacks
            webrtcService.current.setSignalingCallback((data) => {
                console.log('Sending WebRTC signal:', data);
                webrtcSignal(data);
            });

            // Initialize the call
            webrtcService.current.initializeCall(
                `call_${Date.now()}`,
                initiateCall.callerId,
                initiateCall.callType === 'video'
            ).catch((error) => {
                console.error('Failed to initialize call:', error);
                Alert.alert('Call Failed', 'Unable to start the call. Please try again.');
                handleEndCall();
            });

            // Emit call initiated event
            callInitiated({
                conversationId: conversationId,
                callType: initiateCall.callType,
                callerId: user?.id || '',
                callerName: user?.name || 'Unknown',
            });
        }
    }, [visible, initiateCall, conversationId, conversationName, conversationAvatar, user]);

    // Handle call duration timer
    useEffect(() => {
        if (callState?.status === 'connected') {
            intervalRef.current = setInterval(() => {
                setCallDuration(prev => prev + 1);
            }, 1000);
        } else {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        }

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
        };
    }, [callState?.status]);

    // Socket event listeners
    useEffect(() => {
        const handleIncomingCall = (data: any) => {
            console.log('Incoming call:', data);
            if (data.conversationId === conversationId) {
                setCallState({
                    isActive: true,
                    callId: data.callId,
                    caller: {
                        id: data.callerId,
                        name: data.callerName,
                        avatar: data.callerAvatar,
                    },
                    callType: data.callType,
                    status: 'incoming',
                    conversationId: data.conversationId,
                });

                // Vibrate for incoming call
                if (Platform.OS === 'ios' || Platform.OS === 'android') {
                    Vibration.vibrate([0, 1000, 1000, 1000], true);
                }
            }
        };

        const handleCallAnswered = (data: any) => {
            console.log('Call answered:', data);
            if (data.callId === callState?.callId) {
                setCallState(prev => prev ? { ...prev, status: 'connected' } : null);
                setCallDuration(0);
            }
        };

        const handleCallEnded = (data: any) => {
            console.log('Call ended:', data);
            if (data.callId === callState?.callId) {
                setCallState(prev => prev ? { ...prev, status: 'ended' } : null);
                webrtcService.current.endCall();

                // Stop vibration
                Vibration.cancel();

                // Close call manager after a delay
                setTimeout(() => {
                    onClose({
                        duration: formatDuration(callDuration),
                        callType: callState?.callType,
                    });
                }, 2000);
            }
        };

        const handleWebRTCSignal = (data: any) => {
            console.log('Received WebRTC signal:', data);
            webrtcService.current.handleSignalingData(data);
        };

        // Add socket listeners
        incomingCall(handleIncomingCall);
        callAnswered(handleCallAnswered);
        callEnded(handleCallEnded);
        webrtcSignal(handleWebRTCSignal);

        return () => {
            // Cleanup socket listeners would go here
            // Note: The socket events don't seem to have cleanup functions
            // This would need to be implemented in the socket service
        };
    }, [callState?.callId, conversationId, callDuration, onClose]);

    const formatDuration = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    const handleAnswerCall = async () => {
        if (!callState) return;

        try {
            await webrtcService.current.answerCall(
                callState.callId,
                callState.caller.id,
                callState.callType === 'video'
            );

            answerCall({
                callId: callState.callId,
                conversationId: callState.conversationId,
            });

            setCallState(prev => prev ? { ...prev, status: 'connected' } : null);
            setCallDuration(0);

            // Stop vibration
            Vibration.cancel();
        } catch (error) {
            console.error('Failed to answer call:', error);
            Alert.alert('Call Failed', 'Unable to answer the call. Please try again.');
        }
    };

    const handleEndCall = () => {
        if (!callState) return;

        webrtcService.current.endCall();

        endCall({
            callId: callState.callId,
            conversationId: callState.conversationId,
        });

        // Stop vibration
        Vibration.cancel();

        onClose({
            duration: formatDuration(callDuration),
            callType: callState.callType,
        });
    };

    const handleToggleMute = async () => {
        const newMuteState = await webrtcService.current.toggleMicrophone();
        setIsMuted(!newMuteState);
    };

    const handleToggleVideo = async () => {
        const newVideoState = await webrtcService.current.toggleCamera();
        setIsVideoEnabled(newVideoState);
    };

    const handleToggleSpeaker = () => {
        setIsSpeakerEnabled(!isSpeakerEnabled);
        // In a real implementation, this would toggle the audio output
    };

    const handleSwitchCamera = async () => {
        await webrtcService.current.switchCamera();
    };

    if (!visible || !callState) {
        return null;
    }

    return (
        <View style={styles.container}>
            <View style={styles.callContainer}>
                {/* Call Header */}
                <View style={styles.header}>
                    <Text style={styles.callTypeText}>
                        {callState.status === 'incoming' && `Incoming ${callState.callType} call`}
                        {callState.status === 'outgoing' && `Calling...`}
                        {callState.status === 'connected' && formatDuration(callDuration)}
                        {callState.status === 'ended' && 'Call ended'}
                    </Text>
                </View>

                {/* Caller Info */}
                <View style={styles.callerInfo}>
                    <Avatar
                        uri={callState.caller.avatar}
                        name={callState.caller.name}
                        size={120}
                    />
                    <Text style={styles.callerName}>
                        {callState.caller.name}
                    </Text>
                    {callState.status === 'connected' && (
                        <Text style={styles.callStatus}>
                            Connected
                        </Text>
                    )}
                </View>

                {/* Video View (for video calls) */}
                {callState.callType === 'video' && callState.status === 'connected' && (
                    <View style={styles.videoContainer}>
                        <View style={styles.remoteVideo}>
                            <Text style={styles.videoPlaceholder}>
                                Remote Video
                            </Text>
                        </View>
                        <View style={styles.localVideo}>
                            <Text style={styles.videoPlaceholder}>
                                Local Video
                            </Text>
                        </View>
                    </View>
                )}

                {/* Call Controls */}
                <View style={styles.controls}>
                    {callState.status === 'incoming' && (
                        <View style={styles.incomingControls}>
                            <TouchableOpacity
                                style={[styles.controlButton, styles.declineButton]}
                                onPress={handleEndCall}
                            >
                                <Icons.PhoneX size={32} color={colors.white} weight="fill" />
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.controlButton, styles.acceptButton]}
                                onPress={handleAnswerCall}
                            >
                                <Icons.Phone size={32} color={colors.white} weight="fill" />
                            </TouchableOpacity>
                        </View>
                    )}

                    {(callState.status === 'outgoing' || callState.status === 'connected') && (
                        <View style={styles.activeControls}>
                            <TouchableOpacity
                                style={[styles.controlButton, isMuted && styles.activeControl]}
                                onPress={handleToggleMute}
                            >
                                <Icons.MicrophoneSlash
                                    size={24}
                                    color={isMuted ? colors.primary : colors.white}
                                    weight="fill"
                                />
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={[styles.controlButton, styles.endCallButton]}
                                onPress={handleEndCall}
                            >
                                <Icons.PhoneX size={32} color={colors.white} weight="fill" />
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={[styles.controlButton, isSpeakerEnabled && styles.activeControl]}
                                onPress={handleToggleSpeaker}
                            >
                                <Icons.SpeakerHigh
                                    size={24}
                                    color={isSpeakerEnabled ? colors.primary : colors.white}
                                    weight="fill"
                                />
                            </TouchableOpacity>
                        </View>
                    )}

                    {callState.callType === 'video' && callState.status === 'connected' && (
                        <View style={styles.videoControls}>
                            <TouchableOpacity
                                style={[styles.controlButton, !isVideoEnabled && styles.activeControl]}
                                onPress={handleToggleVideo}
                            >
                                <Icons.VideoCamera
                                    size={24}
                                    color={isVideoEnabled ? colors.white : colors.primary}
                                    weight="fill"
                                />
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.controlButton}
                                onPress={handleSwitchCamera}
                            >
                                <Icons.CameraRotate size={24} color={colors.white} weight="fill" />
                            </TouchableOpacity>
                        </View>
                    )}
                </View>
            </View>
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
        backgroundColor: colors.background,
        zIndex: 1000,
    },
    callContainer: {
        flex: 1,
        justifyContent: 'space-between',
        paddingTop: 60,
        paddingBottom: 40,
        paddingHorizontal: spacingX.large,
    },
    header: {
        alignItems: 'center',
        marginBottom: spacingY.large,
    },
    callTypeText: {
        fontSize: 18,
        color: colors.text,
        fontWeight: '500',
    },
    callerInfo: {
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
    },
    callerName: {
        fontSize: 32,
        fontWeight: '600',
        color: colors.text,
        marginTop: spacingY.medium,
        textAlign: 'center',
    },
    callStatus: {
        fontSize: 16,
        color: colors.textSecondary,
        marginTop: spacingY.small,
    },
    videoContainer: {
        flex: 1,
        position: 'relative',
        backgroundColor: colors.surface,
        borderRadius: radius.medium,
        overflow: 'hidden',
        marginVertical: spacingY.large,
    },
    remoteVideo: {
        flex: 1,
        backgroundColor: colors.surfaceVariant,
        justifyContent: 'center',
        alignItems: 'center',
    },
    localVideo: {
        position: 'absolute',
        top: 20,
        right: 20,
        width: 120,
        height: 160,
        backgroundColor: colors.surface,
        borderRadius: radius.small,
        justifyContent: 'center',
        alignItems: 'center',
    },
    videoPlaceholder: {
        color: colors.textSecondary,
        fontSize: 14,
    },
    controls: {
        alignItems: 'center',
    },
    incomingControls: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        width: '100%',
        maxWidth: 300,
    },
    activeControls: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        width: '100%',
        maxWidth: 250,
        marginBottom: spacingY.medium,
    },
    videoControls: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: spacingX.large,
    },
    controlButton: {
        width: 60,
        height: 60,
        borderRadius: 30,
        backgroundColor: colors.surfaceVariant,
        justifyContent: 'center',
        alignItems: 'center',
    },
    acceptButton: {
        backgroundColor: colors.success,
    },
    declineButton: {
        backgroundColor: colors.error,
    },
    endCallButton: {
        backgroundColor: colors.error,
        width: 70,
        height: 70,
        borderRadius: 35,
    },
    activeControl: {
        backgroundColor: colors.primary,
    },
});

export default CallManager; 