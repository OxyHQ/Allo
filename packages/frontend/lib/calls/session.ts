/**
 * THE LIVE CALL, AS A SCREEN SEES IT.
 *
 * `@allo/core` owns the call: the state machine, the encrypted signalling and
 * the rule that an unauthenticated description ends it (ADR 0002, Decision 5).
 * This turns its `CallView` into the shape Bloom's `call-ui` family draws, the
 * way `lib/chat/model.ts` turns a `ConversationView` into a `ChatSummary` — a
 * projection, with no state and no decisions of its own.
 *
 * The one thing kept here is what the SDK has no business knowing: whether the
 * call is COLLAPSED to the pill and which corner the self-view sits in. Those
 * are properties of this screen on this device, not of the call, and putting
 * them in the SDK would sync a window position between somebody's phone and
 * their laptop.
 *
 * What this file deliberately does NOT invent: who is speaking, who is muted
 * on the other side, the speaker route, screen sharing and the camera's
 * facing. The platform reports none of it, so none of it is a field here — it
 * used to carry them as constants that could never change, which only meant
 * the screens had something false to pass on. Bloom draws a control when it is
 * given a HANDLER, so a control nothing can do is a prop nobody passes.
 *
 * Finished calls are `history.ts`. This is the one that is happening.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { CallPipCorner, CallStatus } from '@oxy.so/bloom/call-ui';
import { toast } from '@oxy.so/bloom/toast';
import { useCall } from '@allo/react';

import i18n from '@/lib/i18n';
import { formatCallDuration } from '@/lib/chat/format';
import { logger } from '@/utils/logger';

export type { CallPipCorner, CallStatus };

/**
 * A call action that failed. ONE policy, for every screen.
 *
 * There were three: the call screen logged, the log screen logged and
 * sometimes toasted, and the pill's `.catch(() => undefined)` swallowed it
 * whole — so a hang-up that failed from the pill left the pill on screen with
 * nothing said to the person and nothing written down for anyone else. Both,
 * always: the person is told, and the reason is in the log.
 *
 * `i18n.t` rather than the hook, because a `.catch` is not a render.
 */
export function reportCallError(error: unknown): void {
  logger.error('[calls] action failed', error);
  toast.error(i18n.t('calls.failed'));
}

/** One person on a live call, as the group grid draws them. */
export interface CallPeer {
  readonly accountId: string;
}

/** The one call this device is in, projected for the screens. */
export interface CallSession {
  readonly id: string;
  readonly conversationId: string;
  readonly peers: readonly CallPeer[];
  readonly mode: 'voice' | 'video';
  /** `true` when somebody called us. Decides which screen the route draws. */
  readonly incoming: boolean;
  /**
   * Where the call is. `CallView['phase']` unchanged: Bloom's `CallStatus` is
   * a superset of it, so there is nothing to translate — this used to go
   * through a twelve-line switch that returned its argument.
   */
  readonly status: CallStatus;
  readonly startedAt: number;
  /** When the media connected. Absent until then; the timer counts from it. */
  readonly connectedAt?: number;
  readonly muted: boolean;
  readonly videoOn: boolean;
  readonly minimised: boolean;
  readonly pipCorner: CallPipCorner;
}

interface CallUiState {
  minimised: boolean;
  pipCorner: CallPipCorner;
  setMinimised: (minimised: boolean) => void;
  setPipCorner: (corner: CallPipCorner) => void;
  reset: () => void;
}

/** Window state, which belongs to this screen on this device and nowhere else. */
export const useCallUi = create<CallUiState>((set) => ({
  minimised: false,
  pipCorner: 'top-right',
  setMinimised: (minimised) => set({ minimised }),
  setPipCorner: (pipCorner) => set({ pipCorner }),
  reset: () => set({ minimised: false, pipCorner: 'top-right' }),
}));

/** The live call, or `null`. One at a time, as a phone does. */
export function useCallSession(): CallSession | null {
  const call = useCall();
  const minimised = useCallUi((state) => state.minimised);
  const pipCorner = useCallUi((state) => state.pipCorner);
  return useMemo(() => {
    if (!call || call.phase === 'ended') return null;
    return {
      id: call.id,
      conversationId: call.conversationId,
      peers: call.withAccountIds.map((accountId: string) => ({ accountId })),
      mode: call.mode,
      incoming: !call.outgoing,
      status: call.phase,
      startedAt: Date.parse(call.startedAt),
      connectedAt: call.answeredAt ? Date.parse(call.answeredAt) : undefined,
      muted: call.muted,
      videoOn: call.cameraOn,
      minimised,
      pipCorner,
    };
  }, [call, minimised, pipCorner]);
}

/**
 * ONE clock for every consumer.
 *
 * The pill and the call screen are both mounted during a minimised call — the
 * pill for the whole app, the screen because expo-router keeps it in the stack
 * behind you — so an interval per hook meant two unsynchronised 1 Hz renders
 * of two subtrees for the length of the call. This is a single interval,
 * started when the first consumer appears and cleared when the last one goes.
 */
const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;

function subscribeToTick(listener: () => void): () => void {
  tickListeners.add(listener);
  if (!tickTimer) tickTimer = setInterval(() => { for (const l of [...tickListeners]) l(); }, 1000);
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}

const noTick = () => () => undefined;

/** The snapshot is WHOLE SECONDS, so a tick that would print the same string re-renders nothing. */
const secondNow = () => Math.floor(Date.now() / 1000);

/** How long the call has been connected, already formatted. `""` until it is. */
export function useCallDuration(session: CallSession | null): string {
  const connectedAt = session?.connectedAt;
  // No call, no clock: the pill calls this on every screen of the app.
  const second = useSyncExternalStore(connectedAt === undefined ? noTick : subscribeToTick, secondNow, secondNow);
  if (connectedAt === undefined) return '';
  return formatCallDuration(second * 1000 - connectedAt);
}
