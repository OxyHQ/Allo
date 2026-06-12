/**
 * Interop bridge (F3.x) — Telegram (and future networks) link-flow state machine.
 *
 * Drives the multi-step connect flow the connected-accounts screen renders:
 *   idle → choose method
 *     ├─ qr:    start → show login URL → poll status until `active` (or fail)
 *     └─ phone: start({phoneNumber}) → enter code → (optional) 2FA password → `active`
 *
 * Every network call is proxied by the backend to the bridge connector. Codes and
 * passwords are submitted straight through and never stored. Status is polled via
 * React Query (no `useEffect` polling) only while a QR login is in flight; the
 * poll STOPS on any terminal state and after a hard attempt cap.
 *
 * Two DISTINCT enums are in play (see shared-types `interop.ts`):
 *  - `BridgeLinkStatus` — the synchronous link-STEP result
 *    (`pending | needs_code | needs_password | active | error`).
 *  - `LinkedAccountStatus` — the persisted/async session lifecycle returned by the
 *    status poll (`pending_login | active | expired | revoked | error`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Network, BridgeLinkStepResult } from '@allo/shared-types';
import {
  startLink,
  submitLinkCode,
  submitLinkPassword,
  getLinkStatus,
  type LinkedAccountStatus,
} from '@/lib/bridge/api';
import { bridgeQueryKeys } from '@/hooks/useBridge';

/** The login method chosen by the user. */
export type LinkMethod = 'qr' | 'phone';

/** Discrete UI step the link flow is currently on. */
export type LinkStep =
  | 'idle'
  | 'choose_method'
  | 'qr_pending'
  | 'qr_failed'
  | 'phone_number'
  | 'phone_code'
  | 'phone_password'
  | 'completed';

/** How often to poll link status while a QR login is awaiting confirmation. */
const STATUS_POLL_INTERVAL_MS = 2500;

/**
 * Hard cap on QR status polls (~60 × 2.5s ≈ 2.5 min). Once hit, the poll stops
 * and the flow surfaces a retryable error rather than polling forever.
 */
export const MAX_STATUS_POLLS = 60;

/** Persisted statuses that mean the QR login can never complete (terminal failure). */
export const TERMINAL_FAILURE_STATUSES: ReadonlySet<LinkedAccountStatus> = new Set([
  'expired',
  'revoked',
  'error',
]);

/**
 * Whether a QR status poll should keep running, given the latest persisted status
 * and how many polls have already completed. Stops on success (`active`), any
 * terminal failure, or the attempt cap. Exported for testing the stop contract.
 */
export function shouldContinuePolling(
  status: LinkedAccountStatus | null,
  pollCount: number
): boolean {
  if (status === 'active') return false;
  if (status && TERMINAL_FAILURE_STATUSES.has(status)) return false;
  if (pollCount >= MAX_STATUS_POLLS) return false;
  return true;
}

/**
 * Map a synchronous connector link-STEP result onto our UI step. The connector is
 * the source of truth; `status` is the canonical `BridgeLinkStatus` enum.
 * Exported for testing the status→step mapping contract.
 */
export function nextStepFromResult(method: LinkMethod, result: BridgeLinkStepResult): LinkStep {
  switch (result.status) {
    case 'active':
      return 'completed';
    case 'needs_password':
      return 'phone_password';
    case 'needs_code':
      return 'phone_code';
    case 'error':
      // A failed step on the QR path returns to its error view; on the phone path
      // the caller surfaces the inline error and keeps the current input step.
      return method === 'qr' ? 'qr_failed' : 'phone_code';
    case 'pending':
    default:
      return method === 'qr' ? 'qr_pending' : 'phone_code';
  }
}

export interface BridgeLinkFlow {
  step: LinkStep;
  method: LinkMethod | null;
  /** QR-mode login URL (e.g. `tg://login?token=…`) to open/copy. */
  loginUrl: string | undefined;
  /** True while any link request is in flight. */
  isSubmitting: boolean;
  /** Last error from a link step (i18n key under `bridge.telegram.*`). */
  error: string | null;
  // --- transitions ---
  begin: () => void;
  cancel: () => void;
  chooseMethod: (method: LinkMethod) => Promise<void>;
  submitPhone: () => Promise<void>;
  phoneNumber: string;
  setPhoneNumber: (value: string) => void;
  submitCode: (code: string) => Promise<void>;
  submitPassword: (password: string) => Promise<void>;
  /** Retry the QR flow after a timeout/terminal failure. */
  retryQr: () => Promise<void>;
}

/**
 * Manage the connect flow for one network. `onLinked` fires once the account
 * reaches `active` (the screen uses it to refresh the accounts query and close
 * the flow).
 */
export function useBridgeLinkFlow(network: Network, onLinked: () => void): BridgeLinkFlow {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<LinkStep>('idle');
  const [method, setMethod] = useState<LinkMethod | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | undefined>(undefined);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);

  const markLinked = useCallback(() => {
    setStep('completed');
    void queryClient.invalidateQueries({ queryKey: bridgeQueryKeys.accounts });
    onLinked();
  }, [queryClient, onLinked]);

  /** Move the QR flow into its retryable failure state with an i18n error key. */
  const failQr = useCallback((errorKey: string) => {
    setError(errorKey);
    setStep('qr_failed');
  }, []);

  // Poll link status ONLY while a QR login is pending. The poll STOPS (sets
  // `refetchInterval` false) on every terminal outcome — success, terminal
  // failure, or the attempt cap — and `enabled` flips false on unmount / when the
  // step leaves `qr_pending`, so React Query cancels the interval automatically.
  const statusQuery = useQuery({
    queryKey: ['bridge', 'linkStatus', network],
    queryFn: async (): Promise<LinkedAccountStatus | null> => {
      const status = await getLinkStatus(network);
      // Count each completed poll so the cap can be enforced in `refetchInterval`.
      setPollCount((count) => count + 1);
      return status;
    },
    enabled: step === 'qr_pending',
    refetchInterval: (query): number | false =>
      shouldContinuePolling(query.state.data ?? null, pollCount)
        ? STATUS_POLL_INTERVAL_MS
        : false,
    gcTime: 0,
  });

  // React to the polled status to drive QR terminal transitions. This syncs UI
  // state to an external async source (the connector's session lifecycle), which
  // is a legitimate effect — and keeps `setState` out of render (`select`).
  const polledStatus = step === 'qr_pending' ? statusQuery.data ?? null : null;
  useEffect(() => {
    if (step !== 'qr_pending') return;
    if (polledStatus === 'active') {
      markLinked();
    } else if (polledStatus && TERMINAL_FAILURE_STATUSES.has(polledStatus)) {
      failQr('linkExpired');
    } else if (pollCount >= MAX_STATUS_POLLS) {
      failQr('linkTimeout');
    }
  }, [step, polledStatus, pollCount, markLinked, failQr]);

  const startMutation = useMutation({
    mutationFn: (vars: { phoneNumber?: string }) => startLink(network, vars.phoneNumber),
  });
  const codeMutation = useMutation({ mutationFn: (code: string) => submitLinkCode(network, code) });
  const passwordMutation = useMutation({
    mutationFn: (password: string) => submitLinkPassword(network, password),
  });

  const isSubmitting =
    startMutation.isPending || codeMutation.isPending || passwordMutation.isPending;

  const begin = useCallback(() => {
    setError(null);
    setMethod(null);
    setLoginUrl(undefined);
    setPhoneNumber('');
    setPollCount(0);
    setStep('choose_method');
  }, []);

  const cancel = useCallback(() => {
    setError(null);
    setMethod(null);
    setLoginUrl(undefined);
    setPollCount(0);
    setStep('idle');
  }, []);

  const applyResult = useCallback(
    (chosen: LinkMethod, result: BridgeLinkStepResult) => {
      if (result.loginUrl) setLoginUrl(result.loginUrl);
      if (result.status === 'error') {
        // Surface the connector error; on QR show the retry view, on phone keep input.
        setError(chosen === 'qr' ? 'linkStartError' : 'codeError');
        setStep(chosen === 'qr' ? 'qr_failed' : 'phone_code');
        return;
      }
      const next = nextStepFromResult(chosen, result);
      if (next === 'completed') {
        markLinked();
      } else {
        setStep(next);
      }
    },
    [markLinked]
  );

  /** Begin the QR login: ask the connector for a login URL, then poll status. */
  const startQr = useCallback(async () => {
    setError(null);
    setPollCount(0);
    try {
      const result = await startMutation.mutateAsync({});
      applyResult('qr', result);
    } catch {
      failQr('linkStartError');
    }
  }, [startMutation, applyResult, failQr]);

  const chooseMethod = useCallback(
    async (chosen: LinkMethod) => {
      setError(null);
      setMethod(chosen);
      if (chosen === 'phone') {
        // Phone mode collects the number first; the connector is contacted on submit.
        setStep('phone_number');
        return;
      }
      await startQr();
    },
    [startQr]
  );

  const retryQr = useCallback(async () => {
    setMethod('qr');
    setStep('qr_pending');
    await startQr();
  }, [startQr]);

  const submitPhone = useCallback(async () => {
    const trimmed = phoneNumber.trim();
    if (trimmed.length === 0) {
      setError('missingPhone');
      return;
    }
    setError(null);
    try {
      // The backend forwards the body verbatim; the connector texts a code and
      // replies asking for it (`needs_code`).
      const result = await startMutation.mutateAsync({ phoneNumber: trimmed });
      applyResult('phone', result);
    } catch {
      setError('linkStartError');
    }
  }, [phoneNumber, startMutation, applyResult]);

  const submitCode = useCallback(
    async (code: string) => {
      if (code.trim().length === 0) {
        setError('missingCode');
        return;
      }
      setError(null);
      try {
        const result = await codeMutation.mutateAsync(code.trim());
        applyResult('phone', result);
      } catch {
        setError('codeError');
      }
    },
    [codeMutation, applyResult]
  );

  const submitPassword = useCallback(
    async (password: string) => {
      if (password.length === 0) {
        setError('missingPassword');
        return;
      }
      setError(null);
      try {
        const result = await passwordMutation.mutateAsync(password);
        applyResult('phone', result);
      } catch {
        setError('passwordError');
      }
    },
    [passwordMutation, applyResult]
  );

  return useMemo(
    () => ({
      step,
      method,
      loginUrl,
      isSubmitting,
      error,
      begin,
      cancel,
      chooseMethod,
      submitPhone,
      phoneNumber,
      setPhoneNumber,
      submitCode,
      submitPassword,
      retryQr,
    }),
    [
      step,
      method,
      loginUrl,
      isSubmitting,
      error,
      begin,
      cancel,
      chooseMethod,
      submitPhone,
      phoneNumber,
      submitCode,
      submitPassword,
      retryQr,
    ]
  );
}
