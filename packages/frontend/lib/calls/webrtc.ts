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
import type { CallMediaAdapter, CallMediaPlan, SessionDescription } from '@allo/core';
import { logger } from '@/utils/logger';

/** How long candidates gather before they go out together. */
const CANDIDATE_BATCH_MS = 150;

export interface WebRtcCallMedia extends CallMediaAdapter {
  /** The remote audio and video, for a screen to render. Null until the other side's tracks arrive. */
  remoteStream(): MediaStream | null;
  /** This device's own camera preview. */
  localStream(): MediaStream | null;
}

export function createCallMedia(): WebRtcCallMedia {
  let pc: RTCPeerConnection | null = null;
  let local: MediaStream | null = null;
  let remote: MediaStream | null = null;
  let listener: ((candidates: readonly string[]) => void) | null = null;
  let batch: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (batch.length === 0) return;
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
    if (timer) clearTimeout(timer);
    timer = null;
    batch = [];
    for (const track of local?.getTracks() ?? []) track.stop();
    local = null;
    remote = null;
    pc?.close();
    pc = null;
  };

  return {
    remoteStream: () => remote,
    localStream: () => local,

    async prepare(plan: CallMediaPlan) {
      // Registering here rather than in the factory keeps the WebRTC module
      // graph off the sign-in path: the adapter is built for every client, and
      // most sessions never place a call. It is idempotent, so once per call
      // costs nothing.
      registerWebrtcGlobals();
      // A second `prepare()` without a `close()` used to overwrite `pc` and
      // strand the previous connection with its tracks still live.
      teardown();
      // `relayOnly` is the SDK's answer, not a preference: with it on, no host
      // and no server-reflexive candidate is offered, so the other side sees
      // only the relay's address.
      pc = new RTCPeerConnection({
        iceServers: plan.iceServers,
        iceTransportPolicy: plan.relayOnly ? 'relay' : 'all',
      });
      local = await navigator.mediaDevices.getUserMedia({ audio: true, video: plan.mode === 'video' });
      for (const track of local.getTracks()) pc.addTrack(track, local);

      pc.ontrack = (event) => {
        remote = event.streams[0] ?? remote;
      };
      pc.onicecandidate = (event) => {
        // A null candidate is the end of gathering: send what is left now
        // rather than waiting out the window.
        if (event.candidate?.candidate) queue(event.candidate.candidate);
        else flush();
      };
      pc.onconnectionstatechange = () => {
        if (pc?.connectionState === 'failed') logger.warn('[calls] the peer connection failed');
      };
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
            .addIceCandidate({ candidate, sdpMid: '0', sdpMLineIndex: 0 })
            .catch((error: unknown) => logger.debug('[calls] a candidate was refused', error)),
        ),
      );
    },

    onCandidates(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },

    async setMuted(muted: boolean) {
      for (const track of local?.getAudioTracks() ?? []) track.enabled = !muted;
    },

    async setCameraEnabled(on: boolean) {
      for (const track of local?.getVideoTracks() ?? []) track.enabled = on;
    },

    async close() {
      listener = null;
      teardown();
    },
  };
}
