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
import type React from 'react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from 'react-native';

import { logger } from '@/utils/logger';
import { confirm } from '@oxy.so/bloom/surfaces';

import {
  Button,
  type Child,
  Embed,
  IconCircle,
  Text,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { Card } from '@oxy.so/bloom-language/containers';

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

  return toElement(
    gateFrame(
      IconCircle(RiSmartphoneLine),
      t('enrollment.pending.title', 'Approve this device'),
      t(
        'enrollment.pending.body',
        'Open Allo on a device that is already signed in, go to Settings, then Devices, and approve this one. That device shows a verification code for it; check the device name matches before you approve.',
      ),
      deviceName || fingerprint
        ? Card(
            deviceName ? Text(deviceName).foreground('muted').font('body').weight('medium') : null,
            fingerprint
              ? Text(fingerprint)
                  .font('title-1')
                  .weight('semibold')
                  .tracking('2px')
                  .monospacedDigit()
                  .textAlign('center')
                  .selectable()
                  .label(t('enrollment.fingerprint', 'Verification code'))
              : null,
          )
            .radius('lg')
            .style('subtle')
            .padding('vertical', 'lg')
            .padding('horizontal', 'xl')
            .alignSelf('stretch')
            .align('center')
            .spacing('xs')
        : null,
      Embed(<ActivityIndicator color={theme.colors.primary} />),
      errorMessage ? errorLine(errorMessage) : null,
      failure ? errorLine(failure) : null,
      onReclaim
        ? Button(Text(t('enrollment.reclaim.action', 'Use this device instead')))
            .loading(reclaiming)
            .onPress(() => {
              void reclaim();
            })
            .tint('neutral')
            .style('outline')
        : null,
      onSignOut ? signOutButton(t('settings.signOut', 'Sign out'), onSignOut) : null,
    ),
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

  return toElement(
    gateFrame(
      IconCircle(RiShieldLine),
      t('enrollment.revoked.title', 'This device was removed'),
      t(
        'enrollment.revoked.body',
        'Another of your devices removed this one from your account. Its keys are gone. You can start over, which enrols it again as a new device.',
      ),
      failure ? errorLine(failure) : null,
      Button(Text(t('enrollment.revoked.startOver', 'Start over')))
        .size('lg')
        .loading(busy)
        .onPress(() => {
          void startOver();
        }),
      onSignOut ? signOutButton(t('settings.signOut', 'Sign out'), onSignOut) : null,
    ),
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

  return toElement(
    gateFrame(
      IconCircle(RiShieldLine),
      t('enrollment.startFailed.title', "Allo couldn't start on this device"),
      t(
        'enrollment.startFailed.body',
        'Encrypted messaging did not open, so nothing can be sent or read yet. Your messages are not affected. Try again, and if it keeps happening, update Allo.',
      ),
      errorLine(errorMessage),
      onRetry
        ? Button(Text(t('enrollment.startFailed.retry', 'Try again')))
            .size('lg')
            .loading(busy)
            .onPress(() => {
              setBusy(true);
              // The failure, if it happens again, comes back through `errorMessage`.
              void onRetry().finally(() => setBusy(false));
            })
        : null,
      onSignOut ? signOutButton(t('settings.signOut', 'Sign out'), onSignOut) : null,
    ),
  );
}

/**
 * A whole-screen status page: the icon, what happened, then what can be done
 * about it. Drawn from primitives rather than a chat-screen empty state, which
 * would pull the animation runtime into the boot path for a static page.
 */
function gateFrame(icon: Child, title: string, description: string, ...actions: Child[]) {
  return VStack(
    VStack(
      icon,
      Text(title).font('title-2').weight('semibold').role('header').textAlign('center'),
      Text(description).font('body').foreground('muted').textAlign('center'),
      ...actions,
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
    .role('summary');
}

function errorLine(message: string) {
  return Text(message).font('body-2').foreground('error').textAlign('center');
}

function signOutButton(label: string, onSignOut: () => void) {
  return Button(Text(label)).onPress(onSignOut).tint('accent').style('plain');
}
