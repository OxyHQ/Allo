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
} from 'react-native';
import { CameraView, CameraType, FlashMode } from 'expo-camera';
import { Text } from 'react-native-paper';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { useRouter } from 'expo-router';
import { colors } from '@/constants/theme';
import * as Icons from 'phosphor-react-native';
import { uploadFileToCloudinary } from '@/services/imageService';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

interface MediaAsset {
    id: string;
    uri: string;
    type: 'photo' | 'video';
}

const CameraSimple = () => {
    const router = useRouter();

    // Camera states
    const [hasPermission, setHasPermission] = useState<boolean | null>(null);
    const [cameraType, setCameraType] = useState<CameraType>('back');
    const [flashMode, setFlashMode] = useState<FlashMode>('off');
    const [recentMedia, setRecentMedia] = useState<MediaAsset[]>([]);
    const [selectedMedia, setSelectedMedia] = useState<MediaAsset | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);

    // Refs
    const cameraRef = useRef<CameraView>(null);

    // Request permissions and load recent media
    useEffect(() => {
        requestPermissions();
        loadRecentMedia();
    }, []);

    const requestPermissions = async () => {
        try {
            const { status: cameraStatus } = await ImagePicker.requestCameraPermissionsAsync();
            const { status: mediaLibraryStatus } = await MediaLibrary.requestPermissionsAsync();

            setHasPermission(
                cameraStatus === 'granted' && mediaLibraryStatus === 'granted'
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
                first: 10,
                mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
                sortBy: MediaLibrary.SortBy.creationTime,
            });

            const assets: MediaAsset[] = media.assets.map(asset => ({
                id: asset.id,
                uri: asset.uri,
                type: asset.mediaType === MediaLibrary.MediaType.photo ? 'photo' : 'video',
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
            });

            if (photo) {
                // Save to media library
                const asset = await MediaLibrary.createAssetAsync(photo.uri);

                const newMedia: MediaAsset = {
                    id: asset.id,
                    uri: asset.uri,
                    type: 'photo',
                };

                setSelectedMedia(newMedia);
                setRecentMedia(prev => [newMedia, ...prev.slice(0, 9)]);
            }
        } catch (error) {
            console.error('Error taking picture:', error);
            Alert.alert('Error', 'Failed to take picture. Please try again.');
        } finally {
            setIsProcessing(false);
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
                // Navigate back with success
                router.back();
                Alert.alert('Success', 'Media uploaded successfully!');
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
                    <Image source={{ uri: selectedMedia.uri }} style={styles.previewImage} />
                    {selectedMedia.type === 'video' && (
                        <View style={styles.videoPlayButton}>
                            <Icons.Play color={colors.white} size={40} weight="fill" />
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
        <View style={styles.container}>
            <StatusBar barStyle="light-content" backgroundColor="black" />

            {/* Camera View */}
            <CameraView
                ref={cameraRef}
                style={styles.camera}
                facing={cameraType}
                flash={flashMode}
            >
                {/* Top Controls */}
                <View style={styles.topControls}>
                    <TouchableOpacity onPress={() => router.back()} style={styles.controlButton}>
                        <Icons.X color={colors.white} size={24} />
                    </TouchableOpacity>

                    <View style={styles.topRightControls}>
                        <TouchableOpacity onPress={toggleFlashMode} style={styles.controlButton}>
                            <Icons.Lightning
                                color={colors.white}
                                size={24}
                                weight={flashMode === 'off' ? 'regular' : 'fill'}
                            />
                        </TouchableOpacity>

                        <TouchableOpacity onPress={toggleCameraType} style={styles.controlButton}>
                            <Icons.CameraRotate color={colors.white} size={24} />
                        </TouchableOpacity>
                    </View>
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
                        <TouchableOpacity
                            onPress={takePicture}
                            style={[styles.captureButton, isProcessing && styles.captureButtonDisabled]}
                            disabled={isProcessing}
                        >
                            <View style={styles.captureButtonInner} />
                        </TouchableOpacity>
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

export default CameraSimple; 