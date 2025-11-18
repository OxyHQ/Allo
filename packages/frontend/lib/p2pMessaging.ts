/**
 * Peer-to-Peer Messaging
 * 
 * Direct device-to-device messaging when both users are online
 * Falls back to server relay when P2P is not available
 */

import NetInfo from '@react-native-community/netinfo';
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '@/config';

// Note: SOCKET_URL might not be defined, use fallback
const getSocketUrl = () => {
  try {
    return SOCKET_URL || process.env.EXPO_PUBLIC_SOCKET_URL || 'http://localhost:3000';
  } catch {
    return 'http://localhost:3000';
  }
};
import { encryptMessage, decryptMessage, getDeviceKeys } from './signalProtocol';
import { Message } from '@/stores/messagesStore';

export interface P2PConnection {
  userId: string;
  socket: Socket;
  isConnected: boolean;
}

class P2PManager {
  private connections: Map<string, P2PConnection> = new Map();
  private mainSocket: Socket | null = null;
  private isEnabled: boolean = true;

  /**
   * Initialize P2P manager
   */
  async initialize(userId: string, token: string): Promise<void> {
    // Check if P2P is enabled in settings
    // TODO: Load from user settings
    this.isEnabled = true;

    if (!this.isEnabled) {
      return;
    }

    // Connect to main signaling server
    this.mainSocket = io(getSocketUrl(), {
      auth: {
        token,
        userId,
      },
      transports: ['websocket'],
    });

    this.mainSocket.on('connect', () => {
      console.log('[P2P] Connected to signaling server');
    });

    this.mainSocket.on('p2p_offer', async (data: {
      from: string;
      offer: any;
      conversationId: string;
    }) => {
      // Handle WebRTC offer for P2P connection
      await this.handleP2POffer(data.from, data.offer, data.conversationId);
    });

    this.mainSocket.on('p2p_answer', async (data: {
      from: string;
      answer: any;
      conversationId: string;
    }) => {
      // Handle WebRTC answer
      await this.handleP2PAnswer(data.from, data.answer, data.conversationId);
    });

    this.mainSocket.on('p2p_ice_candidate', async (data: {
      from: string;
      candidate: any;
      conversationId: string;
    }) => {
      // Handle ICE candidate
      await this.handleICECandidate(data.from, data.candidate, data.conversationId);
    });
  }

  /**
   * Check if P2P is available for a user
   */
  async isP2PAvailable(userId: string): Promise<boolean> {
    if (!this.isEnabled) {
      return false;
    }

    // Check network connectivity
    const netInfo = await NetInfo.fetch();
    if (!netInfo.isConnected) {
      return false;
    }

    // Check if user is online (via signaling server)
    // TODO: Implement presence check
    return true;
  }

  /**
   * Send message via P2P if available, otherwise use server
   */
  async sendMessage(
    conversationId: string,
    recipientUserId: string,
    message: Message,
    encryptedCiphertext: string
  ): Promise<boolean> {
    const isP2P = await this.isP2PAvailable(recipientUserId);

    if (isP2P) {
      try {
        // Try P2P first
        const sent = await this.sendViaP2P(conversationId, recipientUserId, message, encryptedCiphertext);
        if (sent) {
          return true;
        }
      } catch (error) {
        console.warn('[P2P] Failed to send via P2P, falling back to server:', error);
      }
    }

    // Fallback to server relay
    return false;
  }

  /**
   * Send message via P2P connection
   */
  private async sendViaP2P(
    conversationId: string,
    recipientUserId: string,
    message: Message,
    encryptedCiphertext: string
  ): Promise<boolean> {
    // Check if we have an active P2P connection
    const connection = this.connections.get(recipientUserId);
    if (!connection || !connection.isConnected) {
      // Try to establish P2P connection
      const established = await this.establishP2PConnection(recipientUserId, conversationId);
      if (!established) {
        return false;
      }
    }

    // Send encrypted message via P2P
    const p2pConnection = this.connections.get(recipientUserId);
    if (p2pConnection && p2pConnection.socket) {
      p2pConnection.socket.emit('p2p_message', {
        conversationId,
        message: {
          id: message.id,
          ciphertext: encryptedCiphertext,
          senderId: message.senderId,
          timestamp: message.timestamp.toISOString(),
          messageType: message.messageType || 'text',
        },
      });
      return true;
    }

    return false;
  }

  /**
   * Establish P2P connection with a user
   */
  private async establishP2PConnection(
    userId: string,
    conversationId: string
  ): Promise<boolean> {
    try {
      // Request P2P connection via signaling server
      if (this.mainSocket) {
        this.mainSocket.emit('p2p_request', {
          to: userId,
          conversationId,
        });
      }

      // TODO: Implement WebRTC connection establishment
      // This is a simplified version - in production, use proper WebRTC

      return false; // Placeholder
    } catch (error) {
      console.error('[P2P] Error establishing connection:', error);
      return false;
    }
  }

  /**
   * Handle P2P offer
   */
  private async handleP2POffer(
    from: string,
    offer: any,
    conversationId: string
  ): Promise<void> {
    // TODO: Implement WebRTC offer handling
    console.log('[P2P] Received offer from:', from);
  }

  /**
   * Handle P2P answer
   */
  private async handleP2PAnswer(
    from: string,
    answer: any,
    conversationId: string
  ): Promise<void> {
    // TODO: Implement WebRTC answer handling
    console.log('[P2P] Received answer from:', from);
  }

  /**
   * Handle ICE candidate
   */
  private async handleICECandidate(
    from: string,
    candidate: any,
    conversationId: string
  ): Promise<void> {
    // TODO: Implement ICE candidate handling
    console.log('[P2P] Received ICE candidate from:', from);
  }

  /**
   * Cleanup connections
   */
  cleanup(): void {
    this.connections.forEach(conn => {
      if (conn.socket) {
        conn.socket.disconnect();
      }
    });
    this.connections.clear();

    if (this.mainSocket) {
      this.mainSocket.disconnect();
      this.mainSocket = null;
    }
  }
}

export const p2pManager = new P2PManager();

