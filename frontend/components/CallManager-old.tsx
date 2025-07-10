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
import { Audio } from 'expo-av';
import { Camera, CameraView } from 'expo-camera';
import * as Icons from 'phosphor-react-native';
import { colors, radius, spacingX, spacingY } from '@/constants/theme';
import { Text } from 'react-native-paper';
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

// WebRTC types
interface WebRTCOffer {
    type: 'offer';
    sdp: string;
}

interface WebRTCAnswer {
    type: 'answer';
    sdp: string;
}

interface ICECandidate {
    candidate: string;
    sdpMLineIndex: number;
    sdpMid: string;
}

const { width, height } = Dimensions.get('window');

interface CallState {
    callId?: string;
    conversationId?: string;
    callType?: 'audio' | 'video';
    status: 'idle' | 'incoming' | 'outgoing' | 'connecting' | 'connected' | 'ended';
    caller?: {
        id: string;
        name: string;
        avatar?: string;
    };
    startTime?: Date;
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
    initiateCall: initiateCallData
}) => {
    const { user: currentUser } = useAuth();
    const [callState, setCallState] = useState<CallState>({ status: 'idle' });
    const [isAudioEnabled, setIsAudioEnabled] = useState(true);
    const [isVideoEnabled, setIsVideoEnabled] = useState(true);
    const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(false);
    const [callDuration, setCallDuration] = useState(0);
    const [audioRecording, setAudioRecording] = useState<Audio.Recording | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [isCallEnded, setIsCallEnded] = useState(false);

    // Camera and WebRTC states
    const [hasAudioPermission, setHasAudioPermission] = useState(false);
    const [hasCameraPermission, setHasCameraPermission] = useState(false);
    const [isInitiator, setIsInitiator] = useState(false);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
    const [otherParticipantId, setOtherParticipantId] = useState<string>('');

    // WebRTC refs
    const webrtcService = useRef<WebRTCService | null>(null);
    const localVideoRef = useRef<any>(null);
    const remoteVideoRef = useRef<any>(null);
    const audioPlaybackRef = useRef<Audio.Sound | null>(null);
    const ringtoneSoundRef = useRef<Audio.Sound | null>(null);

    // WebRTC configuration
    const rtcConfiguration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
    };

    // Request permissions on mount
    useEffect(() => {
        requestPermissions();
    }, []);

    const requestPermissions = async () => {
        try {
            // Request audio permission
            const audioStatus = await Audio.requestPermissionsAsync();
            setHasAudioPermission(audioStatus.status === 'granted');

            // Request camera permission for video calls
            const cameraStatus = await Camera.requestCameraPermissionsAsync();
            setHasCameraPermission(cameraStatus.status === 'granted');

            if (audioStatus.status !== 'granted') {
                Alert.alert('Permission required', 'Please grant microphone permission for calls.');
            }

            if (cameraStatus.status !== 'granted') {
                Alert.alert('Permission required', 'Please grant camera permission for video calls.');
            }
        } catch (error) {
            console.error('Error requesting permissions:', error);
        }
    };

    // Initialize WebRTC peer connection
    const initializePeerConnection = async () => {
        try {
            // Initialize WebRTC service
            webrtcService.current = new WebRTCService(rtcConfiguration);

            // Set up callbacks
            webrtcService.current.setCallbacks({
                onSignalingData: (data: SignalingData) => {
                    webrtcSignal({
                        callId: data.callId,
                        signal: data.data,
                        to: data.to,
                    });
                },
                onRemoteStream: (stream: MediaStream) => {
                    console.log('Received remote stream');
                    setRemoteStream(stream);
                },
                onConnectionStateChange: (state: RTCPeerConnectionState) => {
                    console.log('Connection state:', state);

                    if (state === 'connected') {
                        setIsConnected(true);
                        setCallState(prev => ({ ...prev, status: 'connected', startTime: new Date() }));
                    } else if (state === 'disconnected' || state === 'failed') {
                        handleCallEnd();
                    }
                },
            });

            // Initialize peer connection with target user
            if (callState.callId && otherParticipantId) {
                await webrtcService.current.initializePeerConnection(callState.callId, otherParticipantId);
            }

            // Get local media stream
            const stream = await getLocalMediaStream();
            if (stream) {
                setLocalStream(stream);
                await webrtcService.current.addLocalStream(stream);
            }

        } catch (error) {
            console.error('Error initializing peer connection:', error);
            Alert.alert('Call Error', 'Failed to initialize call. Please try again.');
        }
    };

    const getLocalMediaStream = async (): Promise<MediaStream | null> => {
        try {
            const constraints = {
                audio: hasAudioPermission,
                video: callState.callType === 'video' && hasCameraPermission ? {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: 'user',
                } : false,
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            return stream;
        } catch (error) {
            console.error('Error getting local media stream:', error);
            Alert.alert('Media Error', 'Failed to access camera/microphone. Please check permissions.');
            return null;
        }
    };

    // Socket event handlers
    useEffect(() => {
        const handleCallInitiated = (data: any) => {
            console.log('Call initiated:', data);
            setCallState({
                callId: data.callId,
                conversationId: data.conversationId,
                callType: data.callType,
                status: 'outgoing',
                caller: data.caller,
            });
            setOtherParticipantId(data.calleeId);
            setIsInitiator(true);
        };

        const handleCallAnswered = (data: any) => {
            console.log('Call answered:', data);
            setCallState(prev => ({ ...prev, status: 'connecting' }));
            initializePeerConnection();
        };

        const handleCallEnded = (data: any) => {
            console.log('Call ended:', data);
            handleCallEnd();
        };

        const handleWebRTCSignal = (data: any) => {
            console.log('WebRTC signal received:', data);
            if (webrtcService.current) {
                handleWebRTCSignaling(data);
            }
        };

        // Set up socket listeners
        // Note: In a real implementation, you'd set up actual socket listeners here
        // socket.on('callInitiated', handleCallInitiated);
        // socket.on('callAnswered', handleCallAnswered);
        // socket.on('callEnded', handleCallEnded);
        // socket.on('webrtcSignal', handleWebRTCSignal);

        return () => {
            // Clean up socket listeners
            // socket.off('callInitiated', handleCallInitiated);
            // socket.off('callAnswered', handleCallAnswered);
            // socket.off('callEnded', handleCallEnded);
            // socket.off('webrtcSignal', handleWebRTCSignal);
        };
    }, []);

    const createAndSendOffer = async (callId: string) => {
        if (webrtcService.current) {
            try {
                const offer = await webrtcService.current.createOffer();
                // Send offer through socket
                webrtcSignal({ callId, signal: offer, to: otherParticipantId });
            } catch (error) {
                console.error('Error creating offer:', error);
            }
        }
    };

    const handleWebRTCSignaling = async (data: any) => {
        if (!webrtcService.current) return;

        try {
            const { signal } = data;

            if (signal.type === 'offer') {
                await webrtcService.current.handleOffer(signal);
                const answer = await webrtcService.current.createAnswer();
                webrtcSignal({ callId: data.callId, signal: answer, to: data.from });
            } else if (signal.type === 'answer') {
                await webrtcService.current.handleAnswer(signal);
            } else if (signal.candidate) {
                await webrtcService.current.handleICECandidate(signal);
            }
        } catch (error) {
            console.error('Error handling WebRTC signaling:', error);
        }
    };

    // Audio setup
    useEffect(() => {
        const setupAudio = async () => {
            try {
                await Audio.setAudioModeAsync({
                    allowsRecordingIOS: true,
                    playsInSilentModeIOS: true,
                    shouldDuckAndroid: true,
                    playThroughEarpieceAndroid: !isSpeakerEnabled,
                });

                // Load ringtone sound
                const { sound } = await Audio.Sound.createAsync(
                    require('../assets/sounds/ringtone.mp3'),
                    { isLooping: true }
                );
                ringtoneSoundRef.current = sound;
            } catch (error) {
                console.error('Error setting up audio:', error);
            }
        };

        if (visible) {
            setupAudio();
        }

        return () => {
            // Clean up audio
            if (ringtoneSoundRef.current) {
                ringtoneSoundRef.current.unloadAsync();
            }
        };
    }, [visible, isSpeakerEnabled]);

    // Call duration timer
    useEffect(() => {
        let interval: NodeJS.Timeout;

        if (callState.status === 'connected' && callState.startTime) {
            interval = setInterval(() => {
                const now = new Date();
                const duration = Math.floor((now.getTime() - callState.startTime!.getTime()) / 1000);
                setCallDuration(duration);
            }, 1000);
        }

        return () => {
            if (interval) {
                clearInterval(interval);
            }
        };
    }, [callState.status, callState.startTime]);

    // Call functions
    const acceptCall = async () => {
        try {
            setCallState(prev => ({ ...prev, status: 'connecting' }));

            // Stop ringtone
            if (ringtoneSoundRef.current) {
                await ringtoneSoundRef.current.stopAsync();
            }

            // Initialize peer connection
            await initializePeerConnection();

            // Send call answered event
            answerCall({ callId: callState.callId! });
        } catch (error) {
            console.error('Error accepting call:', error);
            Alert.alert('Call Error', 'Failed to accept call. Please try again.');
        }
    };

    const declineCall = () => {
        if (ringtoneSoundRef.current) {
            ringtoneSoundRef.current.stopAsync();
        }

        endCall({ callId: callState.callId! });
        handleCallEnd();
    };

    const handleCallEnd = () => {
        // Clean up WebRTC
        if (webrtcService.current) {
            webrtcService.current.cleanup();
            webrtcService.current = null;
        }

        // Clean up media streams
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            setLocalStream(null);
        }

        if (remoteStream) {
            remoteStream.getTracks().forEach(track => track.stop());
            setRemoteStream(null);
        }

        // Stop ringtone
        if (ringtoneSoundRef.current) {
            ringtoneSoundRef.current.stopAsync();
        }

        setCallState({ status: 'ended' });
        setIsConnected(false);
        setIsCallEnded(true);

        // Close call manager after a delay
        setTimeout(() => {
            onClose({ duration: formatDuration(callDuration), callType: callState.callType });
        }, 2000);
    };

    const endCallHandler = () => {
        endCall({ callId: callState.callId! });
        handleCallEnd();
    };

    // Control functions
    const toggleAudio = async () => {
        setIsAudioEnabled(!isAudioEnabled);

        if (localStream) {
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !isAudioEnabled;
            }
        }
    };

    const toggleVideo = async () => {
        setIsVideoEnabled(!isVideoEnabled);

        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !isVideoEnabled;
            }
        }
    };

    const toggleSpeaker = async () => {
        setIsSpeakerEnabled(!isSpeakerEnabled);

        try {
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: true,
                playsInSilentModeIOS: true,
                shouldDuckAndroid: true,
                playThroughEarpieceAndroid: isSpeakerEnabled, // Toggle speaker
            });
        } catch (error) {
            console.error('Error toggling speaker:', error);
        }
    };

    // Utility functions
    const formatDuration = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    // Render functions
    const renderIncomingCall = () => (
        <View style={styles.container}>
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

            <View style={styles.callActions}>
                <TouchableOpacity style={[styles.callButton, styles.declineButton]} onPress={declineCall}>
                    <Icons.PhoneX color={colors.white} size={28} weight="fill" />
                </TouchableOpacity>

                <TouchableOpacity style={[styles.callButton, styles.acceptButton]} onPress={acceptCall}>
                    <Icons.Phone color={colors.white} size={28} weight="fill" />
                </TouchableOpacity>
            </View>
        </View>
    );

    const renderOutgoingCall = () => (
        <View style={styles.container}>
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

            <View style={styles.callActions}>
                <TouchableOpacity
                    style={[styles.callButton, styles.endButton]}
                    onPress={endCallHandler}
                    activeOpacity={0.8}
                >
                    <Icons.PhoneX color={colors.white} size={28} weight="fill" />
                </TouchableOpacity>
            </View>
        </View>
    );

    const renderActiveCall = () => (
        <View style={styles.container}>
            <View style={styles.callHeader}>
                <Text style={{ color: colors.white, fontSize: 16, fontWeight: '500' }}>
                    {callState.caller?.name}
                </Text>
                <Text style={[{ color: colors.white, fontSize: 14 }, styles.duration]}>
                    {formatDuration(callDuration)}
                </Text>
            </View>

            {callState.callType === 'video' && (
                <View style={styles.videoContainer}>
                    {/* Remote Video Stream */}
                    <View style={styles.remoteVideo}>
                        {remoteStream && isVideoEnabled ? (
                            <View style={styles.videoStreamContainer}>
                                {/* In a real implementation, you'd render the remote video stream here */}
                                <View style={styles.videoStreamPlaceholder}>
                                    <Icons.VideoCamera size={40} color={colors.white} weight="fill" />
                                    <Text style={[{ color: colors.white, fontSize: 16 }, styles.videoPlaceholder]}>
                                        {callState.caller?.name} video
                                    </Text>
                                    <Text style={[{ color: colors.white, fontSize: 12 }, styles.videoStatus]}>
                                        Connected
                                    </Text>
                                </View>
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

                    {/* Local Video Stream */}
                    <View style={styles.localVideo}>
                        {isVideoEnabled && hasCameraPermission ? (
                            <CameraView
                                style={styles.localVideoCamera}
                                facing="front"
                                ref={localVideoRef}
                            />
                        ) : (
                            <View style={styles.localVideoOff}>
                                <Icons.VideoCameraSlash size={20} color={colors.white} weight="fill" />
                            </View>
                        )}
                    </View>
                </View>
            )}

            {callState.callType === 'audio' && (
                <View style={styles.audioCallContainer}>
                    <Avatar size={120} uri={callState.caller?.avatar || null} />
                    <Text style={[{ color: colors.white, fontSize: 20, fontWeight: '600' }, styles.callerName]}>
                        {callState.caller?.name}
                    </Text>
                    <Text style={[{ color: colors.white, fontSize: 16 }, styles.audioStatus]}>
                        {isConnected ? 'Connected' : 'Connecting...'}
                    </Text>
                </View>
            )}

            <View style={styles.activeCallControls}>
                <TouchableOpacity
                    style={[styles.controlButton, !isAudioEnabled && styles.controlButtonDisabled]}
                    onPress={toggleAudio}
                >
                    <Icons.Microphone color={colors.white} size={24} weight={isAudioEnabled ? "fill" : "regular"} />
                </TouchableOpacity>

                <TouchableOpacity
                    style={[styles.controlButton, isSpeakerEnabled && styles.controlButtonActive]}
                    onPress={toggleSpeaker}
                >
                    <Icons.SpeakerHigh color={colors.white} size={24} weight={isSpeakerEnabled ? "fill" : "regular"} />
                </TouchableOpacity>

                {callState.callType === 'video' && (
                    <TouchableOpacity
                        style={[styles.controlButton, !isVideoEnabled && styles.controlButtonDisabled]}
                        onPress={toggleVideo}
                    >
                        <Icons.VideoCamera color={colors.white} size={24} weight={isVideoEnabled ? "fill" : "regular"} />
                    </TouchableOpacity>
                )}

                <TouchableOpacity style={[styles.callButton, styles.endButton]} onPress={endCallHandler}>
                    <Icons.PhoneX color={colors.white} size={28} weight="fill" />
                </TouchableOpacity>
            </View>
        </View>
    );

    const renderCallEnded = () => (
        <View style={styles.container}>
            <View style={styles.callerInfo}>
                <Avatar size={120} uri={callState.caller?.avatar || null} />
                <Text style={[{ color: colors.white, fontSize: 24, fontWeight: '600' }, styles.callerName]}>
                    {callState.caller?.name}
                </Text>
                <Text style={[{ color: colors.white, fontSize: 16 }, styles.callStatus]}>
                    Call ended
                </Text>
            </View>
        </View>
    );

    return (
        <>
            {callState.status === 'incoming' && renderIncomingCall()}
            {callState.status === 'outgoing' && renderOutgoingCall()}
            {(callState.status === 'connecting' || callState.status === 'connected') && renderActiveCall()}
            {callState.status === 'ended' && renderCallEnded()}
        </>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.95)',
        justifyContent: 'space-between',
        paddingTop: 60,
        paddingBottom: 60,
        paddingHorizontal: spacingX._20,
        zIndex: 1000,
    },
    callHeader: {
        alignItems: 'center',
        paddingVertical: spacingY._20,
    },
    callerInfo: {
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
    },
    callerName: {
        marginTop: spacingY._16,
        textAlign: 'center',
    },
    callStatus: {
        marginTop: spacingY._8,
        textAlign: 'center',
        opacity: 0.8,
    },
    duration: {
        marginTop: spacingY._4,
        textAlign: 'center',
        opacity: 0.8,
    },
    callActions: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingHorizontal: spacingX._40,
    },
    callButton: {
        width: 70,
        height: 70,
        borderRadius: 35,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 5,
        shadowColor: colors.black,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 3.84,
    },
    acceptButton: {
        backgroundColor: colors.success,
    },
    declineButton: {
        backgroundColor: colors.error,
    },
    endButton: {
        backgroundColor: colors.error,
    },
    activeCallControls: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingHorizontal: spacingX._20,
    },
    controlButton: {
        width: 50,
        height: 50,
        borderRadius: 25,
        backgroundColor: 'rgba(255, 255, 255, 0.2)',
        justifyContent: 'center',
        alignItems: 'center',
        marginHorizontal: spacingX._8,
    },
    controlButtonActive: {
        backgroundColor: colors.alloGreen,
    },
    controlButtonDisabled: {
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        opacity: 0.5,
    },
    videoContainer: {
        flex: 1,
        position: 'relative',
    },
    remoteVideo: {
        flex: 1,
        backgroundColor: colors.neutral800,
        borderRadius: radius._12,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: spacingY._16,
    },
    localVideo: {
        position: 'absolute',
        top: spacingY._20,
        right: spacingX._20,
        width: 120,
        height: 160,
        borderRadius: radius._12,
        overflow: 'hidden',
        backgroundColor: colors.neutral800,
    },
    localVideoCamera: {
        flex: 1,
    },
    localVideoOff: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.neutral700,
    },
    videoStreamContainer: {
        flex: 1,
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    videoStreamPlaceholder: {
        alignItems: 'center',
    },
    videoPlaceholder: {
        marginTop: spacingY._12,
        textAlign: 'center',
    },
    videoStatus: {
        marginTop: spacingY._4,
        textAlign: 'center',
        opacity: 0.7,
    },
    audioCallContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    audioStatus: {
        marginTop: spacingY._8,
        textAlign: 'center',
        opacity: 0.8,
    },
});

export default CallManager; 