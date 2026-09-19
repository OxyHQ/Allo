/**
 * "Delete conversation", with Telegram's checkbox and without its promise.
 *
 * Telegram can offer "also delete for X" because the message sits on its
 * server and it can take it away. Allo's does not: the other copy is on the
 * other person's device, decrypted with keys only they hold. What the checkbox
 * sends is a `clear_history` control message their app obeys — which is the
 * whole truth, so the dialog says it in the description rather than implying
 * something it cannot do.
 *
 * Offered for a DM only. In a group it would mean asking a room full of people
 * to delete their copy on one person's say-so, which is a different feature
 * with a different argument behind it.
 *
 * Bloom draws all of it. The confirm with a checkbox is not one of Bloom's
 * ready-made surfaces, so this presents its own content onto the SAME surface
 * stack through `present()` — stacked and dismissed like every other surface,
 * rather than a modal of its own invention.
 */
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { present } from '@oxy.so/bloom/surfaces';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';

export interface DeleteConversationAnswer {
  confirmed: boolean;
  forEveryone: boolean;
}

interface Props {
  title: string;
  description: string;
  /** The checkbox label, already naming the person. Omitted in a group, where the choice is not offered. */
  alsoForThemLabel?: string;
  confirmLabel: string;
  cancelLabel: string;
  onAnswer: (answer: DeleteConversationAnswer) => void;
}

function DeleteConversationBody({ title, description, alsoForThemLabel, confirmLabel, cancelLabel, onAnswer }: Props) {
  const theme = useTheme();
  const [forEveryone, setForEveryone] = useState(false);
  return (
    <View style={styles.root}>
      <Text variant="title-3-semibold" accessibilityRole="header">
        {title}
      </Text>
      <Text variant="body-medium" style={{ color: theme.colors.textSecondary }}>
        {description}
      </Text>
      {alsoForThemLabel ? (
        <Checkbox checked={forEveryone} onCheckedChange={setForEveryone} label={alsoForThemLabel} />
      ) : null}
      <View style={styles.actions}>
        <Button variant="secondary" onPress={() => onAnswer({ confirmed: false, forEveryone: false })}>
          {cancelLabel}
        </Button>
        <Button variant="destructive" onPress={() => onAnswer({ confirmed: true, forEveryone })}>
          {confirmLabel}
        </Button>
      </View>
    </View>
  );
}

/** Presents the dialog and resolves what the person chose. A dismissal is a `false`, like every other surface. */
export function askDeleteConversation(options: Omit<Props, 'onAnswer'>): Promise<DeleteConversationAnswer> {
  return present<DeleteConversationAnswer>(
    (surface) => <DeleteConversationBody {...options} onAnswer={(answer) => surface.dismiss(answer)} />,
    { placement: { base: 'bottom', md: 'center' }, maxWidth: 420 },
  ).then((answer) => answer ?? { confirmed: false, forEveryone: false });
}

const styles = StyleSheet.create({
  root: { gap: 16 },
  actions: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end' },
});
