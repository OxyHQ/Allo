import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  AttachmentMenu,
  ChatComposer,
  ComposerBanner,
  ComposerIconButton,
  VoiceRecorder,
  type AttachmentMenuItem,
} from '@oxy.so/bloom/chat-composer';
import { RiAttachment2, RiCameraLine, RiFileTextLine, RiGalleryLine } from '@oxy.so/bloom/icons';
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

export function Composer({ target, onClearTarget, notice, note, onSendText, onSendAttachments, onTyping }: ComposerProps) {
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
    if (recording) await onSendAttachments([toVoiceAttachment(recording.uri, recording.durationMs / 1000)]);
  }, [onSendAttachments, voice]);

  const targetBanner = target ? (
    <ComposerBanner
      kind={target.kind}
      title={target.kind === 'edit' ? t('composer.editing') : target.title}
      preview={target.preview}
      closeLabel={t('common.cancel')}
      onClose={() => {
        if (target.kind === 'edit') setValue('');
        onClearTarget();
      }}
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
      onEscape={target ? onClearTarget : undefined}
      labels={{ send: t('composer.send'), mic: t('composer.voice.record'), input: t('composer.placeholder') }}
    />
  );
}
