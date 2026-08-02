import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  BridgeApiError,
  cancelBridgeLink,
  pollBridgeLink,
  startBridgeLink,
  submitBridgeLinkStep,
} from '@/lib/bridges/api';
import { isWaitingPoll, type BridgeLinkState } from '@/lib/bridges/contract';
import { bridgeQueryKeys } from '@/hooks/useBridges';

/**
 * One login attempt against one network, from the first step to the account it
 * produces (`docs/matrix/bridges.md` §5.2).
 *
 * ## The shape of the problem
 *
 * A bridge login is a server-driven state machine: the app does not know how many
 * steps there are, what they ask for, or which one comes next. It renders the
 * step it was handed, sends an answer, and is handed another. That is why nothing
 * here enumerates Telegram's phone-then-code or WhatsApp's QR — those live in the
 * bridge, and a client that encoded them would break on a bridge release.
 *
 * ## Two ways a step advances, and only one of them is a request the user made
 *
 * `user_input` advances because somebody pressed a button: a mutation.
 *
 * `display_and_wait` advances because something happened elsewhere — a QR was
 * scanned on another phone. The backend holds a blocking call open against the
 * bridge and answers either with the next step or with "still waiting" when its
 * own timeout elapses, and the app asks again. A timeout is not a failure.
 *
 * ## Why the advance is not an Effect
 *
 * The poll is a query, and the step it delivers is adopted by adjusting state
 * *during render* — React's documented pattern for "a value derived from data
 * that has changed", which re-renders before committing and never paints the
 * stale value. An Effect would paint the previous step for one frame, and on a QR
 * screen that frame is a code the user might try to scan.
 *
 * It cannot be a plain derivation either, and the reason is specific: once a step
 * arrives, the polling stops, and a LATER poll would answer "waiting" again —
 * `awaitStep` only advances a session whose current step is still
 * `display_and_wait`. Deriving the step from the newest poll would therefore
 * throw away the step that ended the wait. So the newest step is remembered, and
 * "waiting" answers are ignored rather than adopted.
 */

export interface BridgeLinkAttempt {
  /** The attempt in flight, or `undefined` before it starts and after it is cancelled. */
  readonly attempt: BridgeLinkState | undefined;
  readonly isStarting: boolean;
  readonly isSubmitting: boolean;
  /**
   * The last failure, or `undefined`.
   *
   * Kept as the typed error so a screen can tell `link_expired` — start again —
   * from `FI.MAU.TELEGRAM.PHONE_CODE_INVALID` — correct the field and resend —
   * from `bridge_unreachable`, which is nobody's input and not worth retrying in
   * place.
   */
  readonly error: BridgeApiError | undefined;
  start(input: { flowId: string; phoneNumberHint?: string }): void;
  submit(values: Record<string, string>): void;
  /** Abandons the attempt. Best-effort on the server; always effective locally. */
  cancel(): void;
}

export function useBridgeLinkAttempt(networkId: string): BridgeLinkAttempt {
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState<BridgeLinkState | undefined>(undefined);
  const [failure, setFailure] = useState<BridgeApiError | undefined>(undefined);

  const linkId = attempt?.linkId;
  const waitingOnDisplay = attempt?.step.type === 'display_and_wait';

  const poll = useQuery({
    queryKey: ['bridges', 'link', linkId ?? ''],
    queryFn: () => pollBridgeLink(linkId ?? ''),
    enabled: linkId !== undefined && waitingOnDisplay,
    /**
     * The request itself blocks server-side for as long as the backend's own
     * timeout allows, so this is the pause between long-polls and not a poll
     * interval in the usual sense. Short, because the gap is dead time during
     * which a scanned QR has already been accepted and the user is looking at a
     * spinner.
     */
    refetchInterval: 500,
    /** A step that has been consumed must never be replayed into a later attempt. */
    gcTime: 0,
    retry: false,
  });

  /**
   * Adopt a delivered step, during render. See the header for why this is not an
   * Effect and not a derivation.
   */
  const [adopted, setAdopted] = useState<unknown>(undefined);
  if (poll.data !== undefined && poll.data !== adopted) {
    setAdopted(poll.data);
    if (!isWaitingPoll(poll.data)) {
      setAttempt(poll.data);
      setFailure(undefined);
    }
  }

  /** The poll's own failures are the attempt's failures — an expiry arrives here. */
  const [adoptedError, setAdoptedError] = useState<unknown>(undefined);
  if (poll.error !== null && poll.error !== adoptedError) {
    setAdoptedError(poll.error);
    setFailure(asBridgeApiError(poll.error));
  }

  const invalidateAccounts = () => {
    void queryClient.invalidateQueries({ queryKey: bridgeQueryKeys.accounts });
  };

  const startMutation = useMutation({
    mutationFn: startBridgeLink,
    onSuccess: (state) => {
      setAttempt(state);
      setFailure(undefined);
      if (state.step.type === 'complete') invalidateAccounts();
    },
    onError: (error: unknown) => setFailure(asBridgeApiError(error)),
  });

  const submitMutation = useMutation({
    mutationFn: (values: Record<string, string>) =>
      submitBridgeLinkStep(linkId ?? '', values),
    onSuccess: (state) => {
      setAttempt(state);
      setFailure(undefined);
      if (state.step.type === 'complete') invalidateAccounts();
    },
    onError: (error: unknown) => setFailure(asBridgeApiError(error)),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelBridgeLink(id),
    /**
     * The local record closes either way. A server that could not be told to
     * cancel must not leave the user staring at an attempt they cannot get rid
     * of; the bridge's own login process expires on its own.
     */
    onSettled: () => {
      setAttempt(undefined);
      setFailure(undefined);
    },
  });

  return {
    attempt,
    isStarting: startMutation.isPending,
    isSubmitting: submitMutation.isPending,
    error: failure,
    start: (input) =>
      startMutation.mutate({
        networkId,
        flowId: input.flowId,
        ...(input.phoneNumberHint ? { phoneNumberHint: input.phoneNumberHint } : {}),
      }),
    submit: (values) => {
      if (linkId === undefined) return;
      submitMutation.mutate(values);
    },
    cancel: () => {
      if (linkId === undefined) {
        setAttempt(undefined);
        setFailure(undefined);
        return;
      }
      cancelMutation.mutate(linkId);
    },
  };
}

function asBridgeApiError(error: unknown): BridgeApiError {
  if (error instanceof BridgeApiError) return error;
  return new BridgeApiError(
    error instanceof Error ? error.message : 'The link attempt failed',
    'bridge_request_failed',
    undefined,
  );
}
