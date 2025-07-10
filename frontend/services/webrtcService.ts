import { Audio } from 'expo-av';

export interface WebRTCConfig {
  iceServers: RTCIceServer[];
}

export interface MediaStreamConstraints {
  audio: boolean;
  video: boolean | MediaTrackConstraints;
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
  private onConnectionStateChange?: (state: RTCPeerConnectionState) => void;

  constructor(config: WebRTCConfig) {
    this.config = config;
  }

  setCallbacks(callbacks: {
    onSignalingData?: (data: SignalingData) => void;
    onRemoteStream?: (stream: MediaStream) => void;
    onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
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
      this.peerConnection.onicecandidate = (event) => {
        if (event.candidate && this.onSignalingData) {
          this.onSignalingData({
            type: 'ice-candidate',
            data: event.candidate,
            callId,
            to: targetUserId,
          });
        }
      };

      // Handle remote stream
      this.peerConnection.ontrack = (event) => {
        console.log('Received remote stream');
        this.remoteStream = event.streams[0];
        if (this.onRemoteStream) {
          this.onRemoteStream(this.remoteStream);
        }
      };

      // Handle connection state changes
      this.peerConnection.onconnectionstatechange = () => {
        const state = this.peerConnection?.connectionState;
        console.log('Connection state:', state);
        if (this.onConnectionStateChange && state) {
          this.onConnectionStateChange(state);
        }
      };

    } catch (error) {
      console.error('Error initializing peer connection:', error);
      throw error;
    }
  }

  async getLocalStream(constraints: MediaStreamConstraints): Promise<MediaStream | null> {
    try {
      // For React Native, we'll simulate media stream creation
      // In a real implementation, you'd use react-native-webrtc
      console.log('Getting local media stream with constraints:', constraints);
      
      // Request permissions
      if (constraints.audio) {
        const { status } = await Audio.requestPermissionsAsync();
        if (status !== 'granted') {
          throw new Error('Audio permission denied');
        }
      }

      // For now, return null - in production you'd use react-native-webrtc
      // This would be something like:
      // const stream = await mediaDevices.getUserMedia(constraints);
      return null;

    } catch (error) {
      console.error('Error getting local media stream:', error);
      return null;
    }
  }

  async addLocalStream(stream: MediaStream): Promise<void> {
    if (!this.peerConnection || !stream) return;

    this.localStream = stream;
    
    // Add tracks to peer connection
    stream.getTracks().forEach(track => {
      this.peerConnection?.addTrack(track, stream);
    });
  }

  async createOffer(callId: string, targetUserId: string): Promise<void> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    try {
      this.isInitiator = true;
      const offer = await this.peerConnection.createOffer();
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

  async handleOffer(offer: RTCSessionDescriptionInit, callId: string, targetUserId: string): Promise<void> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    try {
      await this.peerConnection.setRemoteDescription(offer);
      
      const answer = await this.peerConnection.createAnswer();
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

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    try {
      await this.peerConnection.setRemoteDescription(answer);
    } catch (error) {
      console.error('Error handling answer:', error);
      throw error;
    }
  }

  async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    try {
      await this.peerConnection.addIceCandidate(candidate);
    } catch (error) {
      console.error('Error handling ICE candidate:', error);
      throw error;
    }
  }

  toggleAudio(enabled: boolean): void {
    if (!this.localStream) return;

    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = enabled;
    }
  }

  toggleVideo(enabled: boolean): void {
    if (!this.localStream) return;

    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = enabled;
    }
  }

  cleanup(): void {
    // Close peer connection
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // Stop local stream tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    // Clear remote stream
    this.remoteStream = null;
  }

  getCurrentLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  isConnected(): boolean {
    return this.peerConnection?.connectionState === 'connected';
  }
} 