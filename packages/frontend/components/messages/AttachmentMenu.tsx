/**
 * AttachmentMenu Component
 * 
 * WhatsApp-style attachment menu for selecting media and document types.
 * Displays options in a grid layout with icons and labels.
 */

import React, { useMemo } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NetworkCapabilities } from '@allo/shared-types';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { MediaIcon } from '@/assets/icons/media-icon';
import { LocationIcon } from '@/assets/icons/location-icon';
import { DocumentIcon } from '@/assets/icons/document-icon';
import { CameraIcon } from '@/assets/icons/camera-icon';
import { ProfileIcon } from '@/assets/icons/profile-icon';
import { PollIcon } from '@/assets/icons/poll-icon';
import { GifIcon } from '@/assets/icons/gif-icon';

export interface AttachmentOption {
  id: string;
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  accentColor: string;
  accentBackground: string;
  /**
   * Capability key (interop bridge, F3.x) gating this entry. When set and the
   * conversation's network does NOT support it, the entry is hidden. Omitted for
   * entries every network supports (photo/document/camera).
   */
  requiresCapability?: keyof NetworkCapabilities;
}

export interface AttachmentMenuProps {
  onClose: () => void;
  onSelectPhoto?: () => void;
  onSelectDocument?: () => void;
  onSelectLocation?: () => void;
  onSelectCamera?: () => void;
  onSelectContact?: () => void;
  onSelectPoll?: () => void;
  onSelectGif?: () => void;
  /**
   * Capabilities of the conversation's network (interop bridge, F3.x). When
   * provided, entries whose `requiresCapability` is unsupported are hidden
   * (e.g. polls/GIFs on a network that lacks them). Omit for native Allo chats
   * (every entry shown).
   */
  capabilities?: NetworkCapabilities;
}

/**
 * AttachmentMenu Component
 * 
 * @example
 * ```tsx
 * <AttachmentMenu
 *   onClose={() => {}}
 *   onSelectPhoto={() => {}}
 *   onSelectDocument={() => {}}
 * />
 * ```
 */
export const AttachmentMenu: React.FC<AttachmentMenuProps> = ({
  onClose,
  onSelectPhoto,
  onSelectDocument,
  onSelectLocation,
  onSelectCamera,
  onSelectContact,
  onSelectPoll,
  onSelectGif,
  capabilities,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const attachmentOptions = useMemo<AttachmentOption[]>(() => {
    const options: AttachmentOption[] = [
      {
        id: 'photo',
        label: t('chat.photoAndVideo'),
        icon: <MediaIcon color="#FF7A00" size={30} />,
        accentColor: '#FF7A00',
        accentBackground: '#FFF2E6',
        onPress: () => {
          onSelectPhoto?.();
          onClose();
        },
      },
      {
        id: 'gif',
        label: t('chat.gifLabel'),
        icon: <GifIcon color="#8E44AD" size={30} />,
        accentColor: '#8E44AD',
        accentBackground: '#F3E9FB',
        requiresCapability: 'gifs',
        onPress: () => {
          onSelectGif?.();
          onClose();
        },
      },
      {
        id: 'document',
        label: t('chat.document'),
        icon: <DocumentIcon color="#5C6BC0" size={30} />,
        accentColor: '#5C6BC0',
        accentBackground: '#E9ECFF',
        onPress: () => {
          onSelectDocument?.();
          onClose();
        },
      },
      {
        id: 'location',
        label: t('chat.locationLabel'),
        icon: <LocationIcon color="#00B894" size={30} />,
        accentColor: '#00B894',
        accentBackground: '#E0FFF7',
        requiresCapability: 'location',
        onPress: () => {
          onSelectLocation?.();
          onClose();
        },
      },
      {
        id: 'camera',
        label: t('chat.cameraLabel'),
        icon: <CameraIcon color="#D84393" size={30} />,
        accentColor: '#D84393',
        accentBackground: '#FFE7F3',
        onPress: () => {
          onSelectCamera?.();
          onClose();
        },
      },
      {
        id: 'contact',
        label: t('chat.contactLabel'),
        icon: <ProfileIcon color="#0087FF" size={30} />,
        accentColor: '#0087FF',
        accentBackground: '#E3F2FF',
        onPress: () => {
          onSelectContact?.();
          onClose();
        },
      },
      {
        id: 'poll',
        label: t('chat.pollLabel'),
        icon: <PollIcon color="#FF5252" size={30} />,
        accentColor: '#FF5252',
        accentBackground: '#FFE7E7',
        requiresCapability: 'polls',
        onPress: () => {
          onSelectPoll?.();
          onClose();
        },
      },
    ];
    // Interop bridge (F3.x): drop entries the conversation's network can't carry.
    // No `capabilities` (native Allo) keeps every entry.
    if (!capabilities) return options;
    return options.filter(
      (option) => !option.requiresCapability || capabilities[option.requiresCapability]
    );
  }, [
    onSelectPhoto,
    onSelectGif,
    onSelectDocument,
    onSelectLocation,
    onSelectCamera,
    onSelectContact,
    onSelectPoll,
    onClose,
    t,
    capabilities,
  ]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      paddingVertical: 24,
      paddingHorizontal: 20,
      backgroundColor: theme.colors.background,
    },
    contentContainer: {
      paddingBottom: 12,
    },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      rowGap: 24,
    },
    option: {
      width: '30%',
      alignItems: 'center',
      gap: 8,
    },
    iconContainer: {
      width: 72,
      height: 72,
      borderRadius: 36,
      justifyContent: 'center',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.08,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    },
    label: {
      fontSize: 12,
      fontWeight: '500',
      color: theme.colors.text,
      textAlign: 'center',
    },
  }), [theme.colors]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.grid}>
        {attachmentOptions.map((option) => (
          <TouchableOpacity
            key={option.id}
            style={styles.option}
            onPress={option.onPress}
            activeOpacity={0.8}
          >
            <View style={[styles.iconContainer, { backgroundColor: option.accentBackground }]}>
              {option.icon}
            </View>
            <ThemedText style={styles.label}>{option.label}</ThemedText>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
};

