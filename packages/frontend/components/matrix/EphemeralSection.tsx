import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Admonition } from '@oxyhq/bloom/admonition';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxyhq/bloom/segmented-control';
import { Switch } from '@oxyhq/bloom/switch';
import { toast } from '@oxyhq/bloom/toast';

import { useEphemeralLifetimes } from '@/components/matrix/ephemeralLifetimes';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { ephemeralSendRefusal } from '@/lib/matrix/ephemeral/trust';
import { ephemeralPolicyOf } from '@/lib/matrix/ephemeral/policy';
import type { AlloEphemeralPolicy, AlloRoomTrust } from '@/lib/matrix/types';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Turning a conversation's messages into ones that disappear, and saying — in
 * the same place, without being asked — exactly what that does and does not do.
 *
 * The second half is not decoration. This is the one feature in Allo whose value
 * a user cannot check for themselves: they cannot see whether the other person's
 * copy went away, and a screen that implied it always does would be the app
 * lying about security. The rule the whole tier is built under is in
 * `docs/matrix/ephemeral.md`: **say what is enforced, say what is cooperative,
 * and never let the interface blur the two.**
 *
 * So the copy here promises exactly two things — that this device stops showing
 * the messages, and that the ones it sent are removed from the homeserver — and
 * names the three ways that is not enough: the other person's client is not
 * told, a different client need not cooperate, and nothing stops a screenshot.
 */

/** The default when the switch is turned on. A day: long enough to have a conversation. */
const DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface EphemeralSectionProps {
  readonly policy: AlloEphemeralPolicy | undefined;
  /**
   * What this device knows about the people in the room, or `undefined` when it
   * could not find out. See `RoomAdminSnapshot.trust`.
   */
  readonly trust: AlloRoomTrust | undefined;
  /** The name to draw for somebody, so a warning names people and not MXIDs. */
  readonly nameOf: (userId: string) => string;
  readonly onChange: (policy: AlloEphemeralPolicy | undefined) => Promise<void>;
}

export function EphemeralSection({ policy, trust, nameOf, onChange }: EphemeralSectionProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useStyles();
  const [isSaving, setIsSaving] = useState(false);

  const { choices } = useEphemeralLifetimes();
  const isOn = policy !== undefined;

  const apply = useCallback(
    async (next: AlloEphemeralPolicy | undefined) => {
      setIsSaving(true);
      try {
        await onChange(next);
      } catch (error: unknown) {
        logger.error('[chat] a conversation could not be made ephemeral', error);
        toast.error(
          getErrorMessage(error) || t('Allo could not change this setting'),
        );
      } finally {
        setIsSaving(false);
      }
    },
    [onChange, t],
  );

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <ThemedText style={styles.title}>{t('Disappearing messages')}</ThemedText>
          <ThemedText style={styles.subtitle}>
            {t('Messages stop being shown here once their time is up.')}
          </ThemedText>
        </View>
        {isSaving ? (
          <ActivityIndicator color={theme.colors.primary} />
        ) : (
          <Switch
            value={isOn}
            onValueChange={(value) => {
              void apply(value ? ephemeralPolicyOf(DEFAULT_LIFETIME_MS) : undefined);
            }}
          />
        )}
      </View>

      {isOn && (
        <SegmentedControl
          label={t('How long messages last')}
          type="radio"
          value={String(policy.lifetimeMs)}
          onChange={(value) => {
            void apply(ephemeralPolicyOf(Number(value)));
          }}
        >
          {choices.map(({ lifetimeMs, label }) => (
            <SegmentedControlItem key={lifetimeMs} value={String(lifetimeMs)} disabled={isSaving}>
              <SegmentedControlItemText>{label}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      )}

      {isOn && (
        <>
          <Admonition type="info">
            {t(
              'What Allo does: this device stops showing these messages once their time is up, and asks the homeserver to delete the ones you sent, for everyone.',
            )}
          </Admonition>
          <Admonition type="warning">
            {t(
              'What it cannot do: the other people are not told, so their messages stay unless they turn this on too. A different Matrix app, a modified one, or a screenshot keeps a copy anyway. Treat this as tidying up, not as a secret.',
            )}
          </Admonition>
          <TrustNotice trust={trust} nameOf={nameOf} />
        </>
      )}
    </View>
  );
}

/**
 * What the send gate will do, before the user finds out by typing.
 *
 * The refusal in `lib/matrix/ephemeral/trust.ts` is enforced inside the port, so
 * a conversation that cannot be written into is one where the composer will
 * simply fail. Saying so here — with the names of the people involved — is the
 * difference between a rule and a wall.
 */
function TrustNotice({
  trust,
  nameOf,
}: {
  readonly trust: AlloRoomTrust | undefined;
  readonly nameOf: (userId: string) => string;
}) {
  const { t } = useTranslation();

  if (trust === undefined) {
    return (
      <Admonition type="warning">
        {t('Allo could not check who is in this conversation on this device.')}
      </Admonition>
    );
  }

  const refusal = ephemeralSendRefusal(trust);
  if (refusal === undefined) {
    return (
      <Admonition type="tip">
        {t('Everyone here has an identity this device recognises, so messages can be sent.')}
      </Admonition>
    );
  }
  if (refusal.kind === 'own-device-unverified') {
    return (
      <Admonition type="error">
        {t(
          'Allo will not send here until this device is verified with your Oxy recovery phrase, in Settings.',
        )}
      </Admonition>
    );
  }
  return (
    <Admonition type="error">
      {t(
        'Allo will not send here: it does not recognise the identity of {{people}}. Ask them to open Allo and finish setting up their account.',
        { people: refusal.userIds.map(nameOf).join(', ') },
      )}
    </Admonition>
  );
}

function useStyles() {
  const theme = useTheme();
  return useMemo(
    () =>
      StyleSheet.create({
        section: {
          paddingHorizontal: 16,
          paddingTop: 24,
          gap: 12,
        },
        headerRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        },
        headerText: {
          flex: 1,
        },
        title: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.colors.text,
        },
        subtitle: {
          fontSize: 13,
          color: theme.colors.textSecondary,
          marginTop: 2,
        },
      }),
    [theme.colors],
  );
}
