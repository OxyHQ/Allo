// Simple WebRTC service for Expo/React Native
export interface WebRTCConfig {
  iceServers: RTCIceServer[];
}

export interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SignalingData {
  type: 'offer' | 'answer' | 'ice-candidate';
  data: any;
  callId: string;
  to: string;
}

export class WebRTCService {
  private peerConnection: any = null;
  private localStream: any = null;
  private remoteStream: any = null;
  private isInitiator: boolean = false;
  private config: any;
  private onSignalingData?: (data: SignalingData) => void;
  private onRemoteStream?: (stream: any) => void;
  private onConnectionStateChange?: (state: string) => void;

  constructor(config?: WebRTCConfig) {
    this.config = {
      iceServers: config?.iceServers || [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    };
  }

  setSignalingCallback(callback: (data: SignalingData) => void) {
    this.onSignalingData = callback;
  }

  setRemoteStreamCallback(callback: (stream: any) => void) {
    this.onRemoteStream = callback;
  }

  setConnectionStateCallback(callback: (state: string) => void) {
    this.onConnectionStateChange = callback;
  }

  async initializeCall(callId: string, targetUserId: string, isVideo: boolean = false): Promise<void> {
    try {
      console.log('Initializing call:', { callId, targetUserId, isVideo });
      this.isInitiator = true;
      
      // For now, simulate WebRTC initialization
      // In a real implementation, this would use react-native-webrtc
      
      // Simulate signaling
      if (this.onSignalingData) {
        this.onSignalingData({
          type: 'offer',
          data: { sdp: 'mock-offer-sdp', type: 'offer' },
          callId,
          to: targetUserId,
        });
      }
    } catch (error) {
      console.error('Error initializing call:', error);
      throw error;
    }
  }

  async answerCall(callId: string, targetUserId: string, isVideo: boolean = false): Promise<void> {
    try {
      console.log('Answering call:', { callId, targetUserId, isVideo });
      this.isInitiator = false;
      
      // Simulate answering call
      if (this.onSignalingData) {
        this.onSignalingData({
          type: 'answer',
          data: { sdp: 'mock-answer-sdp', type: 'answer' },
          callId,
          to: targetUserId,
        });
      }
    } catch (error) {
      console.error('Error answering call:', error);
      throw error;
    }
  }

  async handleSignalingData(data: SignalingData): Promise<void> {
    console.log('Handling signaling data:', data);
    
    // In a real implementation, this would handle WebRTC signaling
    // For now, just log the data
  }

  async switchCamera(): Promise<void> {
    console.log('Switching camera');
    // Simulate camera switch
  }

  async toggleMicrophone(): Promise<boolean> {
    console.log('Toggling microphone');
    // Simulate microphone toggle
    return true;
  }

  async toggleCamera(): Promise<boolean> {
    console.log('Toggling camera');
    // Simulate camera toggle
    return true;
  }

  endCall(): void {
    console.log('Ending call');
    this.localStream = null;
    this.remoteStream = null;
    this.peerConnection = null;
  }

  getCurrentLocalStream(): any {
    return this.localStream;
  }

  getCurrentRemoteStream(): any {
    return this.remoteStream;
  }

  isCallActive(): boolean {
    return this.peerConnection !== null;
  }
}

export default WebRTCService; 