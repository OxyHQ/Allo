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
import React, { useEffect, useRef, useState } from 'react';
import { useOxy } from '@oxy.so/services';
import type { AlloClient } from '@allo/core';
import { AlloProvider, useAlloClient, useInstanceState } from '@allo/react';
import { logger } from '@/utils/logger';
import { createAppAlloClient } from './client';
import { EnrollmentGate } from './EnrollmentGate';
import { onPushPermissionGranted, registerPushToken } from './push';
import { RestoreHistoryPrompt } from './RestoreHistoryPrompt';
import { signOutOfAllo } from './signOut';

interface Held {
  accountId: string;
  client: AlloClient;
}

export function AlloRoot({ children }: { children: React.ReactNode }) {
  const { user, isLoading, oxyServices, logout } = useOxy();
  const accountId = user?.id ?? null;
  const [client, setClient] = useState<AlloClient | null>(null);
  const held = useRef<Held | null>(null);
  // Read through a ref so a re-created services object does not rebuild the client.
  const oxyRef = useRef(oxyServices);
  oxyRef.current = oxyServices;

  useEffect(() => {
    // Until the session is known, `accountId === null` means "not yet", not "signed out".
    if (isLoading) return;
    const previous = held.current;
    if (previous && previous.accountId === accountId) return;

    if (previous) {
      held.current = null;
      setClient(null);
      // Stopped in both cases — an account switch and a session that is not
      // there right now are the same thing to this device's keys.
      previous.client.stop().catch((error: unknown) => logger.warn('[allo] retiring the previous client failed', error));
    }
    if (accountId === null) return;

    let cancelled = false;
    createAppAlloClient({ oxy: oxyRef.current })
      .then(async (next) => {
        if (cancelled) return;
        held.current = { accountId, client: next };
        setClient(next);
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
  }, [accountId, isLoading]);

  if (accountId === null) return <>{children}</>;
  if (client === null) return null;
  return (
    <AlloProvider client={client}>
      <PushRegistration />
      <EnrollmentGate
        onSignOut={() => {
          void signOutOfAllo(client, logout);
        }}
      >
        {children}
        {/* Asked once of a fresh device whose account has a backup; never holds boot. */}
        <RestoreHistoryPrompt />
      </EnrollmentGate>
    </AlloProvider>
  );
}

/** Registers the push token once the instance is active, and again when permission is granted later. */
function PushRegistration() {
  const client = useAlloClient();
  const { state } = useInstanceState();
  useEffect(() => {
    if (state !== 'active') return;
    void registerPushToken(client);
    return onPushPermissionGranted(() => {
      void registerPushToken(client);
    });
  }, [client, state]);
  return null;
}
