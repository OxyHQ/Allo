import React, { useState, useRef, useEffect } from 'react';
import {
    View,
    StyleSheet,
    TouchableOpacity,
    StatusBar,
    Dimensions,
    Alert,
    Image,
    ScrollView,
    Animated,
    PanResponder,
    Text as RNText,
} from 'react-native';
import { CameraView, CameraType, FlashMode, useCameraPermissions } from 'expo-camera';
import { Text, IconButton, FAB } from 'react-native-paper';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { Audio } from 'expo-av';
import { useRouter } from 'expo-router';
import { colors, radius, spacingX, spacingY } from '@/constants/theme';
import * as Icons from 'phosphor-react-native';
import { useAuth } from '@/contexts/authContext';
import { uploadFileToCloudinary } from '@/services/imageService';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

type CameraMode = 'photo' | 'video';

interface MediaAsset {
    id: string;
    uri: string;
    type: 'photo' | 'video';
    creationTime: number;
    width: number;
    height: number;
    duration?: number;
}

const Camera = () => {
    const router = useRouter();
    const { user: currentUser } = useAuth();

    // Camera states
    const [hasPermission, setHasPermission] = useState<boolean | null>(null);
    const [cameraType, setCameraType] = useState<CameraType>('back');
    const [flashMode, setFlashMode] = useState<FlashMode>('off');
    const [mode, setMode] = useState<CameraMode>('photo');
    const [isRecording, setIsRecording] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [recentMedia, setRecentMedia] = useState<MediaAsset[]>([]);
    const [selectedMedia, setSelectedMedia] = useState<MediaAsset | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [zoom, setZoom] = useState(0);

    // Refs
    const cameraRef = useRef<CameraView>(null);
    const recordingInterval = useRef<ReturnType<typeof setInterval> | null>(null);
    const recordingAnimation = useRef(new Animated.Value(1)).current;
    const modeSlideAnimation = useRef(new Animated.Value(0)).current;

    // Recording animation
    useEffect(() => {
        if (isRecording) {
            recordingInterval.current = setInterval(() => {
                setRecordingTime(prev => prev + 1);
            }, 1000);

            // Pulsing animation for recording indicator
            Animated.loop(
                Animated.sequence([
                    Animated.timing(recordingAnimation, {
                        toValue: 0.3,
                        duration: 500,
                        useNativeDriver: true,
                    }),
                    Animated.timing(recordingAnimation, {
                        toValue: 1,
                        duration: 500,
                        useNativeDriver: true,
                    }),
                ])
            ).start();
        } else {
            if (recordingInterval.current) {
                clearInterval(recordingInterval.current);
            }
            setRecordingTime(0);
            recordingAnimation.setValue(1);
        }

        return () => {
            if (recordingInterval.current) {
                clearInterval(recordingInterval.current);
            }
        };
    }, [isRecording]);

    // Mode change animation
    useEffect(() => {
        Animated.timing(modeSlideAnimation, {
            toValue: mode === 'photo' ? 0 : 1,
            duration: 200,
            useNativeDriver: true,
        }).start();
    }, [mode]);

    // Request permissions and load recent media
    useEffect(() => {
        requestPermissions();
        loadRecentMedia();
    }, []);

    const requestPermissions = async () => {
        try {
            const { status: cameraStatus } = await ImagePicker.requestCameraPermissionsAsync();
            const { status: audioStatus } = await Audio.requestPermissionsAsync();
            const { status: mediaLibraryStatus } = await MediaLibrary.requestPermissionsAsync();

            setHasPermission(
                cameraStatus === 'granted' &&
                audioStatus === 'granted' &&
                mediaLibraryStatus === 'granted'
            );

            if (cameraStatus !== 'granted') {
                Alert.alert('Permission required', 'Camera permission is required to use this feature.');
            }
        } catch (error) {
            console.error('Error requesting permissions:', error);
            setHasPermission(false);
        }
    };

    const loadRecentMedia = async () => {
        try {
            const { status } = await MediaLibrary.getPermissionsAsync();
            if (status !== 'granted') return;

            const media = await MediaLibrary.getAssetsAsync({
                first: 20,
                mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
                sortBy: MediaLibrary.SortBy.creationTime,
            });

            const assets: MediaAsset[] = media.assets.map(asset => ({
                id: asset.id,
                uri: asset.uri,
                type: asset.mediaType === MediaLibrary.MediaType.photo ? 'photo' : 'video',
                creationTime: asset.creationTime,
                width: asset.width,
                height: asset.height,
                duration: asset.duration,
            }));

            setRecentMedia(assets);
        } catch (error) {
            console.error('Error loading recent media:', error);
        }
    };

    const takePicture = async () => {
        if (!cameraRef.current) return;

        try {
            setIsProcessing(true);
            const photo = await cameraRef.current.takePictureAsync({
                quality: 0.8,
                base64: false,
                exif: false,
            });

            if (photo) {
                // Save to media library
                const asset = await MediaLibrary.createAssetAsync(photo.uri);

                const newMedia: MediaAsset = {
                    id: asset.id,
                    uri: asset.uri,
                    type: 'photo',
                    creationTime: Date.now(),
                    width: photo.width,
                    height: photo.height,
                };

                setSelectedMedia(newMedia);
                setRecentMedia(prev => [newMedia, ...prev]);
            }
        } catch (error) {
            console.error('Error taking picture:', error);
            Alert.alert('Error', 'Failed to take picture. Please try again.');
        } finally {
            setIsProcessing(false);
        }
    };

    const startRecording = async () => {
        if (!cameraRef.current || isRecording) return;

        try {
            setIsRecording(true);
            const video = await cameraRef.current.recordAsync({
                maxDuration: 60, // 60 seconds max like WhatsApp
                mute: false,
            });

            if (video) {
                // Save to media library
                const asset = await MediaLibrary.createAssetAsync(video.uri);

                const newMedia: MediaAsset = {
                    id: asset.id,
                    uri: asset.uri,
                    type: 'video',
                    creationTime: Date.now(),
                    width: 0, // Will be set by video metadata
                    height: 0,
                    duration: recordingTime,
                };

                setSelectedMedia(newMedia);
                setRecentMedia(prev => [newMedia, ...prev]);
            }
        } catch (error) {
            console.error('Error recording video:', error);
            Alert.alert('Error', 'Failed to record video. Please try again.');
        } finally {
            setIsRecording(false);
        }
    };

    const stopRecording = async () => {
        if (!cameraRef.current || !isRecording) return;

        try {
            await cameraRef.current.stopRecording();
        } catch (error) {
            console.error('Error stopping recording:', error);
        }
    };

    const toggleCameraType = () => {
        setCameraType(current => (current === 'back' ? 'front' : 'back'));
    };

    const toggleFlashMode = () => {
        setFlashMode(current => {
            switch (current) {
                case 'off': return 'on';
                case 'on': return 'auto';
                case 'auto': return 'off';
                default: return 'off';
            }
        });
    };

    const toggleMode = () => {
        if (isRecording) return; // Don't allow mode change while recording
        setMode(current => current === 'photo' ? 'video' : 'photo');
    };

    const selectMediaFromGallery = async () => {
        try {
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ImagePicker.MediaTypeOptions.All,
                allowsEditing: true,
                quality: 0.8,
            });

            if (!result.canceled && result.assets[0]) {
                const asset = result.assets[0];
                const newMedia: MediaAsset = {
                    id: `gallery_${Date.now()}`,
                    uri: asset.uri,
                    type: asset.type === 'video' ? 'video' : 'photo',
                    creationTime: Date.now(),
                    width: asset.width || 0,
                    height: asset.height || 0,
                    duration: asset.duration,
                };
                setSelectedMedia(newMedia);
            }
        } catch (error) {
            console.error('Error selecting from gallery:', error);
        }
    };

    const sendMedia = async () => {
        if (!selectedMedia) return;

        try {
            setIsProcessing(true);

            // Upload to cloudinary
            const uploadResult = await uploadFileToCloudinary(
                { uri: selectedMedia.uri },
                selectedMedia.type === 'video' ? 'videos' : 'images'
            );

            if (uploadResult.success) {
                // Navigate back with the media data
                router.back();
                // TODO: Pass media data to conversation or status
                console.log('Media uploaded successfully:', uploadResult.data);
            } else {
                Alert.alert('Error', 'Failed to upload media. Please try again.');
            }
        } catch (error) {
            console.error('Error uploading media:', error);
            Alert.alert('Error', 'Failed to upload media. Please try again.');
        } finally {
            setIsProcessing(false);
        }
    };

    const formatTime = (seconds: number) => {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    };

    const getFlashIcon = () => {
        switch (flashMode) {
            case 'on': return 'lightning';
            case 'auto': return 'lightning-a';
            case 'off': return 'lightning-slash';
            default: return 'lightning-slash';
        }
    };

    // Pan responder for swipe gestures
    const panResponder = PanResponder.create({
        onMoveShouldSetPanResponder: (evt, gestureState) => {
            return Math.abs(gestureState.dx) > 20;
        },
        onPanResponderMove: (evt, gestureState) => {
            // Handle swipe to change modes
            if (gestureState.dx > 50 && mode === 'video') {
                setMode('photo');
            } else if (gestureState.dx < -50 && mode === 'photo') {
                setMode('video');
            }
        },
    });

    if (hasPermission === null) {
        return (
            <View style={styles.container}>
                <Text style={styles.permissionText}>Requesting camera permission...</Text>
            </View>
        );
    }

    if (hasPermission === false) {
        return (
            <View style={styles.container}>
                <Text style={styles.permissionText}>No access to camera</Text>
                <TouchableOpacity onPress={requestPermissions} style={styles.permissionButton}>
                    <Text style={styles.permissionButtonText}>Grant Permission</Text>
                </TouchableOpacity>
            </View>
        );
    }

    // Media preview screen
    if (selectedMedia) {
        return (
            <View style={styles.container}>
                <StatusBar barStyle="light-content" backgroundColor="black" />

                {/* Media Preview */}
                <View style={styles.mediaPreview}>
                    {selectedMedia.type === 'photo' ? (
                        <Image source={{ uri: selectedMedia.uri }} style={styles.previewImage} />
                    ) : (
                        <View style={styles.videoPreview}>
                            <Image source={{ uri: selectedMedia.uri }} style={styles.previewImage} />
                            <View style={styles.videoPlayButton}>
                                <Icons.Play color={colors.white} size={40} weight="fill" />
                            </View>
                        </View>
                    )}
                </View>

                {/* Preview Controls */}
                <View style={styles.previewControls}>
                    <TouchableOpacity
                        onPress={() => setSelectedMedia(null)}
                        style={styles.previewButton}
                    >
                        <Icons.X color={colors.white} size={24} />
                    </TouchableOpacity>

                    <TouchableOpacity
                        onPress={sendMedia}
                        style={[styles.previewButton, styles.sendButton]}
                        disabled={isProcessing}
                    >
                        {isProcessing ? (
                            <Icons.CircleNotch color={colors.white} size={24} />
                        ) : (
                            <Icons.PaperPlaneTilt color={colors.white} size={24} weight="fill" />
                        )}
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    // Main camera screen
    return (
        <View style={styles.container} {...panResponder.panHandlers}>
            <StatusBar barStyle="light-content" backgroundColor="black" />

            {/* Camera View */}
            <CameraView
                ref={cameraRef}
                style={styles.camera}
                facing={cameraType}
                flash={flashMode}
                mode={mode}
            >
                {/* Top Controls */}
                <View style={styles.topControls}>
                    <TouchableOpacity onPress={() => router.back()} style={styles.controlButton}>
                        <Icons.X color={colors.white} size={24} />
                    </TouchableOpacity>

                    <View style={styles.topRightControls}>
                        <TouchableOpacity onPress={toggleFlashMode} style={styles.controlButton}>
                            <Icons.Lightning color={colors.white} size={24} weight={flashMode === 'off' ? 'regular' : 'fill'} />
                        </TouchableOpacity>

                        <TouchableOpacity onPress={toggleCameraType} style={styles.controlButton}>
                            <Icons.CameraRotate color={colors.white} size={24} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Recording Indicator */}
                {isRecording && (
                    <View style={styles.recordingIndicator}>
                        <Animated.View style={[styles.recordingDot, { opacity: recordingAnimation }]} />
                        <Text style={styles.recordingText}>REC {formatTime(recordingTime)}</Text>
                    </View>
                )}

                {/* Mode Indicator */}
                <View style={styles.modeIndicator}>
                    <Animated.View
                        style={[
                            styles.modeSlider,
                            {
                                transform: [{
                                    translateX: modeSlideAnimation.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [0, 70],
                                    })
                                }]
                            }
                        ]}
                    />
                    <TouchableOpacity onPress={toggleMode} style={styles.modeButton}>
                        <Text style={[styles.modeText, mode === 'photo' && styles.activeModeText]}>
                            PHOTO
                        </Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={toggleMode} style={styles.modeButton}>
                        <Text style={[styles.modeText, mode === 'video' && styles.activeModeText]}>
                            VIDEO
                        </Text>
                    </TouchableOpacity>
                </View>

                {/* Bottom Controls */}
                <View style={styles.bottomControls}>
                    {/* Recent Media Strip */}
                    <View style={styles.recentMediaContainer}>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                            <TouchableOpacity
                                onPress={selectMediaFromGallery}
                                style={styles.galleryButton}
                            >
                                <Icons.Images color={colors.white} size={20} />
                            </TouchableOpacity>

                            {recentMedia.slice(0, 5).map((media) => (
                                <TouchableOpacity
                                    key={media.id}
                                    onPress={() => setSelectedMedia(media)}
                                    style={styles.recentMediaItem}
                                >
                                    <Image source={{ uri: media.uri }} style={styles.recentMediaImage} />
                                    {media.type === 'video' && (
                                        <View style={styles.videoIndicator}>
                                            <Icons.Play color={colors.white} size={12} weight="fill" />
                                        </View>
                                    )}
                                </TouchableOpacity>
                            ))}
                        </ScrollView>
                    </View>

                    {/* Capture Controls */}
                    <View style={styles.captureControls}>
                        <View style={styles.captureButtonContainer}>
                            {mode === 'photo' ? (
                                <TouchableOpacity
                                    onPress={takePicture}
                                    style={[styles.captureButton, isProcessing && styles.captureButtonDisabled]}
                                    disabled={isProcessing}
                                >
                                    <View style={styles.captureButtonInner} />
                                </TouchableOpacity>
                            ) : (
                                <TouchableOpacity
                                    onPressIn={startRecording}
                                    onPressOut={stopRecording}
                                    style={[
                                        styles.captureButton,
                                        styles.videoCaptureButton,
                                        isRecording && styles.recordingCaptureButton
                                    ]}
                                >
                                    <View style={[
                                        styles.captureButtonInner,
                                        isRecording && styles.recordingCaptureButtonInner
                                    ]} />
                                </TouchableOpacity>
                            )}
                        </View>
                    </View>
                </View>
            </CameraView>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'black',
    },
    camera: {
        flex: 1,
    },
    permissionText: {
        color: colors.white,
        fontSize: 16,
        textAlign: 'center',
        marginTop: 100,
    },
    permissionButton: {
        backgroundColor: colors.alloGreen,
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 20,
        marginTop: 20,
        alignSelf: 'center',
    },
    permissionButtonText: {
        color: colors.white,
        fontSize: 16,
        fontWeight: '600',
    },
    topControls: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingTop: 50,
        paddingHorizontal: 20,
    },
    topRightControls: {
        flexDirection: 'row',
        gap: 15,
    },
    controlButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    recordingIndicator: {
        position: 'absolute',
        top: 100,
        left: 20,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    recordingDot: {
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: colors.rose,
    },
    recordingText: {
        color: colors.white,
        fontSize: 16,
        fontWeight: '600',
    },
    modeIndicator: {
        position: 'absolute',
        bottom: 150,
        alignSelf: 'center',
        flexDirection: 'row',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        borderRadius: 20,
        padding: 4,
    },
    modeSlider: {
        position: 'absolute',
        top: 4,
        left: 4,
        width: 66,
        height: 32,
        backgroundColor: colors.white,
        borderRadius: 16,
    },
    modeButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 16,
        minWidth: 66,
        alignItems: 'center',
    },
    modeText: {
        color: colors.white,
        fontSize: 12,
        fontWeight: '600',
    },
    activeModeText: {
        color: colors.black,
    },
    bottomControls: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        paddingBottom: 40,
    },
    recentMediaContainer: {
        paddingHorizontal: 20,
        marginBottom: 20,
    },
    galleryButton: {
        width: 40,
        height: 40,
        borderRadius: 8,
        backgroundColor: 'rgba(255, 255, 255, 0.2)',
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 10,
    },
    recentMediaItem: {
        width: 40,
        height: 40,
        borderRadius: 8,
        marginRight: 10,
        position: 'relative',
    },
    recentMediaImage: {
        width: '100%',
        height: '100%',
        borderRadius: 8,
    },
    videoIndicator: {
        position: 'absolute',
        bottom: 2,
        right: 2,
        width: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    captureControls: {
        alignItems: 'center',
    },
    captureButtonContainer: {
        alignItems: 'center',
    },
    captureButton: {
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: 'rgba(255, 255, 255, 0.3)',
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 4,
        borderColor: colors.white,
    },
    captureButtonDisabled: {
        opacity: 0.5,
    },
    captureButtonInner: {
        width: 60,
        height: 60,
        borderRadius: 30,
        backgroundColor: colors.white,
    },
    videoCaptureButton: {
        borderColor: colors.rose,
    },
    recordingCaptureButton: {
        backgroundColor: 'rgba(239, 68, 68, 0.3)',
    },
    recordingCaptureButtonInner: {
        width: 40,
        height: 40,
        borderRadius: 8,
        backgroundColor: colors.rose,
    },
    // Media preview styles
    mediaPreview: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    previewImage: {
        width: screenWidth,
        height: screenHeight,
        resizeMode: 'contain',
    },
    videoPreview: {
        width: screenWidth,
        height: screenHeight,
        justifyContent: 'center',
        alignItems: 'center',
    },
    videoPlayButton: {
        position: 'absolute',
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    previewControls: {
        position: 'absolute',
        bottom: 40,
        left: 20,
        right: 20,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    previewButton: {
        width: 50,
        height: 50,
        borderRadius: 25,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    sendButton: {
        backgroundColor: colors.alloGreen,
    },
});

export default Camera; 