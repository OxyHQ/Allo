import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxyhq/bloom/toast';

import { ThemedText } from '@/components/ThemedText';
import { DocumentIcon } from '@/assets/icons/document-icon';
import { shareAttachment } from '@/components/media/shareAttachment';
import { useTheme } from '@/hooks/useTheme';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';
import type { MessageAttachment, MessageReadStatus } from '@/stores/messagesStore';
import { logger } from '@/utils/logger';
import { extensionOf, mimetypeFromFilename } from '@/utils/mimetypes';

import { MessageMetadata } from './MessageMetadata';
import { formatFileSize } from './attachmentFormat';

/**
 * A document, and a way to open it.
 *
 * Opening one means handing it to the rest of the device — there is no viewer in
 * Allo for a PDF or a spreadsheet, and building one would be building the wrong
 * thing. The share sheet is where "open in", "save to files" and every app that
 * reads this kind of file already live.
 *
 * **Nothing is fetched until it is asked for.** A document is whatever size its
 * sender chose, and asking the resolver for a URL is what starts the download
 * (see `lib/chat/mediaCache.ts`). A row that downloaded itself on render would
 * pull a 40 MB attachment onto a phone that only scrolled past it.
 */

export interface FileBubbleProps {
  readonly attachment: MessageAttachment;
  readonly isSent: boolean;
  readonly timestamp: Date;
  readonly showTimestamp: boolean;
  readonly readStatus: MessageReadStatus | undefined;
  /** An attachment source to a local URI, or `''` while there is not one yet. */
  readonly resolveUrl: (source: string) => string;
}

export const FileBubble = memo<FileBubbleProps>(
  ({ attachment, isSent, timestamp, showTimestamp, readStatus, resolveUrl }) => {
    const theme = useTheme();
    const { t } = useTranslation();

    const [wanted, setWanted] = useState(false);
    const [pendingOpen, setPendingOpen] = useState(false);

    const uri = wanted ? resolveUrl(attachment.source) : '';

    const open = useCallback(
      (readyUri: string) => {
        shareAttachment({
          uri: readyUri,
          filename: attachment.filename,
          mimetype: mimetypeFromFilename(attachment.filename),
        })
          .then((outcome) => {
            if (outcome === 'unavailable') {
              toast.error(t('Opening files is not available on this device.'));
            }
          })
          .catch((error: unknown) => {
            logger.error('[media] a document could not be opened', error);
            toast.error(t('The file could not be opened.'));
          });
      },
      [attachment.filename, t],
    );

    /**
     * The same one-shot as `VoiceNoteBubble`'s, for the same reason: the tap
     * happened before there was a file to hand over, and the moment there is one
     * belongs to the download rather than to React. Cleared as it is honoured,
     * so a second arrival cannot open the document twice.
     */
    useEffect(() => {
      if (!pendingOpen || uri === '') {
        return;
      }
      setPendingOpen(false);
      open(uri);
    }, [pendingOpen, uri, open]);

    const handlePress = useCallback(() => {
      if (uri !== '') {
        open(uri);
        return;
      }
      setWanted(true);
      setPendingOpen(true);
    }, [open, uri]);

    const bubbleColor = isSent
      ? theme.colors.messageBubbleSent
      : theme.colors.messageBubbleReceived;
    const foreground = isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived;
    const badgeColor = isSent ? theme.colors.primaryLight : theme.colors.border;

    const styles = useMemo(
      () =>
        StyleSheet.create({
          bubble: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingHorizontal: MESSAGING_CONSTANTS.MESSAGE_PADDING_HORIZONTAL,
            paddingVertical: MESSAGING_CONSTANTS.MESSAGE_PADDING_VERTICAL,
            borderRadius: MESSAGING_CONSTANTS.MESSAGE_BUBBLE_BORDER_RADIUS,
            backgroundColor: bubbleColor,
            alignSelf: isSent ? 'flex-end' : 'flex-start',
            // No `maxWidth`: the block's content column is already capped at
            // `MAX_MESSAGE_WIDTH`, and capping again inside it would make an
            // attachment two thirds the width of the text beside it.
            minWidth: 200,
          },
          badge: {
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: badgeColor,
          },
          details: {
            flex: 1,
          },
          filename: {
            fontSize: 15,
            fontWeight: '600',
            color: foreground,
          },
          subtitle: {
            fontSize: MESSAGING_CONSTANTS.TIMESTAMP_SIZE,
            color: foreground,
            opacity: 0.8,
          },
          footer: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          },
        }),
      [badgeColor, bubbleColor, foreground, isSent],
    );

    // "PDF · 1.4 MB", and either half alone when the other is unknown. An
    // absent size is left out rather than shown as zero: nothing measured it.
    const subtitle = [
      extensionOf(attachment.filename).toUpperCase(),
      formatFileSize(attachment.size),
    ]
      .filter((part) => part !== undefined && part !== '')
      .join(' · ');

    const isFetching = pendingOpen && uri === '';

    return (
      <TouchableOpacity
        style={styles.bubble}
        onPress={handlePress}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={t('Open {{name}}', { name: attachment.filename })}
      >
        <View style={styles.badge}>
          {isFetching ? (
            <ActivityIndicator color={foreground} />
          ) : (
            <DocumentIcon size={22} color={foreground} />
          )}
        </View>
        <View style={styles.details}>
          <ThemedText numberOfLines={2} style={styles.filename}>
            {attachment.filename}
          </ThemedText>
          <View style={styles.footer}>
            <ThemedText style={styles.subtitle}>{subtitle}</ThemedText>
            {showTimestamp && (
              <MessageMetadata
                timestamp={timestamp}
                isSent={isSent}
                readStatus={readStatus}
                showTimestamp={showTimestamp}
                variant="bubble"
              />
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  },
);

FileBubble.displayName = 'FileBubble';
