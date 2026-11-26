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
 * Unless `start()` FAILED. Then the shell would be a lie: every screen is
 * drawn, and every action ends in "client is not started". An Android build
 * without the platform CSPRNG did exactly that — the conversation list
 * rendered and "new chat" failed with no reason anywhere. A failed start
 * renders its own screen, with the error and a retry.
 *
 * The pending screen carries a SECOND way out, and it is not decoration.
 * "Waiting to be approved" assumes there is a device left that can approve,
 * and there need not be: a browser whose site data was cleared, a phone that
 * was lost, a device whose key did not survive — each leaves an instance the
 * account still calls active that nothing can sign for. Without a way past
 * it the account is finished, so "Use this device instead"
 * (`client.reclaimAccount()`) revokes those devices with the Oxy session and
 * registers this one into the empty account. It is destructive, it is behind
 * a confirmation that says what is lost, and it is the honest end of the
 * screen rather than a spinner that never stops.
 *
 * It is mounted at boot, so nothing here may suspend: `useTranslation` is
 * called with suspense off, and every string has an inline default.
 */
import { useAlloClient, useInstanceState } from '@allo/react';
import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { RiSmartphoneLine } from '@oxy.so/bloom/icons/RiSmartphoneLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import React, { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { logger } from '@/utils/logger';
import { confirm } from '@oxy.so/bloom/surfaces';

import {
  Button as LButton,
  Card as LCard,
  Embed,
  IconCircle as LIconCircle,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

export interface EnrollmentGateProps {
  children: React.ReactNode;
  /** Signs the account out of Oxy; the pending screen offers it as the way to give up. */
  onSignOut?: () => void;
  /** Why this client's `start()` failed; absent while it is starting or once it started. */
  startFailure?: Error;
  /** Runs `start()` again after a failure. */
  onRetryStart?: () => Promise<void>;
}

export function EnrollmentGate({
  children,
  onSignOut,
  startFailure,
  onRetryStart,
}: EnrollmentGateProps) {
  const { state, instance, error } = useInstanceState();
  const client = useAlloClient();

  if (startFailure && state === 'unregistered') {
    return (
      <StartFailedScreen
        errorMessage={startFailure.message}
        onRetry={onRetryStart}
        onSignOut={onSignOut}
      />
    );
  }
  if (state === 'pending-approval') {
    return (
      <PendingApprovalScreen
        deviceName={instance?.displayName}
        fingerprint={instance?.enrollment?.fingerprint}
        errorMessage={error?.message}
        onReclaim={() => client.reclaimAccount()}
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
  /** Takes the account over from devices that can no longer approve. Omitted, the action is not offered. */
  onReclaim?: () => Promise<void>;
  onSignOut?: () => void;
}

export function PendingApprovalScreen({
  deviceName,
  fingerprint,
  errorMessage,
  onReclaim,
  onSignOut,
}: PendingApprovalScreenProps) {
  const { t } = useTranslation(undefined, { useSuspense: false });
  const theme = useTheme();
  const [reclaiming, setReclaiming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const reclaim = useCallback(async () => {
    if (!onReclaim) return;
    const confirmed = await confirm({
      title: t('enrollment.reclaim.title', 'Use this device instead?'),
      description: t(
        'enrollment.reclaim.body',
        'Your other devices will be signed out, and messages kept only on them will be lost — this device cannot read what they hold. Do this only when you cannot reach a device that is already signed in.',
      ),
      confirmLabel: t('enrollment.reclaim.confirm', 'Use this device'),
      cancelLabel: t('common.cancel', 'Cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    setReclaiming(true);
    setFailure(null);
    try {
      await onReclaim();
    } catch (error) {
      logger.error('[allo] reclaiming the account failed', error);
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setReclaiming(false);
    }
  }, [onReclaim, t]);

  return (
    <GateFrame
      icon={toElement(LIconCircle(RiSmartphoneLine))}
      title={t('enrollment.pending.title', 'Approve this device')}
      description={t(
        'enrollment.pending.body',
        'Open Allo on a device that is already signed in, go to Settings, then Devices, and approve this one. That device shows a verification code for it; check the device name matches before you approve.',
      )}
    >
      {deviceName || fingerprint
        ? toElement(
            LCard(
              deviceName
                ? LText(deviceName).foreground('muted').font('body').weight('medium')
                : null,
              Embed(
                fingerprint ? (
                  <Text
                    variant="title-1-semibold"
                    style={styles.fingerprint}
                    accessibilityLabel={t('enrollment.fingerprint', 'Verification code')}
                    selectable
                  >
                    {fingerprint}
                  </Text>
                ) : null,
              ),
            )
              .radius('lg')
              .style('subtle')
              .padding('vertical', 'lg')
              .padding('horizontal', 'xl')
              .alignSelf('stretch')
              .align('center')
              .spacing('xs'),
          )
        : null}
      <ActivityIndicator color={theme.colors.primary} />
      {errorMessage ? <ErrorLine message={errorMessage} /> : null}
      {failure ? <ErrorLine message={failure} /> : null}
      {onReclaim
        ? toElement(
            LButton(LText(t('enrollment.reclaim.action', 'Use this device instead')))
              .loading(reclaiming)
              .onPress(() => {
                void reclaim();
              })
              .tint('neutral')
              .style('outline'),
          )
        : null}
      {onSignOut
        ? toElement(
            LButton(LText(t('settings.signOut', 'Sign out')))
              .onPress(onSignOut)
              .tint('accent')
              .style('plain'),
          )
        : null}
    </GateFrame>
  );
}

interface RevokedScreenProps {
  onStartOver: () => Promise<void>;
  onSignOut?: () => void;
}

export function RevokedScreen({ onStartOver, onSignOut }: RevokedScreenProps) {
  const { t } = useTranslation(undefined, { useSuspense: false });
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
    <GateFrame
      icon={toElement(LIconCircle(RiShieldLine))}
      title={t('enrollment.revoked.title', 'This device was removed')}
      description={t(
        'enrollment.revoked.body',
        'Another of your devices removed this one from your account. Its keys are gone. You can start over, which enrols it again as a new device.',
      )}
    >
      {failure ? <ErrorLine message={failure} /> : null}
      {toElement(
        LButton(LText(t('enrollment.revoked.startOver', 'Start over')))
          .size('lg')
          .loading(busy)
          .onPress(() => {
            void startOver();
          }),
      )}
      {onSignOut
        ? toElement(
            LButton(LText(t('settings.signOut', 'Sign out')))
              .onPress(onSignOut)
              .tint('accent')
              .style('plain'),
          )
        : null}
    </GateFrame>
  );
}

interface StartFailedScreenProps {
  errorMessage: string;
  onRetry?: () => Promise<void>;
  onSignOut?: () => void;
}

export function StartFailedScreen({ errorMessage, onRetry, onSignOut }: StartFailedScreenProps) {
  const { t } = useTranslation(undefined, { useSuspense: false });
  const [busy, setBusy] = useState(false);

  return (
    <GateFrame
      icon={toElement(LIconCircle(RiShieldLine))}
      title={t('enrollment.startFailed.title', "Allo couldn't start on this device")}
      description={t(
        'enrollment.startFailed.body',
        'Encrypted messaging did not open, so nothing can be sent or read yet. Your messages are not affected. Try again, and if it keeps happening, update Allo.',
      )}
    >
      <ErrorLine message={errorMessage} />
      {onRetry
        ? toElement(
            LButton(LText(t('enrollment.startFailed.retry', 'Try again')))
              .size('lg')
              .loading(busy)
              .onPress(() => {
                setBusy(true);
                // The failure, if it happens again, comes back through `errorMessage`.
                void onRetry().finally(() => setBusy(false));
              }),
          )
        : null}
      {onSignOut
        ? toElement(
            LButton(LText(t('settings.signOut', 'Sign out')))
              .onPress(onSignOut)
              .tint('accent')
              .style('plain'),
          )
        : null}
    </GateFrame>
  );
}

/**
 * A whole-screen status page: the icon, what happened, then what can be done
 * about it. Drawn from primitives rather than a chat-screen empty state, which
 * would pull the animation runtime into the boot path for a static page.
 */
function GateFrame({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return toElement(
    VStack(
      VStack(
        Embed(icon),
        Embed(
          <Text variant="title-2-semibold" accessibilityRole="header" style={styles.centered}>
            {title}
          </Text>,
        ),
        Embed(
          <Text
            variant="body-regular"
            style={[styles.centered, { color: theme.colors.textSecondary }]}
          >
            {description}
          </Text>,
        ),
        Embed(children),
      )
        .frame({ width: 'full', maxWidth: '400' })
        .align('center')
        .spacing('lg'),
    )
      .padding('all', '2xl')
      .background('background')
      .align('center')
      .justify('center')
      .grow()
      .role('summary'),
  );
}

function ErrorLine({ message }: { message: string }) {
  const theme = useTheme();
  return (
    <Text variant="body-2-regular" style={[styles.centered, { color: theme.colors.error }]}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  fingerprint: { letterSpacing: 2, fontVariant: ['tabular-nums'], textAlign: 'center' },
  centered: { textAlign: 'center' },
});
