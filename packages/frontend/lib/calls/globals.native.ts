/**
 * Puts WebRTC on the global object so ONE implementation serves both
 * platforms.
 *
 * `@livekit/react-native`'s `registerGlobals()` installs `RTCPeerConnection`,
 * `MediaStream`, `mediaDevices` and the rest from
 * `@livekit/react-native-webrtc`, which is why `lib/calls/webrtc.ts` is
 * written once rather than twice — the usual place calling code rots is two
 * implementations drifting apart over SDP.
 *
 * Install `@livekit/react-native-webrtc` ALONE: it exports the full upstream
 * WebRTC API, so one library serves both a plain `RTCPeerConnection` and a
 * LiveKit room. Adding `react-native-webrtc` beside it collides on
 * `com.oney.WebRTCModule` / `RCT_EXPORT_MODULE()`.
 *
 * Idempotent: registering twice is harmless, and a dev reload does it again.
 */
let registered = false;

export function registerWebrtcGlobals(): void {
  if (registered) return;
  registered = true;
  // Required lazily: pulling the native module into the web bundle would take
  // a Node-only path with it, and this file is only reached on a device.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registerGlobals } = require('@livekit/react-native') as { registerGlobals: () => void };
  registerGlobals();
}
