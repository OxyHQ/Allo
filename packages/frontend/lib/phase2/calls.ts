/**
 * CALLS, AS A LOCAL STATE MACHINE — NOTHING HERE REACHES THE NETWORK.
 *
 * Allo has no call signalling and no media: there is no offer, no answer, no
 * ICE and no `@allo/core` surface behind any of this. What follows is the state
 * a call screen needs, driven entirely from this device, so the screens are
 * real and navigable before the transport exists. To replace it, a transport
 * has to supply five things: an outbound `place` that actually rings somebody
 * and reports `ringing` / `connecting` / `active` / `ended` back as `status`;
 * an inbound event that calls `receive`; a media layer whose local and remote
 * tracks become the `remoteVideo` / `localVideo` nodes the screens pass through
 * (nothing here knows what a track is); per-participant `muted` / `speaking`
 * flags from an audio meter; and a server-side call log to seed and append to
 * `log` instead of the in-memory array below. Every action here is
 * synchronous and local; a transport's are not, so each one becomes the
 * OPTIMISTIC half of a request whose confirmation lands back through the same
 * setters. Nothing in this module opens a socket, makes a request, touches a
 * microphone or persists anything: state lives in memory for as long as the tab
 * does, and `DEMO_LOG` is sample data that a transport deletes.
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type {
  CallDirection,
  CallHistoryItem,
  CallHistorySection,
  CallMode,
  CallPipCorner,
  CallStatus,
} from '@oxy.so/bloom/call-ui';

import { formatDay, formatTime } from '@/lib/chat/format';
import { SEED_DEMO_DATA } from './demo';

export type { CallDirection, CallMode, CallPipCorner, CallStatus };

/** Wording is the caller's; this file only decides which sentence to ask for. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** One person on a live call, as the group grid draws them. */
export interface CallPeer {
  readonly accountId: string;
  readonly muted?: boolean;
  readonly speaking?: boolean;
  readonly presenting?: boolean;
}

/** The one call this device is in, or trying to be in. */
export interface CallSession {
  readonly id: string;
  /** The conversation the call belongs to — what `/c/:id/call` is keyed by. */
  readonly conversationId: string;
  /** Everyone else on it. More than one makes it a group call. */
  readonly peers: readonly CallPeer[];
  readonly mode: CallMode;
  /** `true` when somebody called us. Decides which screen the route draws. */
  readonly incoming: boolean;
  readonly status: CallStatus;
  /** When it was placed or arrived. */
  readonly startedAt: number;
  /** When media started flowing. Absent until `active`; the timer counts from it. */
  readonly connectedAt?: number;
  readonly muted: boolean;
  readonly speaker: boolean;
  readonly videoOn: boolean;
  readonly screenSharing: boolean;
  readonly cameraFacing: 'front' | 'back';
  /** Collapsed to the pill. The route reads it; Bloom's `CallScreen` draws it. */
  readonly minimised: boolean;
  readonly pipCorner: CallPipCorner;
}

/** A finished call, as the history screen lists it. */
export interface CallLogEntry {
  readonly id: string;
  readonly conversationId: string;
  readonly peerAccountIds: readonly string[];
  readonly mode: CallMode;
  readonly direction: CallDirection;
  /** Epoch ms the call started. */
  readonly at: number;
  /** Time connected, in ms. Zero for a call that never connected. */
  readonly durationMs: number;
}

/** What a caller has to say to start one. Everything else has a default. */
export interface PlaceCallInput {
  readonly conversationId: string;
  readonly peerAccountIds: readonly string[];
  readonly mode?: CallMode;
}

export interface CallsState {
  /** The call in progress, or `null`. There is at most one. */
  readonly session: CallSession | null;
  /** Newest first. */
  readonly log: readonly CallLogEntry[];

  place: (input: PlaceCallInput) => void;
  receive: (input: PlaceCallInput) => void;
  /** `calling` → `ringing`: the far end is being alerted. */
  markRinging: () => void;
  /** Answers an incoming call: `ringing` → `connecting`. */
  answer: () => void;
  /** Media is flowing: → `active`, and the timer starts. */
  connect: () => void;
  /** Media dropped, the call is not over. */
  markReconnecting: () => void;

  setMuted: (muted: boolean) => void;
  setSpeaker: (speaker: boolean) => void;
  setVideo: (videoOn: boolean) => void;
  setScreenSharing: (sharing: boolean) => void;
  flipCamera: () => void;
  /** Parks the call and brings it back. */
  setHold: (held: boolean) => void;
  setMinimised: (minimised: boolean) => void;
  movePip: (corner: CallPipCorner) => void;
  /** Who is talking, for the grid's speaking ring. `undefined` for nobody. */
  setSpeaking: (accountId: string | undefined) => void;

  /** Hangs up, whatever state it was in, and writes the log entry. */
  end: () => void;
  /** Refuses an incoming call. Logged as `declined`. */
  decline: () => void;
  /** An incoming call nobody answered. Logged as `missed`. */
  missed: () => void;
  clearLog: () => void;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * SAMPLE DATA. The ids are the local harness's fake accounts and conversations
 * (`harness/client.ts`, `harness/oxy-services.tsx`), so no entry here claims
 * anything about a real call with a real person. A transport deletes it and
 * seeds `log` from the server instead.
 */
export const DEMO_LOG: readonly CallLogEntry[] = Object.freeze([
  {
    id: 'demo-1',
    conversationId: '6700000000000000000000a2',
    peerAccountIds: ['6700000000000000000000a2'],
    mode: 'voice',
    direction: 'missed',
    at: Date.now() - 2 * HOUR,
    durationMs: 0,
  },
  {
    id: 'demo-2',
    conversationId: '6700000000000000000000a2',
    peerAccountIds: ['6700000000000000000000a2'],
    mode: 'video',
    direction: 'outgoing',
    at: Date.now() - 6 * HOUR,
    durationMs: 4 * MINUTE + 32 * SECOND,
  },
  {
    id: 'demo-3',
    conversationId: '6700000000000000000000a2',
    peerAccountIds: ['6700000000000000000000a2', '6700000000000000000000a3'],
    mode: 'voice',
    direction: 'incoming',
    at: Date.now() - DAY - 3 * HOUR,
    durationMs: 68 * MINUTE + 11 * SECOND,
  },
  {
    id: 'demo-4',
    conversationId: '6700000000000000000000a3',
    peerAccountIds: ['6700000000000000000000a3'],
    mode: 'voice',
    direction: 'declined',
    at: Date.now() - 4 * DAY,
    durationMs: 0,
  },
]);

let counter = 0;

/** A local id. It never leaves the device, so it only has to be unique here. */
function localId(): string {
  counter += 1;
  return `local-${Date.now().toString(36)}-${counter}`;
}

function startSession(input: PlaceCallInput, incoming: boolean): CallSession {
  return {
    id: localId(),
    conversationId: input.conversationId,
    peers: input.peerAccountIds.map((accountId) => ({ accountId })),
    mode: input.mode ?? 'voice',
    incoming,
    status: incoming ? 'ringing' : 'calling',
    startedAt: Date.now(),
    muted: false,
    speaker: false,
    videoOn: (input.mode ?? 'voice') === 'video',
    screenSharing: false,
    cameraFacing: 'front',
    minimised: false,
    pipCorner: 'top-right',
  };
}

/**
 * How a finished call is filed.
 *
 * The two negative directions are about US: a call we placed and nobody took is
 * `outgoing`, not `missed` — `missed` is what the person who was called sees,
 * and drawing it on the caller's own log would tell them they ignored their own
 * call. Pure, and exported because the rule is the interesting part.
 */
export function logDirection(
  session: CallSession,
  outcome: 'ended' | 'declined' | 'missed',
): CallDirection {
  if (outcome === 'declined') return 'declined';
  if (outcome === 'missed') return 'missed';
  if (session.connectedAt === undefined) return session.incoming ? 'missed' : 'outgoing';
  return session.incoming ? 'incoming' : 'outgoing';
}

/** How long the call has been connected, in ms. Zero until it is. */
export function callDurationMs(session: CallSession | null, now: number): number {
  if (!session || session.connectedAt === undefined) return 0;
  return Math.max(0, now - session.connectedAt);
}

/**
 * `"00:42"`, `"12:07"`, `"1:04:11"` — the hour appears only once there is one.
 *
 * Bloom reads no clock and formats nothing: `duration` arrives as this string.
 */
export function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function logEntry(session: CallSession, outcome: 'ended' | 'declined' | 'missed'): CallLogEntry {
  return {
    id: session.id,
    conversationId: session.conversationId,
    peerAccountIds: session.peers.map((peer) => peer.accountId),
    mode: session.mode,
    direction: logDirection(session, outcome),
    at: session.startedAt,
    durationMs: callDurationMs(session, Date.now()),
  };
}

export const useCallsStore = create<CallsState>((set) => {
  /** Applies a change to the live call and leaves everything else alone. */
  const patch = (change: (session: CallSession) => Partial<CallSession>) =>
    set((state) =>
      state.session === null ? state : { session: { ...state.session, ...change(state.session) } },
    );

  /** Ends the call and files it. */
  const finish = (outcome: 'ended' | 'declined' | 'missed') =>
    set((state) =>
      state.session === null
        ? state
        : { session: null, log: [logEntry(state.session, outcome), ...state.log] },
    );

  return {
    session: null,
    log: SEED_DEMO_DATA ? DEMO_LOG : [],

    place: (input) => set({ session: startSession(input, false) }),
    receive: (input) => set({ session: startSession(input, true) }),
    markRinging: () => patch((session) => (session.status === 'calling' ? { status: 'ringing' } : {})),
    answer: () => patch((session) => (session.incoming ? { status: 'connecting' } : {})),
    connect: () =>
      patch((session) => ({
        status: 'active',
        connectedAt: session.connectedAt ?? Date.now(),
      })),
    markReconnecting: () => patch(() => ({ status: 'reconnecting' })),

    setMuted: (muted) => patch(() => ({ muted })),
    setSpeaker: (speaker) => patch(() => ({ speaker })),
    setVideo: (videoOn) => patch(() => ({ videoOn })),
    setScreenSharing: (screenSharing) => patch(() => ({ screenSharing })),
    flipCamera: () =>
      patch((session) => ({ cameraFacing: session.cameraFacing === 'front' ? 'back' : 'front' })),
    setHold: (held) =>
      patch((session) => {
        if (held) return session.status === 'active' ? { status: 'onHold' } : {};
        return session.status === 'onHold' ? { status: 'active' } : {};
      }),
    setMinimised: (minimised) => patch(() => ({ minimised })),
    movePip: (pipCorner) => patch(() => ({ pipCorner })),
    setSpeaking: (accountId) =>
      patch((session) => ({
        peers: session.peers.map((peer) => ({ ...peer, speaking: peer.accountId === accountId })),
      })),

    end: () => finish('ended'),
    decline: () => finish('declined'),
    missed: () => finish('missed'),
    clearLog: () => set({ log: [] }),
  };
});

/** The live call, or `null`. */
export function useCallSession(): CallSession | null {
  return useCallsStore((state) => state.session);
}

/** The finished calls, newest first. */
export function useCallLog(): readonly CallLogEntry[] {
  return useCallsStore((state) => state.log);
}

/**
 * The running timer, already formatted — `""` until the call connects.
 *
 * The clock is read here rather than in a component so `CallScreen` keeps
 * getting a pre-formatted string, which is the only thing it accepts. The tick
 * is a plain interval: a call that has not connected runs none at all.
 */
export function useCallDuration(session: CallSession | null): string {
  const connectedAt = session?.connectedAt;
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (connectedAt === undefined) return;
    const tick = () => setElapsed(Date.now() - connectedAt);
    tick();
    const timer = setInterval(tick, SECOND);
    return () => clearInterval(timer);
  }, [connectedAt]);

  return connectedAt === undefined ? '' : formatCallDuration(elapsed);
}

/** What the history screen needs to turn a log entry into a row. */
export interface CallHistoryCopy {
  readonly now: Date;
  readonly locale: string;
  readonly t: Translate;
  /** The people on the call, as one name. */
  readonly nameFor: (accountIds: readonly string[]) => string;
  /** An Oxy file id or a URL for the row's avatar, when there is one. */
  readonly avatarFor: (accountIds: readonly string[]) => string | undefined;
}

/**
 * The log as Bloom's day-headed sections.
 *
 * Every string a `CallHistoryRow` draws is decided here: the day heading, the
 * second line and the direction word. Bloom formats nothing, because what
 * "yesterday" means needs a locale and a timezone a component does not have.
 * The second line is the clock time and, for a call that connected, how long it
 * ran — `"18:40 · 4:32"`; the row prefixes the direction word itself.
 *
 * Pure, and takes `now`, so a test can hold the clock still.
 */
export function callHistorySections(
  entries: readonly CallLogEntry[],
  copy: CallHistoryCopy,
): CallHistorySection[] {
  const sections: { id: string; title: string; items: CallHistoryItem[] }[] = [];
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const at = new Date(entry.at);
    const title = formatDay(at, copy.now, copy.locale, copy.t);
    const time = formatTime(at, copy.locale);
    const meta =
      entry.durationMs > 0 ? `${time} · ${formatCallDuration(entry.durationMs)}` : time;

    const item: CallHistoryItem = {
      id: entry.id,
      name: copy.nameFor(entry.peerAccountIds),
      avatar: copy.avatarFor(entry.peerAccountIds),
      direction: entry.direction,
      mode: entry.mode,
      meta,
    };

    const last = sections.at(-1);
    if (last !== undefined && last.title === title) last.items.push(item);
    else sections.push({ id: `${title}-${entry.id}`, title, items: [item] });
  }
  return sections;
}
