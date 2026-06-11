/**
 * StatusComposer
 *
 * Fullscreen modal that lets the user create a new Status (WhatsApp-style
 * Story). Three modes:
 *
 *   - text:   colored-background text card.
 *   - image:  pick / capture an image, optional caption.
 *   - video:  pick / capture a video, optional caption.
 *
 * Privacy is selectable via a bottom drawer with three WhatsApp-equivalent
 * modes: `all-contacts`, `except` and `only`. The list of available
 * "contacts" is approximated by unique participants of the user's existing
 * direct conversations (we don't have a universal contacts store).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Image as ImageCompressor, Video as VideoCompressor } from 'react-native-compressor';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';

import { uploadAttachment, resolveMediaUrl } from '@/utils/uploadAttachment';
import { toast } from '@/lib/sonner';
import { useTheme } from '@/hooks/useTheme';
import { useConversationsStore } from '@/stores/conversationsStore';
import {
  useStatusStore,
  CreateStatusInput,
  StatusAudience,
  StatusAudienceType,
  StatusType,
} from '@/stores/statusStore';
import Avatar from '@/components/Avatar';

const IconComponent = Ionicons as any;

const TEXT_BACKGROUNDS = [
  '#075E54',
  '#128C7E',
  '#25D366',
  '#34B7F1',
  '#5C6BC0',
  '#7E57C2',
  '#EC407A',
  '#EF5350',
  '#FF7043',
  '#FFB300',
  '#000000',
  '#2C3E50',
] as const;

const FONT_FAMILIES = [
  { id: 'default', label: 'Sans' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Mono' },
] as const;

type ComposerMode = 'choose' | 'text' | 'media';

interface Props {
  visible: boolean;
  onClose: () => void;
}

interface PendingMedia {
  type: 'image' | 'video';
  uri: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
}

interface ContactCandidate {
  id: string;
  name: string;
  avatar?: string;
  username?: string;
}

export const StatusComposer: React.FC<Props> = ({ visible, onClose }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const { oxyServices, user } = useOxy() as { oxyServices: any; user: any };

  const createStatus = useStatusStore((s) => s.createStatus);
  const conversations = useConversationsStore((s) => s.conversations);

  const [mode, setMode] = useState<ComposerMode>('choose');

  // Text mode state
  const [textValue, setTextValue] = useState('');
  const [bgIndex, setBgIndex] = useState(0);
  const [fontIndex, setFontIndex] = useState(0);

  // Media mode state
  const [pendingMedia, setPendingMedia] = useState<PendingMedia | null>(null);
  const [caption, setCaption] = useState('');

  // Audience state
  const [audience, setAudience] = useState<StatusAudience>({
    type: 'all-contacts',
    userIds: [],
  });
  const [audienceVisible, setAudienceVisible] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  const resetState = useCallback(() => {
    setMode('choose');
    setTextValue('');
    setCaption('');
    setBgIndex(0);
    setFontIndex(0);
    setPendingMedia(null);
    setAudience({ type: 'all-contacts', userIds: [] });
    setAudienceVisible(false);
    setSubmitting(false);
  }, []);

  useEffect(() => {
    if (!visible) {
      resetState();
    }
  }, [visible, resetState]);

  const contacts = useMemo<ContactCandidate[]>(() => {
    if (!user?.id) return [];
    const seen = new Set<string>();
    const list: ContactCandidate[] = [];
    for (const conv of conversations) {
      if (conv.type !== 'direct') continue;
      for (const p of conv.participants || []) {
        if (!p.id || p.id === user.id || seen.has(p.id)) continue;
        seen.add(p.id);
        const first = p.name?.first || '';
        const last = p.name?.last || '';
        const display = `${first} ${last}`.trim() || p.username || 'Unknown';
        list.push({
          id: p.id,
          name: display,
          avatar: p.avatar,
          username: p.username,
        });
      }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [conversations, user?.id]);

  const pickFromLibrary = useCallback(
    async (mediaTypes: 'image' | 'video' | 'all') => {
      try {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          toast.error(t('chat.photoPermissionDenied'));
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes:
            mediaTypes === 'image'
              ? ImagePicker.MediaTypeOptions.Images
              : mediaTypes === 'video'
              ? ImagePicker.MediaTypeOptions.Videos
              : ImagePicker.MediaTypeOptions.All,
          quality: 1,
          exif: false,
        });
        if (result.canceled || !result.assets?.length) return;
        const asset = result.assets[0];
        const mime =
          asset.mimeType ||
          (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
        const isVideo = (asset.type === 'video') || (mime || '').startsWith('video/');
        setPendingMedia({
          type: isVideo ? 'video' : 'image',
          uri: asset.uri,
          fileName: asset.fileName || undefined,
          mimeType: mime,
          size: asset.fileSize ?? undefined,
          width: asset.width,
          height: asset.height,
          duration: asset.duration ?? undefined,
        });
        setMode('media');
      } catch (error) {
        console.error('[StatusComposer] pickFromLibrary error:', error);
        toast.error(t('status.error.pickFailed'));
      }
    },
    [t]
  );

  const captureFromCamera = useCallback(async () => {
    if (Platform.OS === 'web') {
      return pickFromLibrary('all');
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
      const mime =
        asset.mimeType ||
        (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
      const isVideo = (asset.type === 'video') || (mime || '').startsWith('video/');
      setPendingMedia({
        type: isVideo ? 'video' : 'image',
        uri: asset.uri,
        fileName: asset.fileName || undefined,
        mimeType: mime,
        size: asset.fileSize ?? undefined,
        width: asset.width,
        height: asset.height,
        duration: asset.duration ?? undefined,
      });
      setMode('media');
    } catch (error) {
      console.error('[StatusComposer] captureFromCamera error:', error);
      toast.error(t('status.error.cameraFailed'));
    }
  }, [pickFromLibrary, t]);

  const publishText = useCallback(async () => {
    const trimmed = textValue.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const input: CreateStatusInput = {
        type: 'text',
        text: trimmed,
        backgroundColor: TEXT_BACKGROUNDS[bgIndex],
        fontFamily: FONT_FAMILIES[fontIndex].id,
        audience,
      };
      await createStatus(input);
      toast.success(t('status.toast.published'));
      onClose();
    } catch (error: any) {
      console.error('[StatusComposer] publishText error:', error);
      toast.error(error?.message || t('status.error.publishFailed'));
    } finally {
      setSubmitting(false);
    }
  }, [textValue, bgIndex, fontIndex, audience, createStatus, t, onClose]);

  const publishMedia = useCallback(async () => {
    if (!pendingMedia) return;
    setSubmitting(true);
    const loadingId = toast.loading(t('chat.uploadingMedia'));
    try {
      let sourceUri = pendingMedia.uri;
      try {
        if (pendingMedia.type === 'image') {
          sourceUri = await ImageCompressor.compress(pendingMedia.uri, {
            compressionMethod: 'auto',
            quality: 0.85,
          });
        } else {
          sourceUri = await VideoCompressor.compress(
            pendingMedia.uri,
            { compressionMethod: 'auto' },
            () => {}
          );
        }
      } catch (compressionError) {
        console.warn('[StatusComposer] compression failed, using original:', compressionError);
      }

      const uploaded = await uploadAttachment(
        {
          uri: sourceUri,
          name:
            pendingMedia.fileName ||
            (pendingMedia.type === 'video'
              ? `status-${Date.now()}.mp4`
              : `status-${Date.now()}.jpg`),
          type: pendingMedia.mimeType,
          size: pendingMedia.size,
          width: pendingMedia.width,
          height: pendingMedia.height,
          duration: pendingMedia.duration,
        },
        oxyServices
      );

      const mediaUrl = resolveMediaUrl(uploaded.id, oxyServices, {
        url: uploaded.url,
        variant: 'full',
      });

      if (!mediaUrl) {
        throw new Error(t('status.error.uploadFailed'));
      }

      const input: CreateStatusInput = {
        type: pendingMedia.type as StatusType,
        mediaUrl,
        mediaThumbnailUrl: uploaded.thumbnailUrl,
        caption: caption.trim() || undefined,
        audience,
      };
      await createStatus(input);
      toast.success(t('status.toast.published'));
      onClose();
    } catch (error: any) {
      console.error('[StatusComposer] publishMedia error:', error);
      toast.error(error?.message || t('status.error.publishFailed'));
    } finally {
      toast.dismiss(loadingId);
      setSubmitting(false);
    }
  }, [pendingMedia, caption, audience, oxyServices, createStatus, t, onClose]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        modal: { flex: 1, backgroundColor: '#000' },
        topBar: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingVertical: 12,
        },
        topBarTitle: {
          color: '#FFFFFF',
          fontSize: 18,
          fontWeight: '600',
        },
        iconBtn: {
          width: 40,
          height: 40,
          borderRadius: 20,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(255,255,255,0.08)',
        },
        chooseContainer: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 24,
          gap: 16,
        },
        chooseTitle: {
          color: '#FFFFFF',
          fontSize: 22,
          fontWeight: '700',
          marginBottom: 24,
          textAlign: 'center',
        },
        chooseRow: {
          flexDirection: 'row',
          gap: 12,
          flexWrap: 'wrap',
          justifyContent: 'center',
        },
        chooseBtn: {
          width: 130,
          paddingVertical: 18,
          borderRadius: 16,
          alignItems: 'center',
          backgroundColor: 'rgba(255,255,255,0.08)',
          gap: 8,
        },
        chooseBtnLabel: { color: '#FFFFFF', fontWeight: '600' },

        textCard: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 24,
        },
        textInput: {
          color: '#FFFFFF',
          fontSize: 28,
          fontWeight: '700',
          textAlign: 'center',
          minHeight: 100,
          width: '100%',
        },
        textInputSerif: { fontFamily: Platform.OS === 'ios' ? 'Times New Roman' : 'serif' },
        textInputMono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

        bottomBar: {
          paddingHorizontal: 16,
          paddingVertical: 12,
          gap: 12,
        },
        paletteRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
        },
        swatch: {
          width: 28,
          height: 28,
          borderRadius: 14,
          borderWidth: 2,
          borderColor: 'rgba(255,255,255,0.2)',
        },
        swatchActive: { borderColor: '#FFFFFF' },
        fontRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        },
        fontChip: {
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 12,
          backgroundColor: 'rgba(255,255,255,0.08)',
        },
        fontChipActive: { backgroundColor: 'rgba(255,255,255,0.25)' },
        fontChipText: { color: '#FFFFFF', fontWeight: '600' },

        actionsRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        audienceBtn: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderRadius: 24,
          backgroundColor: 'rgba(255,255,255,0.08)',
        },
        audienceBtnText: { color: '#FFFFFF', fontWeight: '600' },
        publishBtn: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 18,
          paddingVertical: 12,
          borderRadius: 24,
          backgroundColor: theme.colors.primary,
        },
        publishBtnText: { color: '#FFFFFF', fontWeight: '700' },
        publishBtnDisabled: { opacity: 0.5 },

        mediaPreview: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
        },
        mediaPreviewImage: { width: '100%', height: '85%' },
        captionInput: {
          color: '#FFFFFF',
          fontSize: 16,
          paddingHorizontal: 14,
          paddingVertical: 12,
          borderRadius: 24,
          backgroundColor: 'rgba(255,255,255,0.08)',
        },

        audienceSheet: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: theme.colors.background,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 24,
          maxHeight: '80%',
        },
        audienceTitle: {
          color: theme.colors.text,
          fontSize: 18,
          fontWeight: '700',
          marginBottom: 12,
        },
        audienceOption: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 12,
          gap: 12,
        },
        audienceOptionLabel: { flex: 1, color: theme.colors.text, fontSize: 15 },
        contactRow: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 10,
          gap: 12,
        },
        contactRowText: { flex: 1, color: theme.colors.text, fontSize: 15 },
        backdrop: {
          ...StyleSheet.absoluteFill,
          backgroundColor: 'rgba(0,0,0,0.4)',
        },
      }),
    [theme]
  );

  const audienceLabel = useMemo(() => {
    switch (audience.type) {
      case 'except':
        return audience.userIds.length
          ? t('status.audience.exceptSelected', { count: audience.userIds.length })
          : t('status.audience.except');
      case 'only':
        return audience.userIds.length
          ? t('status.audience.onlySelected', { count: audience.userIds.length })
          : t('status.audience.only');
      default:
        return t('status.audience.allContacts');
    }
  }, [audience, t]);

  const renderChoose = () => (
    <View style={styles.chooseContainer}>
      <Text style={styles.chooseTitle}>{t('status.composer.title')}</Text>
      <View style={styles.chooseRow}>
        <TouchableOpacity style={styles.chooseBtn} onPress={() => setMode('text')}>
          <IconComponent name="text" size={28} color="#FFFFFF" />
          <Text style={styles.chooseBtnLabel}>{t('status.composer.text')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.chooseBtn} onPress={() => pickFromLibrary('all')}>
          <IconComponent name="images" size={28} color="#FFFFFF" />
          <Text style={styles.chooseBtnLabel}>{t('status.composer.gallery')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.chooseBtn} onPress={captureFromCamera}>
          <IconComponent name="camera" size={28} color="#FFFFFF" />
          <Text style={styles.chooseBtnLabel}>{t('status.composer.camera')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderText = () => {
    const bg = TEXT_BACKGROUNDS[bgIndex];
    const fontExtra =
      fontIndex === 1
        ? styles.textInputSerif
        : fontIndex === 2
        ? styles.textInputMono
        : null;
    return (
      <View style={{ flex: 1, backgroundColor: bg }}>
        <View style={styles.textCard}>
          <TextInput
            style={[styles.textInput, fontExtra]}
            placeholder={t('status.composer.textPlaceholder')}
            placeholderTextColor="rgba(255,255,255,0.6)"
            multiline
            autoFocus
            maxLength={700}
            value={textValue}
            onChangeText={setTextValue}
          />
        </View>
        <View style={styles.bottomBar}>
          <View style={styles.paletteRow}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
              {TEXT_BACKGROUNDS.map((color, idx) => (
                <TouchableOpacity
                  key={color}
                  onPress={() => setBgIndex(idx)}
                  style={[styles.swatch, { backgroundColor: color }, idx === bgIndex && styles.swatchActive]}
                />
              ))}
            </ScrollView>
          </View>
          <View style={styles.fontRow}>
            {FONT_FAMILIES.map((font, idx) => (
              <TouchableOpacity
                key={font.id}
                onPress={() => setFontIndex(idx)}
                style={[styles.fontChip, idx === fontIndex && styles.fontChipActive]}
              >
                <Text style={styles.fontChipText}>{font.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.actionsRow}>
            <TouchableOpacity style={styles.audienceBtn} onPress={() => setAudienceVisible(true)}>
              <IconComponent name="people" size={16} color="#FFFFFF" />
              <Text style={styles.audienceBtnText}>{audienceLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.publishBtn, (!textValue.trim() || submitting) && styles.publishBtnDisabled]}
              disabled={!textValue.trim() || submitting}
              onPress={publishText}
            >
              {submitting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <>
                  <Text style={styles.publishBtnText}>{t('status.composer.publish')}</Text>
                  <IconComponent name="send" size={16} color="#FFFFFF" />
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  const renderMedia = () => {
    if (!pendingMedia) return null;
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <View style={styles.mediaPreview}>
          {pendingMedia.type === 'image' ? (
            <Image
              source={{ uri: pendingMedia.uri }}
              style={styles.mediaPreviewImage}
              contentFit="contain"
            />
          ) : (
            <View style={[styles.mediaPreviewImage, { alignItems: 'center', justifyContent: 'center' }]}>
              <IconComponent name="videocam" size={64} color="#FFFFFF" />
              <Text style={{ color: '#FFFFFF', marginTop: 8 }}>
                {t('status.composer.videoSelected')}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.bottomBar}>
          <TextInput
            style={styles.captionInput}
            placeholder={t('status.composer.captionPlaceholder')}
            placeholderTextColor="rgba(255,255,255,0.5)"
            value={caption}
            onChangeText={setCaption}
            maxLength={500}
          />
          <View style={styles.actionsRow}>
            <TouchableOpacity style={styles.audienceBtn} onPress={() => setAudienceVisible(true)}>
              <IconComponent name="people" size={16} color="#FFFFFF" />
              <Text style={styles.audienceBtnText}>{audienceLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.publishBtn, submitting && styles.publishBtnDisabled]}
              disabled={submitting}
              onPress={publishMedia}
            >
              {submitting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <>
                  <Text style={styles.publishBtnText}>{t('status.composer.publish')}</Text>
                  <IconComponent name="send" size={16} color="#FFFFFF" />
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  const setAudienceType = (type: StatusAudienceType) => {
    setAudience({ type, userIds: type === 'all-contacts' ? [] : audience.userIds });
  };

  const toggleContact = (id: string) => {
    setAudience((prev) => {
      const set = new Set(prev.userIds);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return { ...prev, userIds: Array.from(set) };
    });
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaView style={styles.modal} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.iconBtn} onPress={onClose}>
            <IconComponent name="close" size={22} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.topBarTitle}>{t('status.composer.title')}</Text>
          <View style={{ width: 40 }} />
        </View>

        {mode === 'choose' && renderChoose()}
        {mode === 'text' && renderText()}
        {mode === 'media' && renderMedia()}

        {audienceVisible && (
          <>
            <Pressable style={styles.backdrop} onPress={() => setAudienceVisible(false)} />
            <View style={styles.audienceSheet}>
              <Text style={styles.audienceTitle}>{t('status.audience.title')}</Text>

              {(['all-contacts', 'except', 'only'] as StatusAudienceType[]).map((type) => (
                <TouchableOpacity
                  key={type}
                  style={styles.audienceOption}
                  onPress={() => setAudienceType(type)}
                >
                  <IconComponent
                    name={
                      audience.type === type
                        ? 'radio-button-on'
                        : 'radio-button-off'
                    }
                    size={20}
                    color={theme.colors.primary}
                  />
                  <Text style={styles.audienceOptionLabel}>
                    {type === 'all-contacts'
                      ? t('status.audience.allContacts')
                      : type === 'except'
                      ? t('status.audience.except')
                      : t('status.audience.only')}
                  </Text>
                </TouchableOpacity>
              ))}

              {audience.type !== 'all-contacts' && (
                <FlatList
                  data={contacts}
                  keyExtractor={(item) => item.id}
                  style={{ maxHeight: 280 }}
                  renderItem={({ item }) => {
                    const selected = audience.userIds.includes(item.id);
                    return (
                      <TouchableOpacity
                        style={styles.contactRow}
                        onPress={() => toggleContact(item.id)}
                      >
                        <Avatar
                          size={36}
                          source={item.avatar ? { uri: item.avatar } : undefined}
                          label={item.name.charAt(0).toUpperCase()}
                        />
                        <Text style={styles.contactRowText} numberOfLines={1}>
                          {item.name}
                        </Text>
                        <IconComponent
                          name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                          size={22}
                          color={selected ? theme.colors.primary : theme.colors.textSecondary}
                        />
                      </TouchableOpacity>
                    );
                  }}
                  ListEmptyComponent={
                    <Text style={{ color: theme.colors.textSecondary, paddingVertical: 12 }}>
                      {t('status.audience.noContacts')}
                    </Text>
                  }
                />
              )}

              <TouchableOpacity
                style={[styles.publishBtn, { alignSelf: 'flex-end', marginTop: 8 }]}
                onPress={() => setAudienceVisible(false)}
              >
                <Text style={styles.publishBtnText}>{t('status.audience.done')}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
};

export default StatusComposer;
