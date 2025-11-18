/**
 * Signal Protocol Utilities
 * 
 * Helper functions for Signal Protocol encryption/decryption
 * Note: Actual encryption/decryption happens on the client side.
 * This backend only stores encrypted ciphertext.
 */

/**
 * Validate Signal Protocol message structure
 */
export function validateEncryptedMessage(message: {
  ciphertext?: string;
  encryptedMedia?: Array<any>;
  encryptionVersion?: number;
  messageType?: string;
}): boolean {
  // Must have either ciphertext or encryptedMedia
  if (!message.ciphertext && (!message.encryptedMedia || message.encryptedMedia.length === 0)) {
    return false;
  }

  // Encryption version should be 1 (Signal Protocol)
  if (message.encryptionVersion && message.encryptionVersion !== 1) {
    return false;
  }

  // Message type should be valid
  if (message.messageType && !["text", "media", "system"].includes(message.messageType)) {
    return false;
  }

  return true;
}

/**
 * Check if message is encrypted
 */
export function isEncrypted(message: {
  ciphertext?: string;
  encryptedMedia?: Array<any>;
  text?: string;
  media?: Array<any>;
}): boolean {
  return !!(message.ciphertext || (message.encryptedMedia && message.encryptedMedia.length > 0));
}

/**
 * Get message preview for encrypted messages
 */
export function getMessagePreview(message: {
  ciphertext?: string;
  encryptedMedia?: Array<any>;
  text?: string;
  media?: Array<any>;
}): string {
  if (isEncrypted(message)) {
    if (message.encryptedMedia && message.encryptedMedia.length > 0) {
      return `[Encrypted ${message.encryptedMedia.length} media file(s)]`;
    }
    return "[Encrypted message]";
  }
  
  // Legacy plaintext
  if (message.text) {
    return message.text;
  }
  if (message.media && message.media.length > 0) {
    return `Sent ${message.media.length} media file(s)`;
  }
  
  return "";
}

