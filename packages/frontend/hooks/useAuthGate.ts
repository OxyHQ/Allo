import { useCallback, useEffect, useRef, useState } from 'react';
import { useOxy } from '@oxyhq/services';

/**
 * Time we wait after the SDK reports storage + token are ready but the user is
 * still unauthenticated, before treating "unauthenticated" as the final answer.
 *
 * The Oxy SDK has a ~1-frame window during cold start where `isStorageReady`
 * and `isTokenReady` are both `true` *before* the session-restore effect runs
 * (which then flips `isTokenReady` back to `false` while it validates). Without
 * this debounce we would briefly resolve to "logged out" and flash the welcome
 * screen for users who actually have a valid session.
 */
const AUTH_RESOLVE_DEBOUNCE_MS = 400;

/**
 * Hard cap on how long we keep the splash up waiting for auth to resolve. The
 * SDK's own network validation uses an 8s timeout, so by this point either the
 * session validated (`isAuthenticated` true) or it failed (token ready, user
 * null) — we should never keep the user staring at a spinner longer than this.
 */
const AUTH_RESOLVE_TIMEOUT_MS = 8000;

export interface AuthGateState {
  /** Whether the current user is authenticated. Mirrors `useOxy().isAuthenticated`. */
  isAuthenticated: boolean;
  /**
   * `true` once we are confident the auth state is final and the correct
   * screen (chat vs. welcome) can be shown without risk of a flash.
   */
  isResolved: boolean;
}

/**
 * Single source of truth for "has the auth state settled?".
 *
 * Resolution rules:
 * - If authenticated → resolved immediately.
 * - If storage + token are ready but unauthenticated → resolve after a short
 *   debounce, cancelled if `isTokenReady` flips back to `false` (which means
 *   the restore/validation cycle started and we should keep waiting).
 * - As a safety net, always resolve after {@link AUTH_RESOLVE_TIMEOUT_MS}.
 *
 * Deliberately does NOT use `isLoading`: it initializes to `false` and is not a
 * reliable session-restore signal.
 */
export function useAuthGate(): AuthGateState {
  const { isAuthenticated, isStorageReady, isTokenReady } = useOxy();
  const [isResolved, setIsResolved] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of `isResolved` so the mount-once hard-cap timer can read the latest
  // value without re-arming on every change.
  const resolvedRef = useRef(false);

  const resolve = useCallback(() => {
    resolvedRef.current = true;
    setIsResolved(true);
  }, []);

  // Authenticated is always an immediate, unambiguous resolution.
  useEffect(() => {
    if (isAuthenticated && !isResolved) {
      resolve();
    }
  }, [isAuthenticated, isResolved, resolve]);

  // Debounced "logged out" resolution. Only arm the timer once the SDK has
  // finished reading storage and reports a ready token while still showing no
  // user — i.e. the suspicious 1-frame window. If `isTokenReady` flips false
  // (restore started) we clear the timer and wait for the real outcome.
  useEffect(() => {
    if (isResolved || isAuthenticated) {
      return;
    }

    if (isStorageReady && isTokenReady) {
      debounceRef.current = setTimeout(() => {
        resolve();
      }, AUTH_RESOLVE_DEBOUNCE_MS);

      return () => {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
      };
    }

    return undefined;
  }, [isResolved, isAuthenticated, isStorageReady, isTokenReady, resolve]);

  // Hard cap so we never block the UI indefinitely on a stuck SDK. Mount-once
  // timer: it reads `resolvedRef` on fire so it never needs to re-arm, and is
  // cleared on unmount.
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!resolvedRef.current) {
        resolve();
      }
    }, AUTH_RESOLVE_TIMEOUT_MS);

    return () => clearTimeout(timeout);
  }, [resolve]);

  return { isAuthenticated, isResolved };
}
