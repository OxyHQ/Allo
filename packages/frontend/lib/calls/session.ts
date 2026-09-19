/**
 * THE LIVE CALL, AS A SCREEN SEES IT.
 *
 * `@allo/core` owns the call: the state machine, the encrypted signalling and
 * the DTLS fingerprint (ADR 0002, Decision 5). This turns its `CallView` into
 * the shape Bloom's `call-ui` family draws, the way `lib/chat/model.ts` turns
 * a `ConversationView` into a `ChatSummary` — a projection, with no state and
 * no decisions of its own.
 *
 * The one thing kept here is what the SDK has no business knowing: whether the
 * call is COLLAPSED to the pill and which corner the self-view sits in. Those
 * are properties of this screen on this device, not of the call, and putting
 * them in the SDK would sync a window position between somebody's phone and
 * their laptop.
 *
 * What this file deliberately does NOT invent: who is speaking, who is muted
 * on the other side, screen sharing, and the camera's facing. The platform
 * reports none of it yet, so the fields stay at their honest defaults rather
 * than drawing a dot that means nothing.
 */
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import type { CallPipCorner, CallStatus } from '@oxy.so/bloom/call-ui';
import { useCall, useCallHistory } from '@allo/react';
import type { CallView } from '@allo/core';
import type { CallDirection } from '@oxy.so/bloom/call-ui';

export type { CallPipCorner, CallStatus };

/** One person on a live call, as the group grid draws them. */
export interface CallPeer {
  readonly accountId: string;
  readonly muted?: boolean;
  readonly speaking?: boolean;
  readonly presenting?: boolean;
}

/** The one call this device is in, projected for the screens. */
export interface CallSession {
  readonly id: string;
  readonly conversationId: string;
  readonly peers: readonly CallPeer[];
  readonly mode: 'voice' | 'video';
  /** `true` when somebody called us. Decides which screen the route draws. */
  readonly incoming: boolean;
  readonly status: CallStatus;
  readonly startedAt: number;
  /** When the media connected. Absent until then; the timer counts from it. */
  readonly connectedAt?: number;
  readonly muted: boolean;
  readonly videoOn: boolean;
  /**
   * Fixed, because the platform cannot do them yet: routing audio to a
   * speaker, sharing a screen and flipping a camera are all things
   * `CallMediaAdapter` does not expose. Drawing them as toggles that move
   * would be drawing a lie, so their buttons are inert and the screen says so.
   */
  readonly speaker: boolean;
  readonly screenSharing: boolean;
  readonly cameraFacing: 'front' | 'back';
  readonly minimised: boolean;
  readonly pipCorner: CallPipCorner;
}

/**
 * Bloom's vocabulary for where a call is.
 *
 * `connecting` is its own state and not a kind of ringing: the person has
 * answered and the media has not arrived, which is a different thing to say.
 */
function statusOf(phase: CallView['phase']): CallStatus {
  switch (phase) {
    case 'ringing':
      return 'ringing';
    case 'connecting':
      return 'connecting';
    case 'active':
      return 'active';
    case 'ended':
      return 'ended';
  }
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
      status: statusOf(call.phase),
      startedAt: Date.parse(call.startedAt),
      connectedAt: call.answeredAt ? Date.parse(call.answeredAt) : undefined,
      muted: call.muted,
      videoOn: call.cameraOn,
      speaker: false,
      screenSharing: false,
      cameraFacing: 'front' as const,
      minimised,
      pipCorner,
    };
  }, [call, minimised, pipCorner]);
}

/** How long the call has been connected, already formatted. `""` until it is. */
export function useCallDuration(session: CallSession | null): string {
  const connectedAt = session?.connectedAt;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (connectedAt === undefined) return;
    const tick = () => setElapsed(Date.now() - connectedAt);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [connectedAt]);
  if (connectedAt === undefined) return '';
  const total = Math.max(0, Math.floor(elapsed / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

/** A finished call, as the history screen lists it. */
export interface CallLogEntry {
  readonly id: string;
  readonly conversationId: string;
  readonly peerAccountIds: readonly string[];
  readonly mode: 'voice' | 'video';
  readonly direction: CallDirection;
  readonly at: number;
  readonly durationMs: number;
}

/**
 * Which of Bloom's four arrows a finished call wears.
 *
 * `missed` and `declined` are READINGS of an incoming call, not facts the
 * caller asserted: the same record is an unanswered outgoing call at the other
 * end, and drawing it as "missed" there would be telling somebody they ignored
 * their own call.
 */
function directionOf(entry: { incoming: boolean; outcome: string }): CallDirection {
  if (!entry.incoming) return 'outgoing';
  if (entry.outcome === 'declined') return 'declined';
  if (entry.outcome === 'not_answered' || entry.outcome === 'cancelled') return 'missed';
  return 'incoming';
}

/** The call log, read out of the conversations where it lives. */
export function useCallLog(): readonly CallLogEntry[] {
  const history = useCallHistory();
  return useMemo(
    () =>
      history.map((entry) => ({
        id: entry.id,
        conversationId: entry.conversationId,
        peerAccountIds: entry.withAccountIds,
        mode: entry.mode,
        direction: directionOf(entry),
        at: Date.parse(entry.at),
        durationMs: entry.durationMs,
      })),
    [history],
  );
}
