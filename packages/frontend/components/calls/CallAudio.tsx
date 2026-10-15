/** Native WebRTC owns audio playout; RTCView must never create a second player. */
export function CallAudio() {
  return null;
}
