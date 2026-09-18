import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { PollDraft } from '@allo/core';
import { Button, GlyphButton } from '@oxy.so/bloom/button';
import { RiAddLine, RiCloseCircleLine } from '@oxy.so/bloom/icons';
import { Dialog } from '@oxy.so/bloom/dialog';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useTheme } from '@oxy.so/bloom/theme';

import {
  canSendPoll,
  pollDraft,
  POLL_INITIAL_OPTIONS,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX_LENGTH,
  POLL_QUESTION_MAX_LENGTH,
} from '@/lib/chat/poll';

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
  const theme = useTheme();
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('poll.compose.title')}
      description={t('poll.compose.description')}
      label={t('poll.compose.title')}
      actions={[
        { label: t('poll.compose.send'), onPress: send, disabled: !canSendPoll(form) },
        { label: t('common.cancel'), color: 'cancel' },
      ]}
    >
      <ScrollView style={styles.body} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <TextFieldInput
          label={t('poll.compose.question')}
          placeholder={t('poll.compose.questionPlaceholder')}
          value={question}
          onChangeText={setQuestion}
          maxLength={POLL_QUESTION_MAX_LENGTH}
          multiline
        />

        {options.map((option, index) => (
          <View key={index} style={styles.option}>
            <View style={styles.optionField}>
              <TextFieldInput
                label={t('poll.compose.option', { index: index + 1 })}
                placeholder={t('poll.compose.optionPlaceholder')}
                value={option}
                onChangeText={(value) => setOption(index, value)}
                maxLength={POLL_OPTION_MAX_LENGTH}
                returnKeyType="next"
              />
            </View>
            {/* Below the floor there is nothing to remove: two options are the
                smallest poll the SDK accepts, so the control goes away rather
                than refusing the press. */}
            {options.length > POLL_MIN_OPTIONS ? (
              <GlyphButton
                icon={RiCloseCircleLine}
                color={theme.colors.textSecondary}
                accessibilityLabel={t('poll.compose.removeOption', { index: index + 1 })}
                onPress={() => removeOption(index)}
              />
            ) : null}
          </View>
        ))}

        {options.length < POLL_MAX_OPTIONS ? (
          <Button variant="text" icon={RiAddLine} onPress={addOption}>
            {t('poll.compose.addOption')}
          </Button>
        ) : null}

        <SettingsListGroup>
          <SettingsListItem
            title={t('poll.compose.multiple')}
            description={t('poll.compose.multipleDescription')}
            showChevron={false}
            rightElement={
              <Switch
                value={multiple}
                onValueChange={setMultiple}
                accessibilityLabel={t('poll.compose.multiple')}
              />
            }
          />
          <SettingsListItem
            title={t('poll.compose.anonymous')}
            description={t('poll.compose.anonymousDescription')}
            showChevron={false}
            rightElement={
              <Switch
                value={anonymous}
                onValueChange={setAnonymous}
                accessibilityLabel={t('poll.compose.anonymous')}
              />
            }
          />
        </SettingsListGroup>
      </ScrollView>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  body: { maxHeight: BODY_MAX_HEIGHT },
  content: { gap: 12, paddingBottom: 4 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  optionField: { flexGrow: 1, flexShrink: 1 },
});
