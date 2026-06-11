/**
 * Web implementation of the WebRTC abstraction.
 * Uses native browser APIs (no native dependency required).
 */
import React, { useEffect, useRef } from 'react';
import type { WebRTCModule, RTCViewProps } from './types';

const RTCViewWeb: React.FC<RTCViewProps> = ({
  stream,
  streamURL: _streamURL,
  objectFit = 'cover',
  mirror = false,
  muted = false,
  style,
  // `zOrder` exists on native; ignore on web.
  zOrder: _zOrder,
  ...rest
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (stream && el.srcObject !== stream) {
      el.srcObject = stream;
    } else if (!stream && el.srcObject) {
      el.srcObject = null;
    }
  }, [stream]);

  // Translate RN-style ViewProps style into CSS style.
  const cssStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: objectFit as React.CSSProperties['objectFit'],
    transform: mirror ? 'scaleX(-1)' : undefined,
    backgroundColor: '#000',
    // Allow caller-provided style to override.
    ...(style as React.CSSProperties),
  };

  return React.createElement('video', {
    ref: videoRef,
    autoPlay: true,
    playsInline: true,
    muted,
    style: cssStyle,
    ...(rest as React.HTMLAttributes<HTMLVideoElement>),
  });
};

const isBrowser =
  typeof window !== 'undefined' &&
  typeof window.RTCPeerConnection !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices;

const noopMediaDevices = {
  getUserMedia: () =>
    Promise.reject(new Error('WebRTC is not supported in this environment')),
} as unknown as MediaDevices;

const webrtcWeb: WebRTCModule = {
  RTCPeerConnection: isBrowser ? window.RTCPeerConnection : (undefined as any),
  RTCSessionDescription: isBrowser ? window.RTCSessionDescription : (undefined as any),
  RTCIceCandidate: isBrowser ? window.RTCIceCandidate : (undefined as any),
  mediaDevices: isBrowser ? navigator.mediaDevices : noopMediaDevices,
  RTCView: RTCViewWeb,
  streamToURL: () => null,
  isSupported: isBrowser,
};

export default webrtcWeb;
export const webrtc = webrtcWeb;
export const {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
  RTCView,
  streamToURL,
  isSupported,
} = webrtcWeb;
export type { RTCViewProps, WebRTCModule, ObjectFit } from './types';
