import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  MediaStream,
  MediaStreamTrack,
  mediaDevices,
  RTCView,
} from 'react-native-webrtc';

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
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private isInitiator: boolean = false;
  private config: WebRTCConfig;
  private onSignalingData?: (data: SignalingData) => void;
  private onRemoteStream?: (stream: MediaStream) => void;
  private onConnectionStateChange?: (state: string) => void;

  constructor(config: WebRTCConfig) {
    this.config = config;
  }

  setCallbacks(callbacks: {
    onSignalingData?: (data: SignalingData) => void;
    onRemoteStream?: (stream: MediaStream) => void;
    onConnectionStateChange?: (state: string) => void;
  }) {
    this.onSignalingData = callbacks.onSignalingData;
    this.onRemoteStream = callbacks.onRemoteStream;
    this.onConnectionStateChange = callbacks.onConnectionStateChange;
  }

  async initializePeerConnection(callId: string, targetUserId: string): Promise<void> {
    try {
      // Create peer connection
      this.peerConnection = new RTCPeerConnection(this.config);

      // Handle ICE candidates
      this.peerConnection.addEventListener('icecandidate', (event: any) => {
        if (event.candidate && this.onSignalingData) {
          this.onSignalingData({
            type: 'ice-candidate',
            data: event.candidate,
            callId,
            to: targetUserId,
          });
        }
      });

      // Handle remote stream
      this.peerConnection.addEventListener('addstream', (event: any) => {
        console.log('Received remote stream');
        this.remoteStream = event.stream;
        if (this.onRemoteStream && this.remoteStream) {
          this.onRemoteStream(this.remoteStream);
        }
      });

      // Handle connection state changes
      this.peerConnection.addEventListener('connectionstatechange', () => {
        const state = this.peerConnection?.connectionState;
        console.log('Connection state:', state);
        if (this.onConnectionStateChange && state) {
          this.onConnectionStateChange(state);
        }
      });

    } catch (error) {
      console.error('Error initializing peer connection:', error);
      throw error;
    }
  }

  async getLocalStream(constraints: {
    audio: boolean;
    video: boolean | { width?: number; height?: number; facingMode?: string };
  }): Promise<MediaStream | null> {
    try {
      console.log('Getting local media stream with constraints:', constraints);
      
      // Get user media using react-native-webrtc
      const stream = await mediaDevices.getUserMedia(constraints);
      
      if (stream) {
        this.localStream = stream;
        return stream;
      }
      
      return null;

    } catch (error) {
      console.error('Error getting local media stream:', error);
      return null;
    }
  }

  async addLocalStream(stream: MediaStream): Promise<void> {
    if (!this.peerConnection || !stream) return;

    this.localStream = stream;
    
    // Add stream to peer connection
    this.peerConnection.addStream(stream);
  }

  async createOffer(callId: string, targetUserId: string): Promise<void> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    try {
      this.isInitiator = true;
      const offer = await this.peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await this.peerConnection.setLocalDescription(offer);

      if (this.onSignalingData) {
        this.onSignalingData({
          type: 'offer',
          data: offer,
          callId,
          to: targetUserId,
        });
      }
    } catch (error) {
      console.error('Error creating offer:', error);
      throw error;
    }
  }

  async handleOffer(offer: any, callId: string, targetUserId: string): Promise<void> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    try {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      
      const answer = await this.peerConnection.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await this.peerConnection.setLocalDescription(answer);

      if (this.onSignalingData) {
        this.onSignalingData({
          type: 'answer',
          data: answer,
          callId,
          to: targetUserId,
        });
      }
    } catch (error) {
      console.error('Error handling offer:', error);
      throw error;
    }
  }

  async handleAnswer(answer: any): Promise<void> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    try {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (error) {
      console.error('Error handling answer:', error);
      throw error;
    }
  }

  async handleIceCandidate(candidate: any): Promise<void> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error('Error handling ICE candidate:', error);
      throw error;
    }
  }

  getCurrentLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  async toggleAudio(): Promise<boolean> {
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        return audioTrack.enabled;
      }
    }
    return false;
  }

  async toggleVideo(): Promise<boolean> {
    if (this.localStream) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        return videoTrack.enabled;
      }
    }
    return false;
  }

  cleanup(): void {
    // Stop local stream tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    // Close peer connection
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // Clear remote stream
    this.remoteStream = null;
  }

  isConnected(): boolean {
    return this.peerConnection?.connectionState === 'connected';
  }
} 