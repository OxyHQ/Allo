import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import type { KeyboardTypeOptions } from 'react-native';
import { TextFieldInput } from '@oxyhq/bloom';
import { Button } from '@oxyhq/bloom/button';
import { useTranslation } from 'react-i18next';

import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { logger } from '@/utils/logger';
import type { BridgeLoginField } from '@/lib/bridges/contract';

/**
 * A `user_input` step, drawn from the fields the bridge declared
 * (`docs/matrix/bridges.md` §5.2).
 *
 * Nothing here knows what a Telegram phone number is. The bridge sends a list of
 * fields with ids, types, labels and patterns; this renders them and sends back a
 * map keyed by those ids. §6.2's four-step Telegram flow and §6.3's WhatsApp
 * pairing-code flow are both just sequences of this component, which is why
 * neither is written down anywhere in the app.
 */

export interface LoginStepFormProps {
  readonly fields: readonly BridgeLoginField[];
  readonly submitLabel: string;
  readonly isSubmitting: boolean;
  readonly onSubmit: (values: Record<string, string>) => void;
}

/**
 * The keyboard for a field type. §5.2 lists ten types the bridge can send.
 *
 * An unknown type gets the default keyboard rather than an error: the list
 * belongs to the bridge, and a release adding an eleventh type must degrade to a
 * plain text box instead of a login that cannot be completed.
 */
const KEYBOARDS: Readonly<Record<string, KeyboardTypeOptions>> = Object.freeze({
  phone_number: 'phone-pad',
  email: 'email-address',
  '2fa_code': 'number-pad',
  url: 'url',
});

function isSecret(fieldType: string): boolean {
  return fieldType === 'password' || fieldType === 'token';
}

/**
 * The bridge's own validation, compiled defensively.
 *
 * §6.2: the bridge validates and normalises a phone number before sending it, and
 * applying the same `pattern` here saves a round trip that would otherwise come
 * back as a refusal. But this is a regular expression authored in another
 * project: an invalid one must not take the screen down, and the honest fallback
 * is to accept the input and let the server be the judge — which it is anyway.
 */
function compilePattern(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined;
  try {
    return new RegExp(pattern);
  } catch (error) {
    logger.warn('[Bridges] a login field carried an invalid pattern', {
      pattern,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function LoginStepForm({
  fields,
  submitLabel,
  isSubmitting,
  onSubmit,
}: LoginStepFormProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});

  const patterns = useMemo(
    () =>
      new Map(fields.map((field) => [field.id, compilePattern(field.pattern)] as const)),
    [fields],
  );

  /**
   * Derived during render rather than tracked in state: whether the form can be
   * sent is a function of what is typed, and a second copy of it could only ever
   * be the previous answer.
   */
  const canSubmit = fields.every((field) => {
    const value = values[field.id] ?? '';
    if (value.trim().length === 0) return false;
    const pattern = patterns.get(field.id);
    return pattern === undefined || pattern.test(value);
  });

  return (
    <View>
      {fields.map((field) => {
        const value = values[field.id] ?? '';
        const pattern = patterns.get(field.id);
        // Only complain about something the user has actually typed. An empty
        // field is incomplete, not wrong.
        const isInvalid =
          value.length > 0 && pattern !== undefined && !pattern.test(value);

        return (
          <View key={field.id} className="mb-4">
            <TextFieldInput
              label={field.name ?? field.id}
              value={value}
              onChangeText={(next) =>
                setValues((previous) => ({ ...previous, [field.id]: next }))
              }
              isInvalid={isInvalid}
              secureTextEntry={isSecret(field.type)}
              keyboardType={KEYBOARDS[field.type]}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />
            {field.description !== undefined && (
              <ThemedText
                className="mt-1 text-xs"
                style={{ color: theme.colors.textSecondary }}
              >
                {field.description}
              </ThemedText>
            )}
            {isInvalid && (
              <ThemedText className="mt-1 text-xs" style={{ color: theme.colors.error }}>
                {t('bridges.link.fieldInvalid', {
                  defaultValue: 'This does not look like a valid value yet',
                })}
              </ThemedText>
            )}
          </View>
        );
      })}

      <Button
        variant="primary"
        disabled={!canSubmit || isSubmitting}
        onPress={() => onSubmit(values)}
      >
        {submitLabel}
      </Button>
    </View>
  );
}
