/**
 * Nothing to register: a browser already has `RTCPeerConnection`,
 * `MediaStream` and `navigator.mediaDevices`.
 *
 * The native file is where the work is — see `globals.native.ts`.
 */
export function registerWebrtcGlobals(): void {
  // Deliberately empty.
}
