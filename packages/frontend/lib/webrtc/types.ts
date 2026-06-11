/**
 * Shared type contract for the WebRTC platform abstraction.
 * Implementations live in `index.native.ts` (react-native-webrtc) and
 * `index.web.ts` (browser APIs).
 */
import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';

export type ObjectFit = 'contain' | 'cover' | 'fill' | 'scale-down';

export interface RTCViewProps extends ViewProps {
  streamURL?: string | null;
  /** Native + web. */
  objectFit?: ObjectFit;
  mirror?: boolean;
  /** Always true for local preview to avoid echo. */
  muted?: boolean;
  /**
   * Direct MediaStream binding. Preferred over streamURL on web; ignored on
   * native if streamURL is provided.
   */
  stream?: MediaStream | null;
  zOrder?: number;
}

export interface WebRTCModule {
  RTCPeerConnection: typeof RTCPeerConnection;
  RTCSessionDescription: typeof RTCSessionDescription;
  RTCIceCandidate: typeof RTCIceCandidate;
  mediaDevices: MediaDevices;
  RTCView: ComponentType<RTCViewProps>;
  /**
   * Native: returns the stream URL exposed by react-native-webrtc.
   * Web: returns null (use `stream` prop on RTCView instead).
   */
  streamToURL: (stream: MediaStream | null | undefined) => string | null;
  /** True when the platform can host real WebRTC calls. */
  isSupported: boolean;
}
