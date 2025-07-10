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
import Typo from './Typo';
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

            // Note: In React Native, we'll need to use a different approach
            // This is a web API, for React Native we'd use react-native-webrtc
            // For now, I'll implement the structure and note this needs platform-specific code

            if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
                return await navigator.mediaDevices.getUserMedia(constraints);
            } else {
                // React Native implementation would go here
                console.log('Using React Native media access');
                return null;
            }
        } catch (error) {
            console.error('Error getting local media stream:', error);
            return null;
        }
    };

    // Call duration timer
    useEffect(() => {
        let interval: ReturnType<typeof setInterval>;
        if (callState.status === 'connected' && callState.startTime) {
            interval = setInterval(() => {
                const now = new Date();
                const diff = Math.floor((now.getTime() - callState.startTime!.getTime()) / 1000);
                setCallDuration(diff);
            }, 1000);
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [callState.status, callState.startTime]);

    // Handle outgoing call initiation
    useEffect(() => {
        if (initiateCallData && visible && callState.status === 'idle') {
            setIsCallEnded(false);
            setIsInitiator(true);

            // For outgoing calls, we'll set the other participant ID later when the call is established
            // For now, use a placeholder - in a real app, you'd get this from conversation participants
            setOtherParticipantId('other_participant_id'); // This should come from conversation data

            setCallState({
                status: 'outgoing',
                callType: initiateCallData.callType,
                conversationId: conversationId,
                caller: {
                    id: 'placeholder',
                    name: conversationName || 'Unknown',
                    avatar: conversationAvatar,
                },
            });

            // Initialize WebRTC for outgoing call
            initializePeerConnection();
        }
    }, [initiateCallData, visible, conversationName, conversationAvatar, callState.status, conversationId]);

    // Socket event handlers (removed global incoming call handling)
    useEffect(() => {
        const handleCallInitiated = (data: any) => {
            if (callState.status === 'outgoing') {
                setCallState(prev => ({
                    ...prev,
                    callId: data.callId,
                    status: 'connecting',
                }));

                // Create and send offer for outgoing calls
                createAndSendOffer(data.callId);
            }
        };

        const handleCallAnswered = (data: any) => {
            if (data.answer === 'accept') {
                setCallState(prev => ({
                    ...prev,
                    status: 'connecting',
                }));
                setIsConnected(true);
            } else {
                setCallState({ status: 'ended' });
                setTimeout(() => {
                    setCallState({ status: 'idle' });
                    onClose();
                }, 2000);
            }
        };

        const handleCallEnded = (data: any) => {
            handleCallEnd();
        };

        const handleWebRTCSignal = (data: any) => {
            handleWebRTCSignaling(data);
        };

        // Register socket event handlers (removed incomingCall)
        callInitiated(handleCallInitiated);
        callAnswered(handleCallAnswered);
        callEnded(handleCallEnded);
        webrtcSignal(handleWebRTCSignal);

        return () => {
            // Cleanup socket events (removed incomingCall)
            callInitiated(handleCallInitiated, true);
            callAnswered(handleCallAnswered, true);
            callEnded(handleCallEnded, true);
            webrtcSignal(handleWebRTCSignal, true);

            // Stop any ongoing vibration
            Vibration.cancel();
        };
    }, [onClose, callState.status]);

    // WebRTC signaling handlers
    const createAndSendOffer = async (callId: string) => {
        try {
            if (!webrtcService.current || !otherParticipantId) return;

            await webrtcService.current.createOffer(callId, otherParticipantId);
        } catch (error) {
            console.error('Error creating offer:', error);
        }
    };

    const handleWebRTCSignaling = async (data: any) => {
        try {
            if (!webrtcService.current) return;

            switch (data.signal.type) {
                case 'offer':
                    await webrtcService.current.handleOffer(data.signal, data.callId, data.from);
                    break;

                case 'answer':
                    await webrtcService.current.handleAnswer(data.signal);
                    break;

                case 'ice-candidate':
                    await webrtcService.current.handleIceCandidate(data.signal);
                    break;
            }
        } catch (error) {
            console.error('Error handling WebRTC signal:', error);
        }
    };

    // Audio setup and real call functionality
    useEffect(() => {
        const setupAudio = async () => {
            try {
                if (!hasAudioPermission) return;

                // Configure audio mode for calls
                await Audio.setAudioModeAsync({
                    allowsRecordingIOS: true,
                    playsInSilentModeIOS: true,
                    shouldDuckAndroid: true,
                    playThroughEarpieceAndroid: !isSpeakerEnabled,
                    staysActiveInBackground: true,
                });

                // Load ringtone sound
                if (!ringtoneSoundRef.current) {
                    const { sound } = await Audio.Sound.createAsync(
                        { uri: 'https://www2.cs.uic.edu/~i101/SoundFiles/BabyElephantWalk60.wav' }
                    );
                    ringtoneSoundRef.current = sound;
                }

            } catch (error) {
                console.error('Error setting up audio:', error);
            }
        };

        if (callState.status === 'connected' || callState.status === 'incoming') {
            setupAudio();
        }

        // Start ringtone for incoming calls
        if (callState.status === 'incoming' && ringtoneSoundRef.current) {
            ringtoneSoundRef.current.setIsLoopingAsync(true);
            ringtoneSoundRef.current.playAsync();
        }

        // Stop ringtone when call state changes
        if (callState.status !== 'incoming' && ringtoneSoundRef.current) {
            ringtoneSoundRef.current.stopAsync();
        }

        return () => {
            // Cleanup audio when call ends
            if (callState.status === 'ended' || callState.status === 'idle') {
                ringtoneSoundRef.current?.stopAsync();
                audioRecording?.stopAndUnloadAsync();
                audioPlaybackRef.current?.unloadAsync();
            }
        };
    }, [callState.status, isSpeakerEnabled, hasAudioPermission]);

    const acceptCall = async () => {
        Vibration.cancel();
        if (callState.callId && callState.conversationId) {
            setIsInitiator(false);
            await initializePeerConnection();

            answerCall({
                callId: callState.callId,
                conversationId: callState.conversationId,
                answer: 'accept',
            });
        }
    };

    const declineCall = () => {
        Vibration.cancel();
        if (callState.callId && callState.conversationId) {
            answerCall({
                callId: callState.callId,
                conversationId: callState.conversationId,
                answer: 'decline',
            });
        }
    };

    const handleCallEnd = () => {
        const finalDuration = callDuration > 0 ? formatDuration(callDuration) : undefined;

        // Cleanup WebRTC connections
        if (webrtcService.current) {
            webrtcService.current.cleanup();
            webrtcService.current = null;
        }

        // Reset streams
        setLocalStream(null);
        setRemoteStream(null);

        setCallState({ status: 'ended' });
        setTimeout(() => {
            setCallState({ status: 'idle' });
            onClose({
                duration: finalDuration,
                callType: callState.callType,
            });
        }, 2000);
    };

    const endCallHandler = () => {
        Vibration.cancel();
        setIsCallEnded(true);

        if (callState.conversationId) {
            if (callState.callId) {
                console.log('Ending call with callId:', callState.callId);
                endCall({
                    callId: callState.callId,
                    conversationId: callState.conversationId,
                });
            } else {
                console.log('Ending outgoing call before backend response');
            }

            handleCallEnd();
        }
    };

    const toggleAudio = async () => {
        if (!webrtcService.current) return;

        const newAudioState = !isAudioEnabled;
        webrtcService.current.toggleAudio(newAudioState);
        setIsAudioEnabled(newAudioState);
    };

    const toggleVideo = async () => {
        if (!webrtcService.current) return;

        const newVideoState = !isVideoEnabled;
        webrtcService.current.toggleVideo(newVideoState);
        setIsVideoEnabled(newVideoState);
    };

    const toggleSpeaker = async () => {
        setIsSpeakerEnabled(!isSpeakerEnabled);

        try {
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: true,
                playsInSilentModeIOS: true,
                shouldDuckAndroid: true,
                playThroughEarpieceAndroid: !isSpeakerEnabled,
                staysActiveInBackground: true,
            });
        } catch (error) {
            console.error('Error toggling speaker:', error);
        }
    };

    const formatDuration = (seconds: number) => {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    };

    if (!visible || callState.status === 'idle') {
        return null;
    }

    const renderIncomingCall = () => (
        <View style={styles.container}>
            <View style={styles.callHeader}>
                <Typo color={colors.white} size={18} fontWeight="500">
                    Incoming {callState.callType} call
                </Typo>
            </View>

            <View style={styles.callerInfo}>
                <Avatar size={120} uri={callState.caller?.avatar || null} />
                <Typo color={colors.white} size={24} fontWeight="600" style={styles.callerName}>
                    {callState.caller?.name}
                </Typo>
                <Typo color={colors.white} size={16} style={styles.callStatus}>
                    {callState.callType === 'video' ? 'Incoming video call' : 'Incoming call'}
                </Typo>
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
                <Typo color={colors.white} size={18} fontWeight="500">
                    {callState.callType === 'video' ? 'Video calling...' : 'Calling...'}
                </Typo>
            </View>

            <View style={styles.callerInfo}>
                <Avatar size={120} uri={callState.caller?.avatar || null} />
                <Typo color={colors.white} size={24} fontWeight="600" style={styles.callerName}>
                    {callState.caller?.name}
                </Typo>
                <Typo color={colors.white} size={16} style={styles.callStatus}>
                    {callState.callType === 'video' ? 'Video calling...' : 'Calling...'}
                </Typo>
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
                <Typo color={colors.white} size={16} fontWeight="500">
                    {callState.caller?.name}
                </Typo>
                <Typo color={colors.white} size={14} style={styles.duration}>
                    {formatDuration(callDuration)}
                </Typo>
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
                                    <Typo color={colors.white} size={16} style={styles.videoPlaceholder}>
                                        {callState.caller?.name} video
                                    </Typo>
                                    <Typo color={colors.white} size={12} style={styles.videoStatus}>
                                        Connected
                                    </Typo>
                                </View>
                            </View>
                        ) : (
                            <>
                                <Avatar size={80} uri={callState.caller?.avatar || null} />
                                <Typo color={colors.white} size={16} style={styles.videoPlaceholder}>
                                    {isVideoEnabled ? 'Connecting video...' : 'Camera off'}
                                </Typo>
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
                    <Typo color={colors.white} size={20} fontWeight="600" style={styles.callerName}>
                        {callState.caller?.name}
                    </Typo>
                    <Typo color={colors.white} size={16} style={styles.audioStatus}>
                        {isConnected ? 'Connected' : 'Connecting...'}
                    </Typo>
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
                <Typo color={colors.white} size={24} fontWeight="600" style={styles.callerName}>
                    {callState.caller?.name}
                </Typo>
                <Typo color={colors.white} size={16} style={styles.callStatus}>
                    Call ended
                </Typo>
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
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacingY._15,
    },
    callerName: {
        textAlign: 'center',
        marginTop: spacingY._20,
    },
    callStatus: {
        textAlign: 'center',
        opacity: 0.8,
    },
    audioStatus: {
        textAlign: 'center',
        opacity: 0.8,
        marginTop: spacingY._10,
    },
    duration: {
        opacity: 0.8,
        marginTop: spacingY._5,
    },
    callActions: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingVertical: spacingY._30,
    },
    activeCallControls: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingVertical: spacingY._30,
    },
    callButton: {
        width: 70,
        height: 70,
        borderRadius: 35,
        alignItems: 'center',
        justifyContent: 'center',
    },
    acceptButton: {
        backgroundColor: colors.alloGreen,
    },
    declineButton: {
        backgroundColor: colors.rose,
    },
    endButton: {
        backgroundColor: colors.rose,
    },
    controlButton: {
        width: 50,
        height: 50,
        borderRadius: 25,
        backgroundColor: 'rgba(255, 255, 255, 0.2)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    controlButtonActive: {
        backgroundColor: colors.alloGreen,
    },
    controlButtonDisabled: {
        backgroundColor: colors.rose,
    },
    videoContainer: {
        flex: 1,
        position: 'relative',
    },
    remoteVideo: {
        flex: 1,
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        borderRadius: radius._20,
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacingY._15,
    },
    videoStreamContainer: {
        flex: 1,
        width: '100%',
        borderRadius: radius._20,
        overflow: 'hidden',
    },
    localVideo: {
        position: 'absolute',
        top: spacingY._20,
        right: spacingX._20,
        width: 100,
        height: 140,
        backgroundColor: 'rgba(255, 255, 255, 0.2)',
        borderRadius: radius._15,
        overflow: 'hidden',
    },
    localVideoCamera: {
        flex: 1,
        width: '100%',
        height: '100%',
    },
    audioCallContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacingY._20,
    },
    videoPlaceholder: {
        opacity: 0.7,
    },
    videoStreamPlaceholder: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacingY._10,
        flex: 1,
    },
    videoStatus: {
        opacity: 0.8,
        textAlign: 'center',
    },
    localVideoOff: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: 0.6,
    },
});

export default CallManager; 