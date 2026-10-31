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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useOxy, useSupervision } from '@oxy.so/services/ui/client';
import { MessagingSupervisionContext } from './MessagingSupervision';
import { useTransientRetry } from './transientRetry';
import { configurePeople } from './people';
import { ConversationAccessState } from './ConversationAccessState';
import { AlloProvider, useAlloClient, useInstanceState } from '@allo/react';
import { logger } from '@/utils/logger';
import { createAppAlloClient, type AppAlloClient } from './client';
import { EnrollmentGate } from './EnrollmentGate';
import { onPushPermissionGranted, registerPushToken } from './push';
import { RestoreHistoryPrompt } from './RestoreHistoryPrompt';
import { signOutOfAllo } from './signOut';

interface Held {
  key: string;
  accountId: string;
  client: AppAlloClient;
}

/** A `start()` that threw, tied to the client it belongs to so a newer client never shows it. */
interface StartFailure {
  client: AppAlloClient;
  error: Error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The last successful answer, and the account and session it was given for. */
interface Answer {
  session: string;
  supervised: boolean;
}

/**
 * Whether this account is supervised, as far as this device can say.
 *
 * `useSupervision()` hides its retained value after a FAILED fetch (ADR 0041
 * in the Oxy repo: the Supervision screen must not keep showing private
 * evidence after an authority error), so a re-check that fails — the app back
 * in the foreground offline, a timeout — reads `data: undefined`, exactly like
 * a session nobody has answered for yet. Taking that at face value stopped the
 * client (a live call, the socket, sync), drew "checking" and built a NEW
 * client once the next check landed.
 *
 * So the last successful answer is remembered for the account and session it
 * was given for, and stands through a failed re-check until a NEW successful
 * answer replaces it; only a changed value rebuilds the client (the key below).
 * What stays fail-closed:
 *
 * - no answer yet for THIS account and session (first load, a switch, a new
 *   session) is still unknown, and the app waits;
 * - the memory is used only while the hook reports an error; pending data for
 *   a session that came back is not the old answer (`sessionGap.test.tsx`);
 * - the account going away forgets it, so a returning session is asked afresh;
 * - an answer that now says "supervised" switches at once, because a fresh
 *   answer always wins over the memory.
 *
 * Per-conversation access for a supervised account is not this: every
 * transcript still asks the server before it opens (`ConversationReadGate`).
 */
function useSupervisionAnswer(
  accountId: string | null,
  activeSessionId: string | null | undefined,
  personal: boolean,
  supervision: { data?: { self?: { status: string } | null } | undefined; isError: boolean },
): { known: boolean; supervised: boolean } {
  const session = accountId === null ? null : JSON.stringify([accountId, activeSessionId ?? null]);
  const fresh =
    !personal || supervision.data === undefined
      ? undefined
      : Boolean(supervision.data.self && supervision.data.self.status !== 'ended');
  const [last, setLast] = useState<Answer | null>(null);
  // Stored during render, so the answer and the key agree in the same render.
  if (session === null || !personal) {
    if (last !== null) setLast(null);
  } else if (fresh !== undefined && (last?.session !== session || last.supervised !== fresh)) {
    setLast({ session, supervised: fresh });
  }
  if (accountId === null || !personal) return { known: true, supervised: false };
  const remembered = supervision.isError && last?.session === session ? last.supervised : undefined;
  const answer = fresh ?? remembered;
  return { known: answer !== undefined, supervised: answer ?? false };
}

export function AlloRoot({ children }: { children: React.ReactNode }) {
  const { user, isLoading, oxyServices, logout, activeSessionId } = useOxy();
  const accountId = user?.id ?? null;
  const [accountTransition, setAccountTransition] = useState(0);
  // Rebuild even when React batches an A -> B -> A bearer transition into one render.
  useLayoutEffect(() => {
    let previous = oxyServices.session.userId;
    return oxyServices.session.onChange(() => {
      const next = oxyServices.session.userId;
      if (next !== null && previous !== null && next !== previous) {
        setAccountTransition((revision) => revision + 1);
      }
      if (next !== null) previous = next;
    });
  }, [oxyServices]);
  const supervision = useSupervision();
  const { known, supervised } = useSupervisionAnswer(
    accountId,
    activeSessionId,
    (user?.kind ?? 'personal') === 'personal',
    supervision,
  );
  // A transient failure is asked again by itself before "cannot check access"
  // is drawn, and the screen recovers by itself once the device is back online.
  const supervisionFailure = useMemo(
    () =>
      supervision.isError ? { at: supervision.errorUpdatedAt, error: supervision.error } : null,
    [supervision.isError, supervision.errorUpdatedAt, supervision.error],
  );
  const { refetch: refetchSupervision } = supervision;
  const retrySupervision = useCallback(() => {
    void refetchSupervision();
  }, [refetchSupervision]);
  const supervisionGaveUp = useTransientRetry(supervisionFailure, retrySupervision);
  const key =
    accountId && known
      ? JSON.stringify([accountId, activeSessionId, supervised, accountTransition])
      : null;
  const [current, setCurrent] = useState<Held | null>(null);
  const [startFailure, setStartFailure] = useState<StartFailure | null>(null);
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
    const stopped = stopTail.current.then(() => previous?.client.dispose());
    stopTail.current = stopped;
    if (accountId === null || key === null) {
      void stopped.catch((error) =>
        logger.error('[allo] the previous client could not stop', error),
      );
      return;
    }

    let cancelled = false;
    stopped
      .then(() => createAppAlloClient({ oxy: oxyRef.current, accountId, supervised }))
      .then(async (next) => {
        if (cancelled) {
          await next.dispose();
          return;
        }
        held.current = { key, accountId, client: next };
        setCurrent(held.current);
        try {
          await next.start();
        } catch (error) {
          // The gate draws it (`EnrollmentGate`'s start-failure screen); nothing to throw at React.
          logger.error('[allo] the client could not start', error);
          if (held.current?.client === next)
            setStartFailure({ client: next, error: asError(error) });
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
        .dispose()
        .catch((error) => logger.error('[allo] unmount could not stop the client', error));
    },
    [],
  );

  const retryStart = useCallback(async () => {
    const client = held.current?.client;
    if (!client) return;
    setStartFailure(null);
    try {
      await client.start();
    } catch (error) {
      logger.error('[allo] the client could not start', error);
      if (held.current?.client === client) setStartFailure({ client, error: asError(error) });
    }
  }, []);

  if (accountId === null) return <>{children}</>;
  if (!known)
    return (
      <ConversationAccessState
        state={supervisionGaveUp ? 'unavailable' : 'checking'}
        onRetry={retrySupervision}
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
          startFailure={startFailure?.client === client ? startFailure.error : undefined}
          onRetryStart={retryStart}
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
