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
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { colors } from '@/styles/colors';
import { MediaIcon } from '@/assets/icons/media-icon';
import { LocationIcon } from '@/assets/icons/location-icon';
import { DocumentIcon } from '@/assets/icons/document-icon';
import { CameraIcon } from '@/assets/icons/camera-icon';
import { ProfileIcon } from '@/assets/icons/profile-icon';
import { PollIcon } from '@/assets/icons/poll-icon';

export interface AttachmentOption {
  id: string;
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  accentColor: string;
  accentBackground: string;
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
      icon: <MediaIcon color="#FF7A00" size={30} />,
      accentColor: '#FF7A00',
      accentBackground: '#FFF2E6',
      onPress: () => {
        onSelectPhoto?.();
        onClose();
      },
    },
    {
      id: 'document',
      label: 'Document',
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
      label: 'Location',
      icon: <LocationIcon color="#00B894" size={30} />,
      accentColor: '#00B894',
      accentBackground: '#E0FFF7',
      onPress: () => {
        onSelectLocation?.();
        onClose();
      },
    },
    {
      id: 'camera',
      label: 'Camera',
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
      label: 'Contact',
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
      label: 'Poll',
      icon: <PollIcon color="#FF5252" size={30} />,
      accentColor: '#FF5252',
      accentBackground: '#FFE7E7',
      onPress: () => {
        onSelectPoll?.();
        onClose();
      },
    },
  ], [
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

