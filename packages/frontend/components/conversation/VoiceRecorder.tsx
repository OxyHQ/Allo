/**
 * VoiceRecorder — thin helper around `MicSendButton` that handles the
 * actual upload + send pipeline once a recording is captured.
 *
 * We keep the gesture/UX in `MicSendButton` (already wired with
 * "hold to record / slide to cancel" + haptics + lock); this module
 * exposes the post-record handler that uploads the audio and dispatches
 * a `sendAttachmentMessage`.
 */
import { useCallback } from 'react';
import * as Haptics from 'expo-haptics';
import { toast } from '@/lib/sonner';
import { useMessagesStore } from '@/stores';
import { useTranslation } from 'react-i18next';

interface UseVoiceRecorderArgs {
  conversationId: string;
  senderId?: string;
  recipientUserId?: string;
}

export function useVoiceRecorder({
  conversationId,
  senderId,
  recipientUserId,
}: UseVoiceRecorderArgs) {
  const { t } = useTranslation();
  const sendAttachmentMessage = useMessagesStore((s) => s.sendAttachmentMessage);

  const handleRecordStart = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  }, []);

  const handleRecordCancel = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    toast(t('chat.recordCancelled'));
  }, [t]);

  const handleRecordEnd = useCallback(
    async (uri: string, duration: number) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

      if (!uri || duration < 0.5) {
        toast(t('chat.recordTooShort'));
        return;
      }
      if (!senderId || !recipientUserId) {
        toast.error(t('chat.recordSendFailed'));
        return;
      }

      const toastId = toast.loading(t('chat.sendingAudio'));
      try {
        // Pass the local recording URI; the store encrypts it once and uploads
        // only the ciphertext (end-to-end encrypted media, Fase 1D).
        await sendAttachmentMessage(
          conversationId,
          {
            attachmentType: 'audio',
            media: [
              {
                id: `local-${Date.now()}`,
                type: 'audio',
                localUri: uri,
                fileName: `voice-${Date.now()}.m4a`,
                mimeType: 'audio/mp4',
                duration,
              },
            ],
          },
          senderId,
          recipientUserId
        );
      } catch (error) {
        console.error('[VoiceRecorder] send failed:', error);
        toast.error(t('chat.recordSendFailed'));
      } finally {
        toast.dismiss(toastId);
      }
    },
    [conversationId, senderId, recipientUserId, sendAttachmentMessage, t]
  );

  return { handleRecordStart, handleRecordEnd, handleRecordCancel };
}
