import { CallNotice } from '@/components/calls/CallNotice';
import { CallAudio } from '@/components/calls/CallAudio';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { startNativeCalls } from './nativeCalls';
import { nativeCallBridge } from './nativeCallBridge';
/**
 * OWNS THE CLIENT'S LIFECYCLE and mounts `@allo/react`'s provider under the
 * Oxy provider.
 *
 * One `AlloClient` per signed-in account:
 *
 * - The Oxy session resolves to an account → a client is built with the
 *   platform adapters (`client.ts`) and started. The store it opens is
 *   namespaced by account inside core, so two accounts on one device never
 *   read each other's rows.
 * - The account CHANGES (Oxy's account switcher) → the old client is stopped
 *   and a new one built. Stopped, not reset: switching back later reopens the
 *   same enrolled instance and the same history.
 * - The account goes AWAY → the old client is STOPPED, and keeps every key.
 *
 * That last one is the rule, not an omission. A missing account here does not
 * mean somebody signed out: Oxy clears the bearer on an unrecoverable 401 and
 * reports a locally signed-out session while keeping the stored one, because
 * it expects to restore it. Wiping the device on that signal revoked nothing
 * (the revoke needs the bearer that just went) and left an active instance on
 * the account that no device could prove it owned — which is what turned a
 * page reload into "approve this device", permanently. Leaving is a
 * deliberate act and goes through `signOutOfAllo` (`lib/allo/signOut.ts`),
 * which resets while the session is still alive.
 *
 * Between "signed in" and "client ready" nothing is rendered rather than the
 * app: a screen mounted without a provider would throw on its first hook.
 *
 * Boot-mounted, so no suspenseful hook is called here (see
 * `docs/frontend-conventions.md`); the gate screens follow the same rule.
 */
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';
import { useSupervision } from '@oxy.so/services/ui';
import { MessagingSupervisionContext } from './MessagingSupervision';
import { configurePeople } from './people';
import { ConversationAccessState } from './ConversationAccessState';
import type { AlloClient } from '@allo/core';
import { AlloProvider, useAlloClient, useInstanceState } from '@allo/react';
import { logger } from '@/utils/logger';
import { createAppAlloClient } from './client';
import { EnrollmentGate } from './EnrollmentGate';
import { onPushPermissionGranted, registerPushToken } from './push';
import { RestoreHistoryPrompt } from './RestoreHistoryPrompt';
import { signOutOfAllo } from './signOut';

interface Held {
  key: string;
  accountId: string;
  client: AlloClient;
}

export function AlloRoot({ children }: { children: React.ReactNode }) {
  const { user, isLoading, oxyServices, logout, activeSessionId } = useOxy();
  const accountId = user?.id ?? null;
  const supervision = useSupervision();
  const personal = (user?.kind ?? 'personal') === 'personal';
  const known = !accountId || !personal || supervision.data !== undefined;
  const supervised =
    personal && Boolean(supervision.data?.self && supervision.data.self.status !== 'ended');
  const key = accountId && known ? JSON.stringify([accountId, activeSessionId, supervised]) : null;
  const [current, setCurrent] = useState<Held | null>(null);
  const held = useRef<Held | null>(null);
  const stopTail = useRef<Promise<void>>(Promise.resolve());
  // Read through a ref so a re-created services object does not rebuild the client.
  // Updated in an effect, never during render, and declared BEFORE the effect
  // that reads it, so it is already current when that one runs in the same commit.
  const oxyRef = useRef(oxyServices);
  useEffect(() => {
    oxyRef.current = oxyServices;
  }, [oxyServices]);

  useEffect(() => {
    // Until the session is known, `accountId === null` means "not yet", not "signed out".
    if (isLoading) return;
    const previous = held.current;
    if (previous && previous.key === key) return;
    configurePeople(!known ? 'unknown' : supervised ? 'supervised' : 'ordinary');

    if (previous) {
      held.current = null;
      setCurrent(null);
      // Stopped in both cases — an account switch and a session that is not
      // there right now are the same thing to this device's keys.
    }
    const stopped = stopTail.current.then(() => previous?.client.stop());
    stopTail.current = stopped;
    if (accountId === null || key === null) {
      void stopped.catch((error) =>
        logger.error('[allo] the previous client could not stop', error),
      );
      return;
    }

    let cancelled = false;
    stopped
      .then(() => createAppAlloClient({ oxy: oxyRef.current, supervised }))
      .then(async (next) => {
        if (cancelled) {
          await next.stop();
          return;
        }
        held.current = { key, accountId, client: next };
        setCurrent(held.current);
        try {
          await next.start();
        } catch (error) {
          // The gate shows the last error through `useInstanceState`; nothing to throw at React.
          logger.error('[allo] the client could not start', error);
        }
      })
      .catch((error: unknown) => logger.error('[allo] the client could not be built', error));
    return () => {
      cancelled = true;
    };
  }, [accountId, isLoading, key, known, supervised]);

  useEffect(
    () => () => {
      const previous = held.current;
      held.current = null;
      void previous?.client
        .stop()
        .catch((error) => logger.error('[allo] unmount could not stop the client', error));
    },
    [],
  );

  if (accountId === null) return <>{children}</>;
  if (!known)
    return (
      <ConversationAccessState
        state={supervision.isError ? 'unavailable' : 'checking'}
        onRetry={() => {
          void supervision.refetch();
        }}
      />
    );
  if (current === null || current.key !== key) return <ConversationAccessState state="checking" />;
  const client = current.client;
  return (
    <MessagingSupervisionContext.Provider value={supervised}>
      <AlloProvider client={client}>
        <PushRegistration />
        <CallAudio />
        <CallNotice />
        <EnrollmentGate
          onSignOut={() => {
            void signOutOfAllo(client, logout);
          }}
        >
          {children}
          {/* Asked once of a fresh device whose account has a backup; never holds boot. */}
          {!supervised && <RestoreHistoryPrompt />}
        </EnrollmentGate>
      </AlloProvider>
    </MessagingSupervisionContext.Provider>
  );
}

/** Registers the push token once the instance is active, and again when permission is granted later. */
function PushRegistration() {
  const client = useAlloClient();
  const { state } = useInstanceState();
  const router = useRouter();
  useEffect(() => {
    if (state !== 'active' || !nativeCallBridge) return;
    return startNativeCalls({
      client,
      bridge: nativeCallBridge,
      provider: Platform.OS === 'ios' ? 'apns' : 'fcm',
      open: (id, callId) =>
        router.push({ pathname: '/c/[id]/call', params: { id, incomingCallId: callId } }),
      report: (error) => logger.warn('[calls] native handoff failed', error),
    });
  }, [client, state, router]);
  useEffect(() => {
    if (state !== 'active') return;
    void registerPushToken(client);
    return onPushPermissionGranted(() => {
      void registerPushToken(client);
    });
  }, [client, state]);
  return null;
}
