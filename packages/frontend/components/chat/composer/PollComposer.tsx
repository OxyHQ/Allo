import type { PollDraft } from '@allo/core';
import { Button } from '@oxy.so/bloom/button';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet } from 'react-native';

import {
  canSendPoll,
  POLL_INITIAL_OPTIONS,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX_LENGTH,
  POLL_QUESTION_MAX_LENGTH,
  pollDraft,
} from '@/lib/chat/poll';

import {
  Dialog as LDialog,
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  HStack,
  TextField,
  Toggle,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

/**
 * WRITING A POLL.
 *
 * Bloom's `Dialog` is one surface with two manners: a sheet from the bottom of
 * a phone, a card in the middle of a desktop window. That is `placement`, not
 * two components — which is why this file has no sheet of its own and no
 * breakpoint logic.
 *
 * What it collects is exactly `PollDraft` and nothing more. The two switches
 * are what voting MEANS rather than how it looks — "more than one answer" and
 * "nobody sees who voted" — so they are rows with their own words under them,
 * not icons in a toolbar.
 *
 * The rule for what may be sent lives in `lib/chat/poll.ts`, so the disabled
 * state of "Send" and the draft that leaves are one decision made once.
 */

interface PollComposerProps {
  open: boolean;
  onClose: () => void;
  /** Sends it. The screen owns the conversation and the failure. */
  onSend: (poll: PollDraft) => void;
}

/** How tall the scrolling body gets before it scrolls. Twelve options do not fit on a phone. */
const BODY_MAX_HEIGHT = 340;

export function PollComposer({ open, onClose, onSend }: PollComposerProps) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<readonly string[]>(POLL_INITIAL_OPTIONS);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);

  // Every opening starts empty rather than in the middle of the poll somebody
  // abandoned. It is done ON THE WAY IN, adjusting state during the render that
  // sees `open` turn true, for two reasons: an effect that resets on the way out
  // empties the sheet visibly while it is still animating closed, and React
  // reruns this render before committing anything, so nothing is drawn twice.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setQuestion('');
      setOptions(POLL_INITIAL_OPTIONS);
      setMultiple(false);
      setAnonymous(false);
    }
  }

  const form = { question, options, multiple, anonymous };

  const setOption = useCallback((index: number, value: string) => {
    setOptions((current) => current.map((option, at) => (at === index ? value : option)));
  }, []);

  const addOption = useCallback(() => {
    setOptions((current) => (current.length < POLL_MAX_OPTIONS ? [...current, ''] : current));
  }, []);

  const removeOption = useCallback((index: number) => {
    setOptions((current) => current.filter((_, at) => at !== index));
  }, []);

  const send = useCallback(() => {
    const draft = pollDraft({ question, options, multiple, anonymous });
    if (draft) onSend(draft);
  }, [anonymous, multiple, onSend, options, question]);

  return toElement(
    LDialog(
      Embed(
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {toElement(
            TextField([question, setQuestion], t('poll.compose.question'))
              .placeholder(t('poll.compose.questionPlaceholder'))
              .maxLength(POLL_QUESTION_MAX_LENGTH)
              .multiline(),
          )}

          {options.map((option, index) =>
            toElement(
              HStack(
                VStack(
                  TextField(
                    [option, (value) => setOption(index, value)],
                    t('poll.compose.option', { index: index + 1 }),
                  )
                    .placeholder(t('poll.compose.optionPlaceholder'))
                    .maxLength(POLL_OPTION_MAX_LENGTH)
                    .submitLabel('next'),
                )
                  .flex('grow')
                  .shrink('normal'),
                /* Below the floor there is nothing to remove: two options are the
                      smallest poll the SDK accepts, so the control goes away rather
                      than refusing the press. */ Embed(
                  options.length > POLL_MIN_OPTIONS ? (
                    <Button
                      iconOnly
                      appearance="plain"
                      icon={RiCloseCircleLine}
                      tone="neutral"
                      accessibilityLabel={t('poll.compose.removeOption', { index: index + 1 })}
                      onPress={() => removeOption(index)}
                    />
                  ) : null,
                ),
              )
                .align('center')
                .spacing('xs'),
              index,
            ),
          )}

          {options.length < POLL_MAX_OPTIONS ? (
            <Button icon={RiAddLine} onPress={addOption} tone="accent" appearance="plain">
              {t('poll.compose.addOption')}
            </Button>
          ) : null}

          {toElement(
            LGroupedSection(
              LGroupedSectionItem(t('poll.compose.multiple'))
                .description(t('poll.compose.multipleDescription'))
                .chevron(false)
                .trailing(Toggle([multiple, setMultiple]).label(t('poll.compose.multiple'))),
              LGroupedSectionItem(t('poll.compose.anonymous'))
                .description(t('poll.compose.anonymousDescription'))
                .chevron(false)
                .trailing(Toggle([anonymous, setAnonymous]).label(t('poll.compose.anonymous'))),
            ),
          )}
        </ScrollView>,
      ),
    )
      .presentAt('bottom', { md: 'center' })
      .title(t('poll.compose.title'))
      .message(t('poll.compose.description'))
      .label(t('poll.compose.title'))
      .buttons([
        { label: t('poll.compose.send'), onPress: send, disabled: !canSendPoll(form) },
        { label: t('common.cancel'), color: 'cancel' },
      ])
      .presented([open, () => onClose()]),
  );
}

const styles = StyleSheet.create({
  body: { maxHeight: BODY_MAX_HEIGHT },
  content: { gap: 12, paddingBottom: 4 },
});
