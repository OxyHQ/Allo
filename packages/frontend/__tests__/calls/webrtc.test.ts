import { createCallMedia } from '@/lib/calls/webrtc';
jest.mock('@/lib/calls/globals', () => ({ registerWebrtcGlobals: jest.fn() }));
jest.mock('@/utils/logger', () => ({ logger: { debug: jest.fn(), warn: jest.fn() } }));
class Track extends EventTarget {
  id = Math.random().toString();
  enabled = true;
  muted = false;
  readyState = 'live';
  constructor(readonly kind: string) {
    super();
  }
  stop = jest.fn(() => {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  });
}
class Stream {
  id = Math.random().toString();
  constructor(private tracks: Track[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(track: Track) {
    this.tracks.push(track);
  }
}
class Peer {
  static all: Peer[] = [];
  ontrack?: (event: { track: Track; streams: Stream[] }) => void;
  onicecandidate?: (event: { candidate: { candidate: string; toJSON(): unknown } | null }) => void;
  addTrack = jest.fn();
  close = jest.fn();
  addIceCandidate = jest.fn().mockResolvedValue(undefined);
  constructor() {
    Peer.all.push(this);
  }
}
const plan = { mode: 'video' as const, iceServers: [], relayOnly: false };
const gum = jest.fn();
beforeEach(() => {
  Peer.all = [];
  gum.mockReset();
  Object.assign(globalThis, { MediaStream: Stream, RTCPeerConnection: Peer });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: gum } },
  });
});
it('closes capture granted after the call ended without reviving camera or state', async () => {
  let resolve!: (stream: Stream) => void;
  gum.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const media = createCallMedia();
  const pending = media.prepare(plan);
  await media.close();
  const track = new Track('video');
  resolve(new Stream([track]));
  await expect(pending).rejects.toThrow('cancelled');
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(media.state.getSnapshot()).toMatchObject({ local: null, remote: [] });
});
it('an obsolete preparation cannot stop or overwrite the replacement call', async () => {
  let resolve!: (stream: Stream) => void;
  const old = new Track('video'),
    current = new Track('video');
  gum
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce(new Stream([current]));
  const media = createCallMedia();
  const first = media.prepare(plan);
  await media.prepare(plan);
  resolve(new Stream([old]));
  await expect(first).rejects.toThrow('cancelled');
  expect(current.stop).not.toHaveBeenCalled();
  expect(old.stop).toHaveBeenCalledTimes(1);
  await media.close();
  expect(current.stop).toHaveBeenCalledTimes(1);
});
it('projects streamless tracks, deduplicates tracks and reacts to mute/end without display ownership', async () => {
  const local = new Track('video');
  gum.mockResolvedValue(new Stream([local]));
  const media = createCallMedia();
  await media.prepare(plan);
  const changed = jest.fn();
  const unsubscribe = media.state.subscribe(changed);
  const remote = new Track('video');
  Peer.all[0].ontrack?.({ track: remote, streams: [] });
  Peer.all[0].ontrack?.({ track: remote, streams: [] });
  expect(media.state.getSnapshot().remote[0].stream.getTracks()).toHaveLength(1);
  remote.dispatchEvent(new Event('mute'));
  expect(changed).toHaveBeenCalledTimes(3);
  unsubscribe();
  expect(local.stop).not.toHaveBeenCalled();
  await media.setCameraEnabled(false);
  expect(local.enabled).toBe(false);
  await media.close();
  expect(local.stop).toHaveBeenCalledTimes(1);
});
it('keeps gathered candidates until a listener exists and preserves video m-line data', async () => {
  gum.mockResolvedValue(new Stream());
  const media = createCallMedia();
  await media.prepare(plan);
  const candidate = { candidate: 'candidate:video', sdpMid: '1', sdpMLineIndex: 1 };
  Peer.all[0].onicecandidate?.({
    candidate: { candidate: candidate.candidate, toJSON: () => candidate },
  });
  Peer.all[0].onicecandidate?.({ candidate: null });
  const listener = jest.fn();
  media.onCandidates(listener);
  expect(listener).toHaveBeenCalledWith([JSON.stringify(candidate)]);
  await media.addCandidates([JSON.stringify(candidate)]);
  expect(Peer.all[0].addIceCandidate).toHaveBeenCalledWith(candidate);
  await media.close();
});

it('applies mute and camera changes made while the permission prompt is pending', async () => {
  let resolve!: (stream: Stream) => void;
  gum.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const media = createCallMedia();
  const pending = media.prepare(plan);
  await media.setMuted(true);
  await media.setCameraEnabled(false);
  const audio = new Track('audio'),
    video = new Track('video');
  resolve(new Stream([audio, video]));
  await pending;
  expect(audio.enabled).toBe(false);
  expect(video.enabled).toBe(false);
  await media.close();
});
