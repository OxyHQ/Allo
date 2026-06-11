/**
 * Native implementation of the WebRTC abstraction.
 * Backed by `react-native-webrtc`. Requires a custom dev client (breaks Expo Go).
 */
import React from 'react';
import type { WebRTCModule, RTCViewProps } from './types';

// Import lazily so that `expo start` web bundles never resolve this module.
// react-native-webrtc ships its own RTCView component (a native UIView wrapping
// the platform video sink).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rnWebRTC = require('react-native-webrtc');

const NativeRTCView: any = rnWebRTC.RTCView;

const RTCViewNative: React.FC<RTCViewProps> = ({
  stream,
  streamURL,
  stream: _stream,
  objectFit = 'cover',
  mirror,
  // `muted` is web-only (RN component does not accept it).
  muted: _muted,
  zOrder,
  style,
  ...rest
}) => {
  const url = streamURL ?? (stream ? (stream as any).toURL?.() ?? null : null);
  return React.createElement(NativeRTCView, {
    streamURL: url,
    objectFit,
    mirror,
    zOrder,
    style,
    ...rest,
  });
};

const webrtcNative: WebRTCModule = {
  RTCPeerConnection: rnWebRTC.RTCPeerConnection,
  RTCSessionDescription: rnWebRTC.RTCSessionDescription,
  RTCIceCandidate: rnWebRTC.RTCIceCandidate,
  mediaDevices: rnWebRTC.mediaDevices,
  RTCView: RTCViewNative,
  streamToURL: (stream) => {
    if (!stream) return null;
    const s = stream as unknown as { toURL?: () => string };
    return typeof s.toURL === 'function' ? s.toURL() : null;
  },
  isSupported: true,
};

export default webrtcNative;
export const webrtc = webrtcNative;
export const {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
  RTCView,
  streamToURL,
  isSupported,
} = webrtcNative;
export type { RTCViewProps, WebRTCModule, ObjectFit } from './types';
