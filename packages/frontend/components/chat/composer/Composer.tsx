import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, type TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  AttachmentMenu,
  ChatComposer,
  ComposerBanner,
  ComposerIconButton,
  VoiceRecorder,
  type AttachmentMenuItem,
  type ChatComposerSuggestion,
} from '@oxy.so/bloom/chat-composer';
import {
  RiAttachment2,
  RiBarChartHorizontalLine,
  RiCameraLine,
  RiContactsBookLine,
  RiFileTextLine,
  RiGalleryLine,
  RiMapPinLine,
} from '@oxy.so/bloom/icons';
import { toast } from '@oxy.so/bloom/toast';
import type { ContactDraft, PlaceDraft, PollDraft } from '@allo/core';

import {
  captureMediaAttachment,
  pickContact,
  pickDocumentAttachments,
  pickMediaAttachments,
  pickPlace,
  toVoiceAttachment,
  type PickedAttachments,
} from '@/lib/chat/attachments';
import { logger } from '@/utils/logger';
import { EmojiButton } from './EmojiButton';
import { PollComposer } from './PollComposer';
import { applyMention, mentionFragment, type MentionFragment } from './mentions';
import { stagedTile, withCaption, type StagedAttachment } from './staging';
import { useVoiceRecording } from './useVoiceRecording';

/** What the composer is doing to an existing message, if anything. */
export type ComposerTarget =
  | { kind: 'reply'; id: string; title: string; preview: string }
  | { kind: 'edit'; id: string; body: string; preview: string };

/** Somebody `@` can name in this conversation. */
export interface Mentionable {
  id: string;
  label: string;
  handle?: string;
  avatar?: string;
}

interface ComposerProps {
  target: ComposerTarget | null;
  onClearTarget: () => void;
  /** Read-only, with this line in place of the input. */
  notice?: string;
  /** A line above the input that informs without blocking it. */
  note?: string | null;
  /** Who `@` offers. Empty (the default) turns mention suggestions off entirely. */
  mentionables?: readonly Mentionable[];
  onSendText: (text: string, target: ComposerTarget | null) => Promise<void>;
  onSendAttachments: (attachments: PickedAttachments) => Promise<void>;
  /**
   * The three that are not files. Each one goes as its OWN message the moment
   * it is chosen, rather than staging beside a caption: a poll, a place and a
   * card are each a whole message, and there is nothing to write underneath
   * them. So they never touch the draft, and picking one while a draft is being
   * typed leaves the draft where it was.
   */
  onSendPoll: (poll: PollDraft) => Promise<void>;
  onSendPlace: (place: PlaceDraft) => Promise<void>;
  onSendContact: (contact: ContactDraft) => Promise<void>;
  onTyping: (on: boolean) => void;
}

/** One typing notice per this long while someone keeps typing… */
const TYPING_REFRESH_MS = 5000;
/** …and a stop this long after the last keystroke. */
const TYPING_IDLE_MS = 3000;

/** Rows offered for an `@`. Bloom scrolls past about five. */
const MENTION_LIMIT = 8;

/** A stable empty default, so the suggestion memo does not rebuild every render. */
const NOBODY: readonly Mentionable[] = [];

// The camera picker is a native flow; recording works on both (expo-audio uses
// MediaRecorder on the web).
const IS_NATIVE = Platform.OS !== 'web';

/**
 * Where the insertion point is.
 *
 * On web the field IS the DOM node — react-native-web forwards the host element
 * as the ref, which is what Bloom's own autosize reads — so the caret is
 * exactly where the person put it. React Native has no way to READ a selection
 * (only to set one), and `ChatComposer` forwards no `onSelectionChange`, so the
 * end of the draft is the honest answer there: it is where somebody typing is.
 */
function caretIn(field: TextInput | null, text: string): number {
  const node = field as unknown as { selectionStart?: number | null } | null;
  const at = node?.selectionStart;
  return typeof at === 'number' ? at : text.length;
}

export function Composer({
  target,
  onClearTarget,
  notice,
  note,
  mentionables = NOBODY,
  onSendText,
  onSendAttachments,
  onSendPoll,
  onSendPlace,
  onSendContact,
  onTyping,
}: ComposerProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [staged, setStaged] = useState<readonly StagedAttachment[]>([]);
  const [composingPoll, setComposingPoll] = useState(false);
  const [mention, setMention] = useState<MentionFragment | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const voice = useVoiceRecording();
  const field = useRef<TextInput | null>(null);
  const lastTypingAt = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stagedSeq = useRef(0);

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

  const noteTyping = useCallback(
    (next: string) => {
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

  /** Put the caret back where the edit left it (web; native keeps its own). */
  const restoreCaret = useCallback((at: number) => {
    const node = field.current as unknown as
      | { focus?: () => void; setSelectionRange?: (start: number, end: number) => void }
      | null;
    if (!node?.setSelectionRange) return;
    requestAnimationFrame(() => {
      node.focus?.();
      node.setSelectionRange?.(at, at);
    });
  }, []);

  const onValueChange = useCallback(
    (next: string) => {
      setValue(next);
      noteTyping(next);
      setMention(mentionables.length > 0 ? mentionFragment(next, caretIn(field.current, next)) : null);
      setActiveIndex(0);
    },
    [mentionables.length, noteTyping],
  );

  /** Writes into the draft at the caret rather than at the end. */
  const insertAtCaret = useCallback(
    (insert: string) => {
      const at = caretIn(field.current, value);
      setValue(value.slice(0, at) + insert + value.slice(at));
      noteTyping(insert);
      setMention(null);
      restoreCaret(at + insert.length);
    },
    [noteTyping, restoreCaret, value],
  );

  const suggestions = useMemo<ChatComposerSuggestion[]>(() => {
    if (!mention) return [];
    const needle = mention.query.toLowerCase();
    return mentionables
      .filter(
        (person) =>
          needle.length === 0 ||
          person.label.toLowerCase().includes(needle) ||
          (person.handle?.toLowerCase().includes(needle) ?? false),
      )
      .slice(0, MENTION_LIMIT)
      .map((person) => ({
        id: person.id,
        label: person.label,
        handle: person.handle ? `@${person.handle}` : undefined,
        avatar: person.avatar,
      }));
  }, [mention, mentionables]);

  const acceptMention = useCallback(
    (suggestion: ChatComposerSuggestion) => {
      if (!mention) return;
      const person = mentionables.find((candidate) => candidate.id === suggestion.id);
      const applied = applyMention(value, mention, person?.handle ?? person?.label ?? suggestion.label);
      setValue(applied.value);
      setMention(null);
      setActiveIndex(0);
      restoreCaret(applied.caret);
    },
    [mention, mentionables, restoreCaret, value],
  );

  /**
   * Text alone, files alone, or both — and when there are both, the text is the
   * first file's caption rather than a message of its own.
   *
   * A reply cannot carry a file: `sendMedia` takes no `replyTo`, so a send that
   * has anything staged goes as media and the reply target is dropped with the
   * rest of the draft.
   */
  const send = useCallback(
    (text: string) => {
      const body = text.trim();
      const pending = staged;
      if (!body && pending.length === 0) return;
      setValue('');
      setMention(null);
      stopTyping();
      onClearTarget();
      if (pending.length === 0) {
        onSendText(body, target).catch(() => {
          // The screen reports the failure; the text comes back so it is not lost.
          setValue(text);
        });
        return;
      }
      setStaged([]);
      onSendAttachments(withCaption(pending, body)).catch(() => {
        setValue(text);
        setStaged(pending);
      });
    },
    [onClearTarget, onSendAttachments, onSendText, staged, stopTyping, target],
  );

  const attachItems = useMemo<AttachmentMenuItem[]>(
    () => [
      { id: 'gallery', label: t('composer.attach.gallery'), icon: RiGalleryLine },
      ...(IS_NATIVE ? [{ id: 'camera', label: t('composer.attach.camera'), icon: RiCameraLine }] : []),
      { id: 'file', label: t('composer.attach.file'), icon: RiFileTextLine },
      { id: 'location', label: t('composer.attach.location'), icon: RiMapPinLine },
      // A browser has no address book, so there is no picker to open there.
      ...(IS_NATIVE ? [{ id: 'contact', label: t('composer.attach.contact'), icon: RiContactsBookLine }] : []),
      { id: 'poll', label: t('composer.attach.poll'), icon: RiBarChartHorizontalLine },
    ],
    [t],
  );

  /**
   * A place, from this device, sent on its own. Saying no to the permission is
   * an answer, not a failure, so it passes in silence; a position that could
   * not be read says so.
   */
  const attachPlace = useCallback(async () => {
    const picked = await pickPlace();
    if (!picked.ok) {
      if (picked.reason === 'unavailable') toast.error(t('composer.attach.placeUnavailable'));
      return;
    }
    await onSendPlace(picked.place);
  }, [onSendPlace, t]);

  /** Somebody from the address book, as a card. */
  const attachContact = useCallback(async () => {
    const contact = await pickContact();
    if (!contact) return;
    await onSendContact(contact);
  }, [onSendContact]);

  /** Picking a FILE stages; nothing leaves until the composer is sent. The other three send themselves. */
  const pick = useCallback(
    async (source: string) => {
      if (source === 'poll') {
        setComposingPoll(true);
        return;
      }
      if (source === 'location') {
        await attachPlace();
        return;
      }
      if (source === 'contact') {
        await attachContact();
        return;
      }
      const picked =
        source === 'camera'
          ? await captureMediaAttachment()
          : source === 'file'
            ? await pickDocumentAttachments()
            : await pickMediaAttachments();
      if (picked.length === 0) return;
      const added = picked.map((file) => {
        stagedSeq.current += 1;
        return { id: `staged-${stagedSeq.current}`, file };
      });
      setStaged((current) => [...current, ...added]);
    },
    [attachContact, attachPlace],
  );

  const sendPoll = useCallback(
    (poll: PollDraft) => {
      setComposingPoll(false);
      void onSendPoll(poll);
    },
    [onSendPoll],
  );

  const unstage = useCallback((id: string) => {
    setStaged((current) => current.filter((item) => item.id !== id));
  }, []);

  const tiles = useMemo(() => staged.map(stagedTile), [staged]);

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

  /** Escape closes the suggestion list first; it is the thing in the way. */
  const onEscape = useCallback(() => {
    if (mention) {
      setMention(null);
      return;
    }
    if (target) cancelTarget();
  }, [cancelTarget, mention, target]);

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

  // Editing a message means editing its TEXT: `edit` replaces a body and has no
  // way to add a file to one, so the attach menu goes away for the duration the
  // way the mic already does.
  const canAttach = notice === undefined && target?.kind !== 'edit';

  return (
    <>
    <ChatComposer
      value={value}
      onValueChange={onValueChange}
      onSend={send}
      inputRef={field}
      placeholder={t('composer.placeholder')}
      notice={notice}
      banner={banner}
      recorder={recorder}
      attachments={tiles}
      onRemoveAttachment={unstage}
      suggestions={suggestions}
      suggestionKind="mention"
      activeIndex={activeIndex}
      onActiveIndexChange={setActiveIndex}
      onSelectSuggestion={acceptMention}
      leading={
        canAttach ? (
          <AttachmentMenu
            items={attachItems}
            onSelect={(id) => {
              pick(id).catch((error: unknown) => logger.warn('[composer] an attachment could not be added', error));
            }}
            label={t('composer.attach.label')}
          >
            <ComposerIconButton icon={RiAttachment2} accessibilityLabel={t('composer.attach.label')} />
          </AttachmentMenu>
        ) : undefined
      }
      emojiSlot={notice === undefined ? <EmojiButton onSelect={insertAtCaret} /> : undefined}
      onMicPress={target?.kind === 'edit' || staged.length > 0 ? undefined : () => void startVoice()}
      onEscape={mention || target ? onEscape : undefined}
      labels={{ send: t('composer.send'), mic: t('composer.voice.record'), input: t('composer.placeholder') }}
    />
    {/* Mounted beside the composer rather than inside the menu: the menu closes
        on a selection, and a sheet that unmounts with its trigger closes with
        it. */}
    <PollComposer open={composingPoll} onClose={() => setComposingPoll(false)} onSend={sendPoll} />
    </>
  );
}
