/**
 * AttachmentSheet — orchestrator for the chat attachment grid.
 *
 * Wires the visual `AttachmentMenu` to handler factories so the ConversationView
 * stays small. Each handler performs the OS-level picker / permission flow,
 * compresses media as needed, and triggers a callback with a ready-to-send
 * `AttachmentPayload`. Encryption + upload happen downstream in the messages
 * store (so media is end-to-end encrypted once before upload, Fase 1D); the
 * payload carries each item's local source URI for that purpose.
 */
import React, { useCallback } from 'react';
import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Video as Compressor, Image as ImageCompressor } from 'react-native-compressor';
import { useTranslation } from 'react-i18next';
import { AttachmentMenu } from '@/components/messages/AttachmentMenu';
import { ContactPicker } from './ContactPicker';
import { LocationPicker } from './LocationPicker';
import { GifPicker } from './GifPicker';
import { PollComposer } from './PollComposer';
import { toast } from '@/lib/sonner';
import type { OutgoingMediaSource } from '@/lib/outgoingMedia';
import type {
  AttachmentPayload,
  ContactData,
  LocationData,
  MediaItem,
  PollData,
} from '@/stores/messagesStore';

interface AttachmentSheetProps {
  onSendAttachment: (payload: AttachmentPayload) => void;
  openSubSheet: (content: React.ReactNode) => void;
  closeSheet: () => void;
}

const inferMediaTypeFromMime = (mime?: string): MediaItem['type'] => {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return mime === 'image/gif' ? 'gif' : 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
};

export const AttachmentSheet: React.FC<AttachmentSheetProps> = ({
  onSendAttachment,
  openSubSheet,
  closeSheet,
}) => {
  const { t } = useTranslation();

  const compressImage = useCallback(async (uri: string): Promise<string> => {
    try {
      const compressed = await ImageCompressor.compress(uri, {
        compressionMethod: 'auto',
        quality: 0.8,
      });
      return compressed;
    } catch (error) {
      console.warn('[AttachmentSheet] image compression failed:', error);
      return uri;
    }
  }, []);

  const compressVideo = useCallback(async (uri: string): Promise<string> => {
    try {
      const compressed = await Compressor.compress(
        uri,
        { compressionMethod: 'auto' },
        () => {}
      );
      return compressed;
    } catch (error) {
      console.warn('[AttachmentSheet] video compression failed:', error);
      return uri;
    }
  }, []);

  const handlePhoto = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        toast.error(t('chat.photoPermissionDenied'));
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsMultipleSelection: true,
        quality: 1,
        exif: false,
      });
      if (result.canceled || !result.assets?.length) return;

      const sources: OutgoingMediaSource[] = [];
      let imageCount = 0;
      let videoCount = 0;

      // Compress before handing the local source to the store, which encrypts
      // once and uploads only the ciphertext.
      const preparingToast = toast.loading(t('chat.uploadingMedia'));
      try {
        for (const asset of result.assets) {
          const mime = asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
          const isVideo = (asset.type === 'video') || (mime || '').startsWith('video/');
          const sourceUri = isVideo
            ? await compressVideo(asset.uri)
            : await compressImage(asset.uri);
          const mediaType: MediaItem['type'] = isVideo
            ? 'video'
            : mime === 'image/gif'
              ? 'gif'
              : 'image';
          sources.push({
            id: `local-${Date.now()}-${sources.length}`,
            type: mediaType,
            localUri: sourceUri,
            fileName:
              asset.fileName || (isVideo ? `video-${Date.now()}.mp4` : `image-${Date.now()}.jpg`),
            mimeType: mime,
            fileSize: asset.fileSize,
            width: asset.width,
            height: asset.height,
            duration: asset.duration ?? undefined,
          });
          if (isVideo) videoCount++;
          else imageCount++;
        }
      } finally {
        toast.dismiss(preparingToast);
      }

      if (sources.length === 0) return;
      const attachmentType: AttachmentPayload['attachmentType'] =
        videoCount > 0 && imageCount === 0 ? 'video' : 'image';
      onSendAttachment({ attachmentType, media: sources });
    } catch (error) {
      console.error('[AttachmentSheet] photo flow error:', error);
      toast.error(t('chat.uploadFailed'));
    }
  }, [t, compressImage, compressVideo, onSendAttachment]);

  const handleCamera = useCallback(async () => {
    if (Platform.OS === 'web') {
      // On web fall back to the photo library picker since camera UX differs.
      return handlePhoto();
    }
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        toast.error(t('chat.cameraPermissionDenied'));
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        quality: 1,
        exif: false,
      });
      if (result.canceled || !result.assets?.length) return;

      const asset = result.assets[0];
      const mime = asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
      const isVideo = (asset.type === 'video') || (mime || '').startsWith('video/');
      const sourceUri = isVideo
        ? await compressVideo(asset.uri)
        : await compressImage(asset.uri);
      const mediaType: MediaItem['type'] = isVideo ? 'video' : 'image';
      onSendAttachment({
        attachmentType: isVideo ? 'video' : 'image',
        media: [
          {
            id: `local-${Date.now()}`,
            type: mediaType,
            localUri: sourceUri,
            fileName:
              asset.fileName || (isVideo ? `video-${Date.now()}.mp4` : `image-${Date.now()}.jpg`),
            mimeType: mime,
            fileSize: asset.fileSize,
            width: asset.width,
            height: asset.height,
            duration: asset.duration ?? undefined,
          },
        ],
      });
    } catch (error) {
      console.error('[AttachmentSheet] camera flow error:', error);
      toast.error(t('chat.uploadFailed'));
    }
  }, [t, compressImage, compressVideo, onSendAttachment, handlePhoto]);

  const handleDocument = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      const mime = asset.mimeType || undefined;
      const mediaType = inferMediaTypeFromMime(mime);
      onSendAttachment({
        attachmentType:
          mediaType === 'audio'
            ? 'audio'
            : mediaType === 'image'
              ? 'image'
              : mediaType === 'video'
                ? 'video'
                : 'file',
        media: [
          {
            id: `local-${Date.now()}`,
            type: mediaType,
            localUri: asset.uri,
            fileName: asset.name,
            mimeType: mime,
            fileSize: asset.size ?? undefined,
          },
        ],
      });
    } catch (error) {
      console.error('[AttachmentSheet] document flow error:', error);
      toast.error(t('chat.uploadFailed'));
    }
  }, [t, onSendAttachment]);

  const handleLocation = useCallback(() => {
    // Defer so the AttachmentMenu's onClose-after-onPress doesn't dismiss the
    // sub-sheet we're about to present.
    setTimeout(() => {
      openSubSheet(
        <LocationPicker
          onSend={(location: LocationData) =>
            onSendAttachment({ attachmentType: 'location', location })
          }
          onClose={closeSheet}
        />
      );
    }, 50);
  }, [openSubSheet, closeSheet, onSendAttachment]);

  const handleContact = useCallback(() => {
    setTimeout(() => {
      openSubSheet(
        <ContactPicker
          onSelect={(contact: ContactData) =>
            onSendAttachment({ attachmentType: 'contact', contact })
          }
          onClose={closeSheet}
        />
      );
    }, 50);
  }, [openSubSheet, closeSheet, onSendAttachment]);

  const handleGif = useCallback(() => {
    setTimeout(() => {
      openSubSheet(
        <GifPicker
          onSend={(payload: AttachmentPayload) => onSendAttachment(payload)}
          onClose={closeSheet}
        />
      );
    }, 50);
  }, [openSubSheet, closeSheet, onSendAttachment]);

  const handlePoll = useCallback(() => {
    setTimeout(() => {
      openSubSheet(
        <PollComposer
          onSubmit={(poll: PollData) =>
            onSendAttachment({ attachmentType: 'poll', poll })
          }
          onClose={closeSheet}
        />
      );
    }, 50);
  }, [openSubSheet, closeSheet, onSendAttachment]);

  return (
    <AttachmentMenu
      onClose={closeSheet}
      onSelectPhoto={handlePhoto}
      onSelectGif={handleGif}
      onSelectCamera={handleCamera}
      onSelectDocument={handleDocument}
      onSelectLocation={handleLocation}
      onSelectContact={handleContact}
      onSelectPoll={handlePoll}
    />
  );
};
