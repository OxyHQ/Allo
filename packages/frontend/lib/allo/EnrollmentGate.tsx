/**
 * THE ENROLLMENT GATE: what a device sees before it is one of the account's
 * devices, and after it has stopped being one.
 *
 * `active` renders the app. `pending-approval` renders a screen explaining
 * that another signed-in device has to approve this one, with the challenge
 * fingerprint the approver will be shown so the two can be compared out of
 * band. `revoked` renders a screen with one way out: start over, which wipes
 * this device's keys and enrols it afresh. `unregistered` is the moment
 * between `start()` beginning and the instance existing, and renders the app
 * so the shell is on screen while the SDK opens its store.
 *
 * Plain React Native primitives and `theme.colors.*` only. It is mounted at
 * boot, so nothing here may suspend: `useTranslation` is called with suspense
 * off, and every string has an inline default.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAlloClient, useInstanceState } from '@allo/react';
import { useTheme } from '@/hooks/useTheme';
import { logger } from '@/utils/logger';

export interface EnrollmentGateProps {
  children: React.ReactNode;
  /** Signs the account out of Oxy; the pending screen offers it as the way to give up. */
  onSignOut?: () => void;
}

export function EnrollmentGate({ children, onSignOut }: EnrollmentGateProps) {
  const { state, instance, error } = useInstanceState();
  const client = useAlloClient();

  if (state === 'pending-approval') {
    return (
      <PendingApprovalScreen
        deviceName={instance?.displayName}
        fingerprint={instance?.enrollment?.fingerprint}
        errorMessage={error?.message}
        onSignOut={onSignOut}
      />
    );
  }
  if (state === 'revoked') {
    return (
      <RevokedScreen
        onStartOver={async () => {
          await client.reset();
          await client.start();
        }}
        onSignOut={onSignOut}
      />
    );
  }
  return <>{children}</>;
}

interface PendingApprovalScreenProps {
  deviceName?: string;
  fingerprint?: string;
  errorMessage?: string;
  onSignOut?: () => void;
}

export function PendingApprovalScreen({ deviceName, fingerprint, errorMessage, onSignOut }: PendingApprovalScreenProps) {
  const { t } = useTranslation(undefined, { useSuspense: false });
  const styles = useGateStyles();
  return (
    <View style={styles.container} accessibilityRole="summary">
      <ActivityIndicator color={styles.spinner.color} />
      <Text style={styles.title}>{t('enrollment.pending.title', 'Approve this device')}</Text>
      <Text style={styles.body}>
        {t(
          'enrollment.pending.body',
          'Open Allo on a device that is already signed in, go to Settings, then Devices, and approve this one. That device shows a verification code for it; check the device name matches before you approve.',
        )}
      </Text>
      {deviceName ? <Text style={styles.detail}>{deviceName}</Text> : null}
      {fingerprint ? (
        <Text style={styles.fingerprint} accessibilityLabel={t('enrollment.fingerprint', 'Verification code')}>
          {fingerprint}
        </Text>
      ) : null}
      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      {onSignOut ? (
        <TouchableOpacity onPress={onSignOut} style={styles.secondaryButton} accessibilityRole="button">
          <Text style={styles.secondaryButtonText}>{t('settings.signOut', 'Sign out')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

interface RevokedScreenProps {
  onStartOver: () => Promise<void>;
  onSignOut?: () => void;
}

export function RevokedScreen({ onStartOver, onSignOut }: RevokedScreenProps) {
  const { t } = useTranslation(undefined, { useSuspense: false });
  const styles = useGateStyles();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const startOver = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      await onStartOver();
    } catch (error) {
      logger.error('[allo] starting over after revocation failed', error);
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [onStartOver]);

  return (
    <View style={styles.container} accessibilityRole="summary">
      <Text style={styles.title}>{t('enrollment.revoked.title', 'This device was removed')}</Text>
      <Text style={styles.body}>
        {t(
          'enrollment.revoked.body',
          'Another of your devices removed this one from your account. Its keys are gone. You can start over, which enrols it again as a new device.',
        )}
      </Text>
      {failure ? <Text style={styles.error}>{failure}</Text> : null}
      <TouchableOpacity
        onPress={() => {
          void startOver();
        }}
        disabled={busy}
        style={[styles.primaryButton, busy && styles.disabled]}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
      >
        {busy ? <ActivityIndicator color={styles.primaryButtonText.color} /> : <Text style={styles.primaryButtonText}>{t('enrollment.revoked.startOver', 'Start over')}</Text>}
      </TouchableOpacity>
      {onSignOut ? (
        <TouchableOpacity onPress={onSignOut} style={styles.secondaryButton} accessibilityRole="button">
          <Text style={styles.secondaryButtonText}>{t('settings.signOut', 'Sign out')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function useGateStyles() {
  const theme = useTheme();
  return useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 32,
          gap: 16,
          backgroundColor: theme.colors.background,
        },
        spinner: { color: theme.colors.primary },
        title: {
          fontSize: 22,
          fontWeight: '700',
          textAlign: 'center',
          color: theme.colors.text,
        },
        body: {
          fontSize: 15,
          lineHeight: 22,
          textAlign: 'center',
          color: theme.colors.textSecondary,
        },
        detail: {
          fontSize: 14,
          color: theme.colors.textSecondary,
        },
        fingerprint: {
          fontSize: 24,
          fontWeight: '700',
          letterSpacing: 2,
          fontVariant: ['tabular-nums'],
          color: theme.colors.text,
          paddingVertical: 12,
          paddingHorizontal: 20,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.backgroundSecondary,
        },
        error: {
          fontSize: 13,
          textAlign: 'center',
          color: theme.colors.error,
        },
        primaryButton: {
          minWidth: 200,
          paddingVertical: 14,
          paddingHorizontal: 24,
          borderRadius: 24,
          alignItems: 'center',
          backgroundColor: theme.colors.primary,
        },
        primaryButtonText: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.colors.background,
        },
        secondaryButton: {
          paddingVertical: 12,
          paddingHorizontal: 24,
        },
        secondaryButtonText: {
          fontSize: 15,
          fontWeight: '500',
          color: theme.colors.primary,
        },
        disabled: { opacity: 0.6 },
      }),
    [theme],
  );
}
