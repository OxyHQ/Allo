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
import { WebRTCService, SignalingData } from '@/services/webrtcService';
import { RTCView, MediaStream } from 'react-native-webrtc';

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
    const webRTCService = useRef<WebRTCService | null>(null);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);


    // Initialize WebRTCService
    useEffect(() => {
        if (!webRTCService.current) {
            webRTCService.current = new WebRTCService({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], // Example STUN server
            });

            webRTCService.current.setCallbacks({
                onSignalingData: handleSignalingData,
                onRemoteStream: handleRemoteStream,
                onConnectionStateChange: handleConnectionStateChange,
            });
        }

        return () => {
            webRTCService.current?.cleanup();
        };
    }, []);


    // Initialize call state from props or context
    useEffect(() => {
        if (visible && initiateCall) {
            setCallState({
                isActive: true,
                callId: `call_${Date.now()}`, // Generate a unique call ID
                caller: {
                    id: initiateCall.callerId,
                    name: initiateCall.callerName,
                    avatar: conversationAvatar || '',
                },
                callType: initiateCall.callType,
                status: 'outgoing',
                conversationId: conversationId || '',
            });
            // Initialize and create offer when initiating a call
            initializeAndCreateOffer(initiateCall.callerId, conversationId || '', initiateCall.callType);

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


    // WebRTC Callbacks
    const handleSignalingData = (data: SignalingData) => {
        if (!callState.callId || !callState.caller?.id) return;
        // Send signaling data to the other user via your signaling server (e.g., Socket.IO)
        console.log('Sending signaling data:', data);
        webrtcSignal({
            ...data,
            callId: callState.callId,
            to: callState.caller?.id, // Send to the other user in the call
        });
    };

    const handleRemoteStream = (stream: MediaStream) => {
        console.log('Received remote stream');
        setRemoteStream(stream);
    };

    const handleConnectionStateChange = (state: string) => {
        console.log('Connection state changed:', state);
        if (state === 'connected') {
            setCallState(prev => ({ ...prev, status: 'connected' }));
        } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
            handleEndCall();
        }
    };


    // Initialize and create offer
    const initializeAndCreateOffer = async (targetUserId: string, convId: string, callType: 'audio' | 'video') => {
        if (!webRTCService.current || !user) return;
        try {
            await webRTCService.current.initializePeerConnection(callState.callId!, targetUserId);
            const stream = await webRTCService.current.getLocalStream({
                audio: true,
                video: callType === 'video',
            });
            if (stream) {
                setLocalStream(stream);
                await webRTCService.current.addLocalStream(stream);
            }
            await webRTCService.current.createOffer(callState.callId!, targetUserId);
        } catch (error) {
            console.error('Error initializing and creating offer:', error);
            Alert.alert('Error', 'Failed to initiate call');
            handleEndCall();
        }
    };


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
        if (!webRTCService.current || !callState.callId || !callState.conversationId || !callState.caller?.id || !user) return;
        try {
            // Emit answer call event via socket
            answerCall({
                callId: callState.callId,
                conversationId: callState.conversationId,
                answer: 'accept',
                to: callState.caller.id, // Send to the caller
            });

            // Initialize peer connection
            await webRTCService.current.initializePeerConnection(callState.callId, callState.caller.id);

            // Get local stream
            const stream = await webRTCService.current.getLocalStream({
                audio: true,
                video: callState.callType === 'video',
            });
            if (stream) {
                setLocalStream(stream);
                await webRTCService.current.addLocalStream(stream);
            }

            // The offer should have been received via signaling before accepting the call
            // If an offer is stored, handle it. Otherwise, wait for it.
            // For simplicity, we assume the offer is received and handled via handleIncomingWebrtcSignal
            // before this function is called or shortly after.

            // Update call state
            // The status will be updated to 'connected' by handleConnectionStateChange callback

        } catch (error) {
            console.error('Error accepting call:', error);
            Alert.alert('Error', 'Failed to accept call');
            handleEndCall(); // Ensure call is ended on error
        }
    };

    const handleDeclineCall = async () => {
        try {
            if (!callState.callId || !callState.conversationId || !callState.caller?.id) return;

            // Emit answer call event
            answerCall({
                callId: callState.callId,
                conversationId: callState.conversationId,
                answer: 'decline',
                to: callState.caller.id, // Send to the caller
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

    const handleToggleMute = async () => {
        if (webRTCService.current) {
            const newMutedState = await webRTCService.current.toggleAudio();
            setIsMuted(!newMutedState); // Correctly update based on actual track state
        }
    };

    const handleToggleVideo = async () => {
        if (webRTCService.current) {
            const newVideoState = await webRTCService.current.toggleVideo();
            setIsVideoEnabled(newVideoState); // Correctly update based on actual track state
        }
    };

    const handleToggleSpeaker = () => {
        setIsSpeakerEnabled(!isSpeakerEnabled);
        // Here you would switch between speaker and earpiece
        // This typically involves using a library like react-native-incall-manager
        console.log('Toggling speaker:', !isSpeakerEnabled);
    };

    const handleSwitchCamera = () => {
        // Here you would switch between front and back camera
        console.log('Switching camera');
        // webRTCService.current?.switchCamera(); // Assuming WebRTCService has switchCamera
    };

    // Handle incoming WebRTC signals
    useEffect(() => {
        const handleIncomingWebrtcSignal = async (payload: any) => {
            if (!webRTCService.current || !callState.callId || !user ) return;
            console.log('Received webrtc signal:', payload);

            // Ensure the signal is for the current call
            if (payload.callId !== callState.callId) {
                console.warn('Received signal for a different call.');
                return;
            }

            // Ensure the signal is not from self
            if (payload.from === user.id) {
                console.warn('Received signal from self.');
                return;
            }


            try {
                switch (payload.type) {
                    case 'offer':
                        // This typically happens when the current user is receiving a call
                        // Initialize peer connection if not already done (e.g. if call was accepted before offer arrived)
                        if (!webRTCService.current.peerConnection) {
                             await webRTCService.current.initializePeerConnection(callState.callId, payload.from);
                        }
                        await webRTCService.current.handleOffer(payload.data, callState.callId, payload.from);
                        break;
                    case 'answer':
                        await webRTCService.current.handleAnswer(payload.data);
                        break;
                    case 'ice-candidate':
                        await webRTCService.current.handleIceCandidate(payload.data);
                        break;
                    default:
                        console.warn('Unknown WebRTC signal type:', payload.type);
                }
            } catch (error) {
                console.error('Error handling incoming WebRTC signal:', error);
            }
        };

        webrtcSignal(handleIncomingWebrtcSignal); // Register listener

        return () => {
            webrtcSignal(handleIncomingWebrtcSignal, true); // Unregister listener
        };
    }, [callState.callId, user]);


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
                            {/* Remote video stream */}
                            {remoteStream && isVideoEnabled ? (
                                <RTCView
                                    streamURL={remoteStream.toURL()}
                                    style={styles.remoteVideoContainer}
                                    objectFit="cover"
                                    mirror={false}
                                />
                            ) : (
                                <View style={styles.remoteVideoContainer}>
                                    <Avatar size={80} uri={callState.caller?.avatar || null} />
                                    <Text style={[{ color: colors.white, fontSize: 16 }, styles.videoPlaceholder]}>
                                        {isVideoEnabled ? 'Connecting video...' : `${callState.caller?.name}'s camera is off`}
                                    </Text>
                                </View>
                            )}

                            {/* Local video stream */}
                            {localStream && isVideoEnabled && (
                                <RTCView
                                    streamURL={localStream.toURL()}
                                    style={styles.localVideoContainer}
                                    objectFit="cover"
                                    mirror={true} // Usually mirror local video
                                />
                            )}
                             {!isVideoEnabled && localStream && ( // Show avatar if local camera is off but stream exists
                                <View style={[styles.localVideoContainer, styles.localVideoPlaceholder]}>
                                     <Icons.User size={24} color={colors.white} weight="fill" />
                                </View>
                            )}
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
                                    <Icons.VideoCamera size={24} color={colors.white} weight={!isVideoEnabled ? "fill" : "regular"} />
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