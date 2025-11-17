import React, { memo, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  SafeAreaView,
  Platform,
} from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { MessageMetadata } from './MessageMetadata';
import { MessageAvatar } from './MessageAvatar';
import type { Message } from '@/stores';
import { TIME_FORMAT_OPTIONS } from '@/constants/messaging';
import { colors } from '@/styles/colors';

export interface MessageInfoScreenProps {
  visible: boolean;
  message: Message | null;
  senderName?: string;
  senderAvatar?: string;
  onClose: () => void;
}

/**
 * MessageInfoScreen Component
 * 
 * Displays detailed information about a message (like WhatsApp).
 * Shows sender info, timestamp, read status, etc.
 * 
 * @example
 * ```tsx
 * <MessageInfoScreen
 *   visible={true}
 *   message={message}
 *   senderName="John Doe"
 *   senderAvatar="https://example.com/avatar.jpg"
 *   onClose={() => setVisible(false)}
 * />
 * ```
 */
export const MessageInfoScreen = memo<MessageInfoScreenProps>(({
  visible,
  message,
  senderName,
  senderAvatar,
  onClose,
}) => {
  const theme = useTheme();

  const formattedDate = useMemo(() => {
    if (!message) return '';
    const date = message.timestamp;
    return date.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [message]);

  const styles = useMemo(() => StyleSheet.create({
    modal: {
      flex: 1,
      backgroundColor: theme.colors.background || '#FFFFFF',
    },
    container: {
      flex: 1,
    },
    scrollContent: {
      padding: 16,
    },
    section: {
      marginBottom: 32,
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.textSecondary || '#666666',
      marginBottom: 12,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    infoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border || '#E5E5E5',
    },
    infoRowLast: {
      borderBottomWidth: 0,
    },
    infoLabel: {
      fontSize: 16,
      color: theme.colors.textSecondary || '#666666',
      width: 100,
    },
    infoValue: {
      fontSize: 16,
      color: theme.colors.text || '#000000',
      flex: 1,
    },
    messagePreview: {
      backgroundColor: theme.colors.backgroundSecondary || '#F5F5F5',
      padding: 16,
      borderRadius: 12,
      marginBottom: 16,
    },
    messageText: {
      fontSize: 16,
      color: theme.colors.text || '#000000',
      lineHeight: 22,
    },
    senderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
    },
    senderInfo: {
      marginLeft: 12,
      flex: 1,
    },
    senderName: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text || '#000000',
      marginBottom: 4,
    },
    senderId: {
      fontSize: 14,
      color: theme.colors.textSecondary || '#666666',
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
    },
    emptyStateText: {
      fontSize: 16,
      color: theme.colors.textSecondary || '#666666',
      textAlign: 'center',
    },
  }), [theme]);

  if (!visible) {
    return null;
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.modal} edges={['top', 'bottom']}>
        <ThemedView style={styles.container}>
          <Header
            options={{
              title: 'Message Info',
              leftComponents: [
                <HeaderIconButton key="back" onPress={onClose}>
                  <BackArrowIcon size={20} color={theme.colors.text} />
                </HeaderIconButton>,
              ],
            }}
          />

          {message ? (
            <ScrollView 
              style={styles.container}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
              {/* Message Preview */}
              {(message.text || (message.media && message.media.length > 0)) && (
                <View style={styles.section}>
                  <View style={styles.messagePreview}>
                    {message.text ? (
                      <Text style={styles.messageText}>{message.text}</Text>
                    ) : null}
                    {message.media && message.media.length > 0 && (
                      <Text style={[
                        styles.messageText, 
                        { 
                          marginTop: message.text ? 8 : 0,
                          color: theme.colors.textSecondary || '#666666'
                        }
                      ]}>
                        {message.media.length} attachment{message.media.length > 1 ? 's' : ''}
                      </Text>
                    )}
                  </View>
                </View>
              )}

              {/* Sender Information */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Sender</Text>
                <View style={styles.senderRow}>
                  <MessageAvatar
                    name={senderName}
                    avatarUri={senderAvatar}
                    size={56}
                  />
                  <View style={styles.senderInfo}>
                    <Text style={styles.senderName}>{senderName || 'Unknown'}</Text>
                    <Text style={styles.senderId}>ID: {message.senderId}</Text>
                  </View>
                </View>
              </View>

              {/* Message Details */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Details</Text>
                
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Date</Text>
                  <Text style={styles.infoValue}>{formattedDate}</Text>
                </View>

                <View style={[styles.infoRow, styles.infoRowLast]}>
                  <Text style={styles.infoLabel}>Time</Text>
                  <Text style={styles.infoValue}>
                    {message.timestamp.toLocaleTimeString([], TIME_FORMAT_OPTIONS)}
                  </Text>
                </View>
              </View>

              {/* Status Information (for sent messages) */}
              {message.isSent && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Status</Text>
                  
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Status</Text>
                    <Text style={styles.infoValue}>Read</Text>
                  </View>

                  <View style={[styles.infoRow, styles.infoRowLast]}>
                    <Text style={styles.infoLabel}>Read At</Text>
                    <Text style={styles.infoValue}>
                      {message.timestamp.toLocaleTimeString([], TIME_FORMAT_OPTIONS)}
                    </Text>
                  </View>
                </View>
              )}

              {/* Message Metadata */}
              <View style={styles.section}>
                <MessageMetadata
                  timestamp={message.timestamp}
                  isSent={message.isSent}
                  isEdited={false}
                  readStatus={message.isSent ? 'read' : undefined}
                  showTimestamp={true}
                />
              </View>
            </ScrollView>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>No message selected</Text>
            </View>
          )}
        </ThemedView>
      </SafeAreaView>
    </Modal>
  );
});

MessageInfoScreen.displayName = 'MessageInfoScreen';

