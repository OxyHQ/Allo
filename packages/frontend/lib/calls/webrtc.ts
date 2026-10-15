/**
 * THE MEDIA HALF OF A CALL — the app's side of ADR 0002, Decision 5.
 *
 * `@allo/core` owns the state machine and the signalling; this owns the
 * `RTCPeerConnection`, the microphone and the camera, and nothing else. It
 * makes no decisions: whether the call is relayed, when candidates go out and
 * whether a description is acceptable are all the SDK's, and arrive here as
 * instructions. It does not read the DTLS fingerprint either — that line
 * lives in the SDP, the SDK reads it there, and WebRTC enforces it against
 * the peer's certificate without being asked.
 *
 * **One implementation, not one per platform.** The WebRTC API is the same on
 * both because `@livekit/react-native` registers the globals on a device;
 * `lib/calls/globals.native.ts` does that registration and the web file does
 * nothing, which is the only difference there is.
 *
 * Candidates are BATCHED rather than sent one at a time. Each one is an
 * encrypted message in the conversation, and trickling twenty of them is
 * twenty events in somebody's timeline storage for one call; a short window
 * collapses them into one or two without costing enough latency to notice.
 */
import { registerWebrtcGlobals } from './globals';
import { createMediaState } from './mediaState';
import type { CallMediaAdapter, CallMediaPlan, SessionDescription } from '@allo/core';
import { logger } from '@/utils/logger';

/** How long candidates gather before they go out together. */
const CANDIDATE_BATCH_MS = 150;

export interface WebRtcCallMedia extends CallMediaAdapter {
  state: ReturnType<typeof createMediaState>;
  /** The remote audio and video, for a screen to render. Null until the other side's tracks arrive. */
  remoteStream(): MediaStream | null;
  /** This device's own camera preview. */
  localStream(): MediaStream | null;
}

export function createCallMedia(): WebRtcCallMedia {
  const state = createMediaState();
  let generation = 0;
  let connectionListener: ((state: 'connected' | 'disconnected' | 'failed') => void) | null = null;
  let disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  let plan: CallMediaPlan | null = null;
  let muted = false;
  let cameraOn = false;
  let group: ReturnType<typeof import('./groupMedia').createGroupMedia> | null = null;
  let groupRemote: Array<{ id: string; stream: MediaStream }> = [];
  const receiveKeys = new Map<string, Uint8Array>();
  const trackCleanups: Array<() => void> = [];
  const publish = () =>
    state.update(local, group ? groupRemote : remote ? [{ id: 'peer', stream: remote }] : []);
  const observeTrack = (track: MediaStreamTrack) => {
    for (const event of ['ended', 'mute', 'unmute']) {
      track.addEventListener(event, publish);
      trackCleanups.push(() => track.removeEventListener(event, publish));
    }
  };
  let pc: RTCPeerConnection | null = null;
  let local: MediaStream | null = null;
  let remote: MediaStream | null = null;
  let listener: ((candidates: readonly string[]) => void) | null = null;
  let batch: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (batch.length === 0) return;
    if (!listener) return;
    const going = batch;
    batch = [];
    listener?.(going);
  };

  const queue = (candidate: string) => {
    batch.push(candidate);
    if (!timer) timer = setTimeout(flush, CANDIDATE_BATCH_MS);
  };

  const require = (): RTCPeerConnection => {
    if (!pc) throw new Error('the call has no peer connection; prepare() first');
    return pc;
  };

  /** Everything this adapter holds, released. Idempotent, and the only path that stops a track. */
  const teardown = () => {
    generation++;
    if (disconnectedTimer) clearTimeout(disconnectedTimer);
    disconnectedTimer = null;
    const oldGroup = group;
    group = null;
    void oldGroup
      ?.close()
      .catch((error: unknown) => logger.warn('[calls] closing room failed', error));
    groupRemote = [];
    receiveKeys.clear();
    for (const cleanup of trackCleanups.splice(0)) cleanup();
    if (timer) clearTimeout(timer);
    timer = null;
    batch = [];
    for (const track of local?.getTracks() ?? []) track.stop();
    local = null;
    remote = null;
    pc?.close();
    pc = null;
    publish();
  };

  return {
    state,
    remoteStream: () => remote,
    localStream: () => local,

    async prepare(nextPlan: CallMediaPlan) {
      // Registering here rather than in the factory keeps the WebRTC module
      // graph off the sign-in path: the adapter is built for every client, and
      // most sessions never place a call. It is idempotent, so once per call
      // costs nothing.
      registerWebrtcGlobals();
      // A second `prepare()` without a `close()` used to overwrite `pc` and
      // strand the previous connection with its tracks still live.
      teardown();
      plan = nextPlan;
      muted = false;
      cameraOn = plan.mode === 'video';
      // `relayOnly` is the SDK's answer, not a preference: with it on, no host
      // and no server-reflexive candidate is offered, so the other side sees
      // only the relay's address.
      const attempt = generation;
      const connection = new RTCPeerConnection({
        iceServers: plan.iceServers,
        iceTransportPolicy: plan.relayOnly ? 'relay' : 'all',
      });
      pc = connection;
      remote = plan.group ? null : new MediaStream();
      connection.ontrack = (event) => {
        if (attempt !== generation) return;
        // Unified Plan permits streamless ontrack events. Keep one owned
        // projection and deduplicate by track identity, not event.streams[0].
        if (!remote?.getTracks().some((track) => track.id === event.track.id)) {
          remote?.addTrack(event.track);
          observeTrack(event.track);
        }
        publish();
      };
      connection.onicecandidate = (event) => {
        if (attempt !== generation) return;
        if (event.candidate?.candidate) queue(JSON.stringify(event.candidate.toJSON()));
        else flush();
      };
      connection.onconnectionstatechange = () => {
        if (attempt !== generation) return;
        if (disconnectedTimer) clearTimeout(disconnectedTimer);
        disconnectedTimer = null;
        if (connection.connectionState === 'connected') connectionListener?.('connected');
        if (connection.connectionState === 'failed') connectionListener?.('failed');
        if (connection.connectionState === 'disconnected') {
          connectionListener?.('disconnected');
          disconnectedTimer = setTimeout(() => {
            if (attempt === generation) connectionListener?.('failed');
          }, 20_000);
        }
      };
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: plan.mode === 'video',
        });
        if (attempt !== generation) {
          for (const track of stream.getTracks()) track.stop();
          throw new Error('call media preparation cancelled');
        }
        local = stream;
        for (const track of stream.getTracks()) {
          track.enabled = track.kind === 'audio' ? !muted : cameraOn;
          connection.addTrack(track, stream);
          observeTrack(track);
        }
        publish();
      } catch (error) {
        if (attempt === generation) teardown();
        throw error;
      }
    },

    async joinRoom(ticket, key) {
      if (!plan?.instanceId || !local) throw new Error('group media must be prepared');
      const attempt = generation;
      const { createGroupMedia } = await import('./groupMedia');
      if (attempt !== generation) throw new Error('call closed');
      const room = createGroupMedia(
        plan,
        (streams) => {
          if (attempt === generation) {
            groupRemote = streams;
            publish();
          }
        },
        (status) => {
          if (attempt === generation) connectionListener?.(status);
        },
      );
      group = room;
      publish();
      try {
        await room.setKey(plan.instanceId, key);
        for (const [id, received] of receiveKeys) await room.setKey(id, received);
        if (attempt !== generation) throw new Error('call closed');
        await room.join(ticket, local);
      } catch (error) {
        await room.close();
        throw error;
      }
    },
    async setSendKey(key) {
      if (group && plan?.instanceId) await group.setKey(plan.instanceId, key);
    },
    async setReceiveKey(id, key) {
      if (id === plan?.instanceId) return;
      receiveKeys.set(id, key);
      await group?.setKey(id, key);
    },

    async createOffer(): Promise<SessionDescription> {
      const connection = require();
      const offer = await connection.createOffer({});
      await connection.setLocalDescription(offer);
      return { sdp: connection.localDescription?.sdp ?? offer.sdp ?? '' };
    },

    async acceptOffer(offer: SessionDescription): Promise<SessionDescription> {
      const connection = require();
      await connection.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      return { sdp: connection.localDescription?.sdp ?? answer.sdp ?? '' };
    },

    async acceptAnswer(answer: SessionDescription) {
      await require().setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    },

    async addCandidates(candidates: readonly string[]) {
      const connection = require();
      // Together, not one after another: the candidates in a batch are
      // independent, and on a device each `addIceCandidate` is a bridge round
      // trip — at the one moment of the call where latency is felt. One
      // unusable candidate is normal, so each keeps its own catch and the
      // others still connect.
      await Promise.all(
        candidates.map((candidate) =>
          connection
            .addIceCandidate(
              candidate.startsWith('{')
                ? JSON.parse(candidate)
                : { candidate, sdpMid: '0', sdpMLineIndex: 0 },
            )
            .catch((error: unknown) => logger.debug('[calls] a candidate was refused', error)),
        ),
      );
    },

    onCandidates(next) {
      listener = next;
      flush();
      return () => {
        if (listener === next) listener = null;
      };
    },

    async setMuted(next: boolean) {
      muted = next;
      for (const track of local?.getAudioTracks() ?? []) track.enabled = !muted;
      publish();
    },

    async setCameraEnabled(on: boolean) {
      if (on && plan?.mode !== 'video') throw new Error('camera unavailable for this call');
      cameraOn = on;
      for (const track of local?.getVideoTracks() ?? []) track.enabled = on;
      publish();
    },

    onConnectionState(next) {
      connectionListener = next;
      return () => {
        if (connectionListener === next) connectionListener = null;
      };
    },
    async close() {
      connectionListener = null;
      listener = null;
      teardown();
    },
  };
}
