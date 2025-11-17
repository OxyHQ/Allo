/**
 * AttachmentMenu Component
 * 
 * WhatsApp-style attachment menu for selecting media and document types.
 * Displays options in a grid layout with icons and labels.
 */

import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { colors } from '@/styles/colors';
import { MediaIcon } from '@/assets/icons/media-icon';
import { LocationIcon } from '@/assets/icons/location-icon';
import { DocumentIcon } from '@/assets/icons/document-icon';
import { CameraIcon } from '@/assets/icons/camera-icon';
import { ContactIcon } from '@/assets/icons/contact-icon';
import { PollIcon } from '@/assets/icons/poll-icon';

export interface AttachmentOption {
  id: string;
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
}

export interface AttachmentMenuProps {
  onClose: () => void;
  onSelectPhoto?: () => void;
  onSelectDocument?: () => void;
  onSelectLocation?: () => void;
  onSelectCamera?: () => void;
  onSelectContact?: () => void;
  onSelectPoll?: () => void;
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
}) => {
  const theme = useTheme();

  const attachmentOptions = useMemo<AttachmentOption[]>(() => [
    {
      id: 'photo',
      label: 'Photo & Video',
      icon: <MediaIcon color={theme.colors.text} size={28} />,
      onPress: () => {
        onSelectPhoto?.();
        onClose();
      },
    },
    {
      id: 'document',
      label: 'Document',
      icon: <DocumentIcon color={theme.colors.text} size={28} />,
      onPress: () => {
        onSelectDocument?.();
        onClose();
      },
    },
    {
      id: 'location',
      label: 'Location',
      icon: <LocationIcon color={theme.colors.text} size={28} />,
      onPress: () => {
        onSelectLocation?.();
        onClose();
      },
    },
    {
      id: 'camera',
      label: 'Camera',
      icon: <CameraIcon color={theme.colors.text} size={28} />,
      onPress: () => {
        onSelectCamera?.();
        onClose();
      },
    },
    {
      id: 'contact',
      label: 'Contact',
      icon: <ContactIcon color={theme.colors.text} size={28} />,
      onPress: () => {
        onSelectContact?.();
        onClose();
      },
    },
    {
      id: 'poll',
      label: 'Poll',
      icon: <PollIcon color={theme.colors.text} size={28} />,
      onPress: () => {
        onSelectPoll?.();
        onClose();
      },
    },
  ], [
    theme.colors.text,
    onSelectPhoto,
    onSelectDocument,
    onSelectLocation,
    onSelectCamera,
    onSelectContact,
    onSelectPoll,
    onClose,
  ]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      paddingVertical: 20,
      paddingHorizontal: 16,
    },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-start',
      gap: 24,
    },
    option: {
      alignItems: 'center',
      width: 80,
    },
    iconContainer: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: theme.colors.border || colors.COLOR_BLACK_LIGHT_5,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 8,
    },
    label: {
      fontSize: 12,
      color: theme.colors.text,
      textAlign: 'center',
    },
  }), [theme.colors]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.grid}>
        {attachmentOptions.map((option) => (
          <TouchableOpacity
            key={option.id}
            style={styles.option}
            onPress={option.onPress}
            activeOpacity={0.7}
          >
            <View style={styles.iconContainer}>
              {option.icon}
            </View>
            <ThemedText style={styles.label}>{option.label}</ThemedText>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
};

