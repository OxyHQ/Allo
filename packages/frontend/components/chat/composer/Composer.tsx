import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  AttachmentMenu,
  ChatComposer,
  ComposerBanner,
  ComposerIconButton,
  VoiceRecorder,
  type AttachmentMenuItem,
  type ChatComposerIcon,
} from '@oxy.so/bloom/chat-composer';
import { RiAttachment2, RiCameraLine, RiErrorWarningLine, RiFileTextLine, RiGalleryLine } from '@oxy.so/bloom/icons';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';

import {
  captureMediaAttachment,
  pickDocumentAttachments,
  pickMediaAttachments,
  toVoiceAttachment,
  type PickedAttachments,
} from '@/lib/chat/attachments';
import { useVoiceRecording } from './useVoiceRecording';

/** What the composer is doing to an existing message, if anything. */
export type ComposerTarget =
  | { kind: 'reply'; id: string; title: string; preview: string }
  | { kind: 'edit'; id: string; body: string; preview: string };

interface ComposerProps {
  target: ComposerTarget | null;
  onClearTarget: () => void;
  /** Read-only, with this line in place of the input. */
  notice?: string;
  /** The notice is about something under way: a spinner takes the icon's place. */
  noticeBusy?: boolean;
  /** The notice is a failure, not a wait: the icon is drawn in the error colour. */
  noticeError?: boolean;
  /** A line above the input that informs without blocking it. */
  note?: string | null;
  onSendText: (text: string, target: ComposerTarget | null) => Promise<void>;
  onSendAttachments: (attachments: PickedAttachments) => Promise<void>;
  onTyping: (on: boolean) => void;
}

/** One typing notice per this long while someone keeps typing… */
const TYPING_REFRESH_MS = 5000;
/** …and a stop this long after the last keystroke. */
const TYPING_IDLE_MS = 3000;

// The camera picker is a native flow; recording works on both (expo-audio uses
// MediaRecorder on the web).
const IS_NATIVE = Platform.OS !== 'web';

/** Bloom draws the notice icon at 16px in the secondary icon colour; a spinner in the same slot and colour. */
const BusyNoticeIcon: ChatComposerIcon = ({ fill }) => (
  <ActivityIndicator size="small" color={typeof fill === 'string' ? fill : undefined} testID="composer-notice-busy" />
);

/** The failure glyph in the theme's error colour, whatever secondary tint Bloom passes. */
const ErrorNoticeIcon: ChatComposerIcon = ({ width, height }) => {
  const theme = useTheme();
  return <RiErrorWarningLine width={width} height={height} fill={theme.colors.error} />;
};

export function Composer({ target, onClearTarget, notice, noticeBusy, noticeError, note, onSendText, onSendAttachments, onTyping }: ComposerProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const voice = useVoiceRecording();
  const lastTypingAt = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Editing starts from the message's own text.
  const [shownTarget, setShownTarget] = useState(target);
  if (target !== shownTarget) {
    setShownTarget(target);
    if (target?.kind === 'edit') setValue(target.body);
  }

  const stopTyping = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = null;
    if (lastTypingAt.current !== 0) onTyping(false);
    lastTypingAt.current = 0;
  }, [onTyping]);

  useEffect(() => stopTyping, [stopTyping]);

  const onValueChange = useCallback(
    (next: string) => {
      setValue(next);
      if (next.length === 0) {
        stopTyping();
        return;
      }
      const now = Date.now();
      if (now - lastTypingAt.current > TYPING_REFRESH_MS) {
        onTyping(true);
        lastTypingAt.current = now;
      }
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(stopTyping, TYPING_IDLE_MS);
    },
    [onTyping, stopTyping],
  );

  const send = useCallback(
    (text: string) => {
      const body = text.trim();
      if (!body) return;
      setValue('');
      stopTyping();
      onClearTarget();
      onSendText(body, target).catch(() => {
        // The screen reports the failure; the text comes back so it is not lost.
        setValue(text);
      });
    },
    [onClearTarget, onSendText, stopTyping, target],
  );

  const attachItems = useMemo<AttachmentMenuItem[]>(
    () => [
      { id: 'gallery', label: t('composer.attach.gallery'), icon: RiGalleryLine },
      ...(IS_NATIVE ? [{ id: 'camera', label: t('composer.attach.camera'), icon: RiCameraLine }] : []),
      { id: 'file', label: t('composer.attach.file'), icon: RiFileTextLine },
    ],
    [t],
  );

  const pick = useCallback(
    async (source: string) => {
      const picked =
        source === 'camera'
          ? await captureMediaAttachment()
          : source === 'file'
            ? await pickDocumentAttachments()
            : await pickMediaAttachments();
      if (picked.length > 0) await onSendAttachments(picked);
    },
    [onSendAttachments],
  );

  const startVoice = useCallback(async () => {
    if (!(await voice.start())) toast.error(t('composer.voice.permission'));
  }, [t, voice]);

  const sendVoice = useCallback(async () => {
    const recording = await voice.finish();
    if (!recording) {
      toast.error(t('composer.voice.tooShort'));
      return;
    }
    await onSendAttachments([
      toVoiceAttachment(recording.uri, recording.durationMs / 1000, recording.mimetype),
    ]);
  }, [onSendAttachments, t, voice]);

  /** Cancelling an edit takes its text with it — otherwise the next send posts a copy. */
  const cancelTarget = useCallback(() => {
    if (target?.kind === 'edit') setValue('');
    onClearTarget();
  }, [onClearTarget, target]);

  const targetBanner = target ? (
    <ComposerBanner
      kind={target.kind}
      title={target.kind === 'edit' ? t('composer.editing') : target.title}
      preview={target.preview}
      closeLabel={t('common.cancel')}
      onClose={cancelTarget}
    />
  ) : undefined;

  const banner =
    note || targetBanner ? (
      <>
        {note ? <ComposerBanner kind="note" title={note} /> : null}
        {targetBanner}
      </>
    ) : undefined;

  const recorder = voice.recording ? (
    <VoiceRecorder
      state="locked"
      seconds={voice.seconds}
      onCancel={() => void voice.cancel()}
      onDelete={() => void voice.cancel()}
      onSend={() => void sendVoice()}
      labels={{ cancel: t('common.cancel'), send: t('composer.send'), recording: t('composer.voice.recording') }}
    />
  ) : undefined;

  return (
    <ChatComposer
      value={value}
      onValueChange={onValueChange}
      onSend={send}
      placeholder={t('composer.placeholder')}
      notice={notice}
      noticeIcon={noticeBusy ? BusyNoticeIcon : noticeError ? ErrorNoticeIcon : undefined}
      banner={banner}
      recorder={recorder}
      leading={
        notice === undefined ? (
          <AttachmentMenu items={attachItems} onSelect={(id) => void pick(id)} label={t('composer.attach.label')}>
            <ComposerIconButton icon={RiAttachment2} accessibilityLabel={t('composer.attach.label')} />
          </AttachmentMenu>
        ) : undefined
      }
      onMicPress={target?.kind === 'edit' ? undefined : () => void startVoice()}
      onEscape={target ? cancelTarget : undefined}
      labels={{ send: t('composer.send'), mic: t('composer.voice.record'), input: t('composer.placeholder') }}
    />
  );
}
