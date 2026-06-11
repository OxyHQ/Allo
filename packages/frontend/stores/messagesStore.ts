import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { api } from '@/utils/api';
import { useDeviceKeysStore } from './deviceKeysStore';
import {
  storeMessagesLocally,
  getMessagesLocally,
  addMessageLocally,
  updateMessageLocally,
  removeMessageLocally,
  addToSyncQueue,
} from '@/lib/offlineStorage';
import { p2pManager, type P2PMessageEnvelope } from '@/lib/p2pMessaging';
import NetInfo from '@react-native-community/netinfo';
import i18n from '@/lib/i18n';
import {
  ENCRYPTION_VERSION_ENVELOPES,
  type MessageEnvelopeDTO,
  type DeviceTarget,
} from '@allo/shared-types';

/** Placeholder shown when a legacy/undecryptable message can't be read. */
const PLACEHOLDER_UNDECRYPTABLE = '[Mensaje no descifrable]';
/** Placeholder shown when decryption of an otherwise-valid ciphertext failed. */
const PLACEHOLDER_DECRYPT_FAILED = '[Encrypted - Decryption failed]';

/** English fallback if i18n is not yet initialized (keeps UI from rendering empty). */
const ENVELOPE_MISSING_FALLBACK = 'Sent before this device was linked';

/** Resolve the localized "sent before this device was linked" placeholder. */
function envelopeMissingText(): string {
  const translated = i18n.t('messages.sentBeforeDeviceLinked');
  // i18next returns the key (or undefined) when uninitialized / key missing.
  return translated && translated !== 'messages.sentBeforeDeviceLinked'
    ? translated
    : ENVELOPE_MISSING_FALLBACK;
}

/** Server error code returned when our cached device list is out of date. */
const STALE_DEVICE_LIST_ERROR = 'stale_device_list';

/**
 * Resolve the set of participant user ids (including self) for a conversation.
 * Returns null when the conversation is unknown locally — the caller then has no
 * basis for multi-device fan-out and must surface an error.
 */
function resolveParticipantUserIds(conversationId: string, senderId: string): string[] | null {
  try {
    const { useConversationsStore } = require('./conversationsStore');
    const conversation = useConversationsStore.getState().conversationsById[conversationId];
    if (!conversation) return null;
    const ids = new Set<string>([senderId]);
    for (const participant of conversation.participants || []) {
      if (participant.id) ids.add(participant.id);
    }
    return Array.from(ids);
  } catch (error) {
    console.warn('[Messages] Failed to resolve conversation participants:', error);
    return null;
  }
}

/** True when the recipient's active device count makes the P2P path eligible. */
async function isP2PEligible(
  conversationId: string,
  recipientUserId: string,
  ownUserId: string
): Promise<boolean> {
  try {
    const { useConversationsStore } = require('./conversationsStore');
    const conversation = useConversationsStore.getState().conversationsById[conversationId];
    if (!conversation || conversation.type !== 'direct') return false;

    const deviceKeysStore = useDeviceKeysStore.getState();
    const devicesByUser = await deviceKeysStore.getDevicesForUsers([ownUserId, recipientUserId]);
    const ownDevices = devicesByUser.get(ownUserId)?.length || 0;
    const recipientDevices = devicesByUser.get(recipientUserId)?.length || 0;
    // P2P data channels are 1:1 — only safe when both sides have exactly one
    // active device, otherwise other devices would silently miss the message.
    return ownDevices === 1 && recipientDevices === 1;
  } catch (error) {
    console.warn('[Messages] P2P eligibility check failed:', error);
    return false;
  }
}

/** True when a thrown error carries the backend's stale-device-list signal. */
function isStaleDeviceListError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const response = (error as { response?: { status?: number; data?: { error?: string } } }).response;
  return response?.status === 409 && response?.data?.error === STALE_DEVICE_LIST_ERROR;
}

/**
 * Build the data payload persisted to the offline sync queue for a send. For v3
 * we persist the full envelope set so a replay POSTs the exact fan-out; for the
 * deviceless plaintext fallback we persist the plaintext.
 */
function buildQueuedSendData(
  conversationId: string,
  senderDeviceId: number,
  isEncrypted: boolean,
  envelopes: MessageEnvelopeDTO[],
  plaintext: string,
  extraPayload: Record<string, unknown>
): Record<string, unknown> {
  return {
    conversationId,
    senderDeviceId,
    ...(isEncrypted
      ? { encryptionVersion: ENCRYPTION_VERSION_ENVELOPES, envelopes }
      : { text: plaintext }),
    ...extraPayload,
  };
}

/** Outcome of preparing a message for multi-device fan-out. */
interface EncryptionResult {
  /** Per-device envelopes (v3). Empty when falling back to plaintext. */
  envelopes: MessageEnvelopeDTO[];
  /** Per-device failures tolerated during fan-out (own other devices). */
  failures: DeviceTarget[];
  /** True when no recipient device exists at all and we must send plaintext. */
  plaintextFallback: boolean;
}

/**
 * Encrypt `plaintext` into per-device envelopes for every participant device.
 * Returns `plaintextFallback: true` only when the recipients are genuinely
 * deviceless (no registered devices) so the caller can degrade to plaintext.
 */
async function encryptEnvelopes(
  conversationId: string,
  plaintext: string,
  senderId: string
): Promise<EncryptionResult> {
  const participantUserIds = resolveParticipantUserIds(conversationId, senderId);
  if (!participantUserIds) {
    throw new Error('Conversation not found locally; cannot resolve recipients.');
  }

  const deviceKeysStore = useDeviceKeysStore.getState();
  try {
    const { envelopes, failures } = await deviceKeysStore.encryptForConversation(
      plaintext,
      participantUserIds,
      senderId
    );
    if (envelopes.length === 0) {
      // No recipient device produced an envelope. This only happens when every
      // recipient is deviceless — fall back to plaintext (logged loudly).
      console.warn(
        '[Messages] No recipient devices for conversation; sending plaintext (less secure).',
        { conversationId, participantUserIds }
      );
      return { envelopes: [], failures, plaintextFallback: true };
    }
    return { envelopes, failures, plaintextFallback: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown encryption error';
    if (message.includes('No devices found') || message.includes('No preKeys')) {
      console.warn(
        '[Messages] Recipient has no registered devices; sending plaintext (less secure).',
        { conversationId }
      );
      return { envelopes: [], failures: [], plaintextFallback: true };
    }
    throw error;
  }
}

/**
 * POST a v3 envelope message. On a `409 stale_device_list` the device cache is
 * invalidated, the message is re-encrypted from scratch and the send is retried
 * exactly once with the freshly-built envelope set (never appended).
 */
async function postEnvelopeMessage(
  conversationId: string,
  plaintext: string,
  senderId: string,
  senderDeviceId: number,
  envelopes: MessageEnvelopeDTO[],
  extraPayload: Record<string, unknown>
): Promise<{ data: unknown }> {
  const buildPayload = (envs: MessageEnvelopeDTO[]): Record<string, unknown> => ({
    conversationId,
    senderDeviceId,
    encryptionVersion: ENCRYPTION_VERSION_ENVELOPES,
    envelopes: envs,
    ...extraPayload,
  });

  try {
    return await api.post('/messages', buildPayload(envelopes));
  } catch (error) {
    if (!isStaleDeviceListError(error)) throw error;

    // Stale device list: drop the cache for the participants and re-encrypt with
    // the authoritative device set, then retry ONCE.
    console.warn('[Messages] Stale device list; refreshing devices and retrying send once.');
    const participantUserIds = resolveParticipantUserIds(conversationId, senderId) || [];
    useDeviceKeysStore.getState().invalidateDeviceCache(participantUserIds);

    const retry = await encryptEnvelopes(conversationId, plaintext, senderId);
    if (retry.plaintextFallback || retry.envelopes.length === 0) {
      throw new Error('Failed to re-encrypt message after device list refresh.');
    }
    return api.post('/messages', buildPayload(retry.envelopes));
  }
}

/**
 * Messages Store with Signal Protocol Encryption
 *
 * Features:
 * - End-to-end encryption using Signal Protocol
 * - Offline-first storage (device-first)
 * - Optional cloud sync
 * - P2P messaging when available
 *
 * NOTE: Removed subscribeWithSelector middleware to fix getSnapshot error
 */

export interface MediaItem {
  id: string;
  type: 'image' | 'video' | 'gif' | 'audio' | 'file';
  url?: string;
  thumbnailUrl?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface LocationData {
  latitude: number;
  longitude: number;
  address?: string;
  label?: string;
}

export interface ContactData {
  name: string;
  phones?: string[];
  emails?: string[];
  userId?: string;
}

export interface PollOption {
  text: string;
  votes: string[];
}

export interface PollData {
  question: string;
  options: PollOption[];
  multi: boolean;
  closed?: boolean;
}

export type AttachmentType =
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'location'
  | 'contact'
  | 'poll'
  | 'gif';

export interface StickerItem {
  id: string;
  /** URL string, local require() asset (number for images, object for JSON), or Lottie JSON object */
  source: string | number | object;
  /** Optional emoji fallback if Lottie fails to load */
  emoji?: string;
  /** Sticker pack identifier */
  packId?: string;
}

export interface Message {
  id: string;
  text: string;
  senderId: string;
  senderDeviceId?: number;
  senderName?: string;
  timestamp: Date;
  isSent: boolean;
  conversationId: string;
  messageType?: 'user' | 'ai';
  media?: MediaItem[];
  sticker?: StickerItem;
  fontSize?: number;
  replyTo?: string; // Message ID this is replying to
  reactions?: Record<string, string[]>; // emoji -> array of userIds
  // Encryption metadata
  isEncrypted?: boolean;
  ciphertext?: string;
  encryptionVersion?: number;
  // Read receipt status
  readStatus?: 'pending' | 'sent' | 'delivered' | 'read';
  // Edit/forward metadata
  editedAt?: Date;
  forwardedFrom?: string;
  // Structured attachment payload (public — not encrypted)
  attachmentType?: AttachmentType;
  location?: LocationData;
  contact?: ContactData;
  poll?: PollData;
  // Local-only flag for "delete for me"
  locallyDeleted?: boolean;
}

export interface AttachmentPayload {
  attachmentType: AttachmentType;
  text?: string;
  media?: MediaItem[];
  location?: LocationData;
  contact?: ContactData;
  poll?: PollData;
  forwardedFrom?: string;
}

/** Raw message document as returned by the backend (already device-hydrated). */
interface RawServerMessage {
  _id?: string;
  id?: string;
  conversationId: string;
  senderId: string;
  senderDeviceId?: number;
  text?: string;
  ciphertext?: string | null;
  encryptionVersion?: number;
  /** v3: set by the backend when this device has no envelope for the message. */
  envelopeMissing?: boolean;
  fontSize?: number;
  createdAt: string;
  updatedAt?: string;
  editedAt?: string;
  messageType?: string;
  media?: MediaItem[];
  sticker?: StickerItem;
  attachmentType?: AttachmentType;
  location?: LocationData;
  contact?: ContactData;
  poll?: PollData;
  forwardedFrom?: string;
  replyTo?: string;
  reactions?: Record<string, string[]>;
  readBy?: Record<string, string>;
  deliveredTo?: string[];
}

type ReadStatus = 'pending' | 'sent' | 'delivered' | 'read';

/** Derive the sender-side read status for a message we authored. */
function computeReadStatus(msg: RawServerMessage, currentUserId?: string): ReadStatus | undefined {
  if (!currentUserId || msg.senderId !== currentUserId) return undefined;
  if (msg.readBy && typeof msg.readBy === 'object') {
    const recipientRead = Object.keys(msg.readBy).some((id) => id !== currentUserId);
    if (recipientRead) return 'read';
  }
  if (Array.isArray(msg.deliveredTo)) {
    const recipientDelivered = msg.deliveredTo.some((id) => id !== currentUserId);
    return recipientDelivered ? 'delivered' : 'sent';
  }
  return 'sent';
}

/** Map the common (non-text) fields of a raw server message onto a Message. */
function mapCommonMessageFields(msg: RawServerMessage, currentUserId?: string): Omit<Message, 'text' | 'isEncrypted'> {
  return {
    id: msg._id || msg.id || '',
    senderId: msg.senderId,
    senderDeviceId: msg.senderDeviceId,
    timestamp: new Date(msg.createdAt),
    isSent: msg.senderId === currentUserId,
    conversationId: msg.conversationId,
    fontSize: msg.fontSize,
    readStatus: computeReadStatus(msg, currentUserId),
    messageType: msg.messageType === 'ai' ? 'ai' : 'user',
    media: msg.media,
    sticker: msg.sticker,
    attachmentType: msg.attachmentType,
    location: msg.location,
    contact: msg.contact,
    poll: msg.poll,
    forwardedFrom: msg.forwardedFrom,
    editedAt: msg.editedAt ? new Date(msg.editedAt) : undefined,
    replyTo: msg.replyTo,
    reactions: msg.reactions,
  };
}

/**
 * Transform one raw server message into a local Message, decrypting when needed.
 *
 * Multi-device aware:
 *  - v3 messages with a missing/null envelope (`envelopeMissing`) render a
 *    placeholder and are NEVER decrypted (no retry loop — the key is gone).
 *  - Own messages from another device WITH an envelope decrypt normally (the
 *    sender's other device encrypted to us), and are marked `isSent`.
 */
async function transformServerMessage(
  msg: RawServerMessage,
  currentUserId: string | undefined,
  decrypt: (ciphertext: string, senderUserId: string, senderDeviceId: number) => Promise<string>
): Promise<Message | null> {
  const isEnvelopeVersion = msg.encryptionVersion === ENCRYPTION_VERSION_ENVELOPES;

  // v3 with no envelope for this device: show the placeholder, never decrypt.
  if (isEnvelopeVersion && (msg.envelopeMissing || !msg.ciphertext)) {
    return {
      ...mapCommonMessageFields(msg, currentUserId),
      text: envelopeMissingText(),
      isEncrypted: false,
    };
  }

  // No ciphertext at all → plaintext / structured attachment message.
  if (!msg.ciphertext) {
    return {
      ...mapCommonMessageFields(msg, currentUserId),
      text: msg.text || '',
      isEncrypted: false,
    };
  }

  // Encrypted message. For v3 own-other-device messages the sender encrypted an
  // envelope TO us, so decryption with peer = (sender, senderDeviceId) works.
  if (!msg.senderId || !msg.senderDeviceId) {
    console.warn('[Messages] Encrypted server message missing sender identity:', msg._id || msg.id);
    return null;
  }

  try {
    const decryptedText = await decrypt(msg.ciphertext, msg.senderId, msg.senderDeviceId);
    return {
      ...mapCommonMessageFields(msg, currentUserId),
      text: decryptedText,
      isEncrypted: false,
    };
  } catch (error) {
    console.error('[Messages] Error decrypting server message:', error);
    const errMsg = error instanceof Error ? error.message : '';
    const friendly = errMsg.includes(PLACEHOLDER_UNDECRYPTABLE)
      ? PLACEHOLDER_UNDECRYPTABLE
      : PLACEHOLDER_DECRYPT_FAILED;
    return {
      ...mapCommonMessageFields(msg, currentUserId),
      text: friendly,
      isEncrypted: true,
    };
  }
}

interface MessagesState {
  // Data: messages organized by conversation ID
  messagesByConversation: Record<string, Message[]>;
  // O(1) dedup: Set of message IDs per conversation (WhatsApp/Telegram pattern)
  messageIdsByConversation: Record<string, Set<string>>;

  // Loading states by conversation
  loadingByConversation: Record<string, boolean>;
  errorByConversation: Record<string, string | null>;

  // Last updated timestamps by conversation
  lastUpdatedByConversation: Record<string, number>;

  // Cloud sync enabled
  cloudSyncEnabled: boolean;
  
  // Actions
  setMessages: (conversationId: string, messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  removeMessage: (conversationId: string, messageId: string) => void;
  clearMessages: (conversationId: string) => void;
  setCloudSyncEnabled: (enabled: boolean) => void;
  addReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  removeReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  
  // Async actions
  fetchMessages: (conversationId: string, currentUserId?: string) => Promise<void>;
  sendMessage: (
    conversationId: string,
    text: string,
    senderId: string,
    recipientUserId: string,
    fontSize?: number
  ) => Promise<Message | null>;
  sendAttachmentMessage: (
    conversationId: string,
    payload: AttachmentPayload,
    senderId: string,
    recipientUserId: string
  ) => Promise<Message | null>;
  deleteMessageForScope: (
    conversationId: string,
    messageId: string,
    scope: 'me' | 'everyone'
  ) => Promise<boolean>;
  voteInPoll: (
    conversationId: string,
    messageId: string,
    optionIndexes: number[]
  ) => Promise<boolean>;

  // Selectors
  getMessages: (conversationId: string) => Message[];
  getLatestMessage: (conversationId: string) => Message | undefined;
  isLoading: (conversationId: string) => boolean;
  getError: (conversationId: string) => string | null;

  // Lifecycle
  reset: () => void;
}

export const useMessagesStore = create<MessagesState>()(
  immer((set, get) => ({
    // Initial state
    messagesByConversation: {},
    messageIdsByConversation: {},
    loadingByConversation: {},
    errorByConversation: {},
    lastUpdatedByConversation: {},
    cloudSyncEnabled: true, // Enable cloud sync by default for reliable messaging

    // Actions
    setMessages: async (conversationId, messages) => {
      const idSet = new Set(messages.map(m => m.id));
      set((state) => {
        state.messagesByConversation[conversationId] = messages;
        state.messageIdsByConversation[conversationId] = idSet;
        state.lastUpdatedByConversation[conversationId] = Date.now();
        state.errorByConversation[conversationId] = null;
      });
      
      // Store locally (offline-first) - don't await, do in background
      storeMessagesLocally(conversationId, messages).catch(() => {});
      
      // Update conversation's lastMessage if we have decrypted messages (synchronous, efficient)
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage.text && !lastMessage.isEncrypted && lastMessage.text !== '[Encrypted]') {
          // Use require for synchronous access (faster than async import)
          try {
            const { useConversationsStore } = require('./conversationsStore');
            const { useUsersStore } = require('./usersStore');
            const conversationsStore = useConversationsStore.getState();
            const conversation = conversationsStore.conversationsById[conversationId];
            
            if (conversation) {
              // Format with sender name for groups (O(1) lookup from cache)
              let formattedText = lastMessage.text;
              if (conversation.type === 'group' && lastMessage.senderId) {
                const usersStore = useUsersStore.getState();
                const senderUser = usersStore.getCachedById(lastMessage.senderId);
                const participant = conversation.participants?.find(p => p.id === lastMessage.senderId);
                
                let senderName: string | undefined;
                if (senderUser) {
                  if (typeof senderUser.name === 'string') {
                    senderName = senderUser.name.split(' ')[0];
                  } else if (senderUser.name?.first) {
                    senderName = senderUser.name.first;
                  } else if (senderUser.username || senderUser.handle) {
                    senderName = senderUser.username || senderUser.handle;
                  }
                } else if (participant?.name?.first) {
                  senderName = participant.name.first;
                } else if (participant?.username) {
                  senderName = participant.username;
                }
                
                if (senderName) {
                  formattedText = `${senderName}: ${lastMessage.text}`;
                }
              }
              
              conversationsStore.updateConversation(conversationId, {
                lastMessage: formattedText,
                timestamp: lastMessage.timestamp.toISOString(),
              });
            }
          } catch (error) {
            // Silently fail
          }
        }
      }
    },

    addMessage: async (message) => {
      set((state) => {
        const idSet = state.messageIdsByConversation[message.conversationId] || new Set();

        // O(1) dedup check (WhatsApp/Telegram pattern)
        if (idSet.has(message.id)) {
          return state;
        }

        const existing = state.messagesByConversation[message.conversationId] || [];
        state.messagesByConversation[message.conversationId] = [...existing, message];

        const newIdSet = new Set(idSet);
        newIdSet.add(message.id);
        state.messageIdsByConversation[message.conversationId] = newIdSet;
        state.lastUpdatedByConversation[message.conversationId] = Date.now();
      });
      
      // Store locally - don't await, do in background
      addMessageLocally(message).catch(() => {});
      
      // Update conversation's lastMessage if this is a decrypted message (synchronous, efficient)
      if (message.text && !message.isEncrypted && message.text !== '[Encrypted]') {
        try {
          const { useConversationsStore } = require('./conversationsStore');
          const { useUsersStore } = require('./usersStore');
          const conversationsStore = useConversationsStore.getState();
          const conversation = conversationsStore.conversationsById[message.conversationId];
          
          if (conversation) {
            // Format with sender name for groups (O(1) lookup from cache)
            let formattedText = message.text;
            if (conversation.type === 'group' && message.senderId) {
              const usersStore = useUsersStore.getState();
              const senderUser = usersStore.getCachedById(message.senderId);
              const participant = conversation.participants?.find(p => p.id === message.senderId);
              
              let senderName: string | undefined;
              if (senderUser) {
                if (typeof senderUser.name === 'string') {
                  senderName = senderUser.name.split(' ')[0];
                } else if (senderUser.name?.first) {
                  senderName = senderUser.name.first;
                } else if (senderUser.username || senderUser.handle) {
                  senderName = senderUser.username || senderUser.handle;
                }
              } else if (participant?.name?.first) {
                senderName = participant.name.first;
              } else if (participant?.username) {
                senderName = participant.username;
              }
              
              if (senderName) {
                formattedText = `${senderName}: ${message.text}`;
              }
            }
            
            conversationsStore.updateConversation(message.conversationId, {
              lastMessage: formattedText,
              timestamp: message.timestamp.toISOString(),
            });
          }
        } catch (error) {
          // Silently fail
        }
      }
    },

    updateMessage: async (conversationId, messageId, updates) => {
      set((state) => {
        const messages = state.messagesByConversation[conversationId] || [];
        state.messagesByConversation[conversationId] = messages.map(msg =>
          msg.id === messageId ? { ...msg, ...updates } : msg
        );
        state.lastUpdatedByConversation[conversationId] = Date.now();
      });
      
      // Update locally
      await updateMessageLocally(conversationId, messageId, updates);
    },

    removeMessage: async (conversationId, messageId) => {
      set((state) => {
        const messages = state.messagesByConversation[conversationId] || [];
        state.messagesByConversation[conversationId] = messages.filter(msg => msg.id !== messageId);

        const newIdSet = new Set(state.messageIdsByConversation[conversationId] || []);
        newIdSet.delete(messageId);
        state.messageIdsByConversation[conversationId] = newIdSet;
        state.lastUpdatedByConversation[conversationId] = Date.now();
      });
      
      // Remove locally
      await removeMessageLocally(conversationId, messageId);
    },

    clearMessages: (conversationId) => {
      set((state) => {
        delete state.messagesByConversation[conversationId];
        delete state.messageIdsByConversation[conversationId];
        delete state.loadingByConversation[conversationId];
        delete state.errorByConversation[conversationId];
        delete state.lastUpdatedByConversation[conversationId];
      });
    },

    setCloudSyncEnabled: (enabled) => {
      set({ cloudSyncEnabled: enabled });
    },

    // Async actions
    fetchMessages: async (conversationId, currentUserId?) => {
      const currentState = get();
      if (currentState.loadingByConversation[conversationId]) {
        return;
      }

      // TELEGRAM/WHATSAPP PATTERN: Only show loading if no cached messages
      // Otherwise show cached and fetch in background
      const hasCache = (currentState.messagesByConversation[conversationId]?.length || 0) > 0;

      if (!hasCache) {
        set((state) => {
          state.loadingByConversation[conversationId] = true;
          state.errorByConversation[conversationId] = null;
        });
      }

      try {
        const deviceKeysStore = useDeviceKeysStore.getState();
        const decrypt = deviceKeysStore.decryptMessageFromSender;

        // Always load from local storage first (offline-first). Decrypt only the
        // local entries that are still encrypted — own messages and previously
        // decrypted entries are kept verbatim (Double Ratchet keys are one-shot,
        // so re-decrypting an already-decrypted ciphertext would fail).
        const localMessages = await getMessagesLocally(conversationId);

        const decryptedLocal = await Promise.all(
          localMessages.map(async (msg) => {
            if (msg.senderId === currentUserId) return msg;
            if (msg.isEncrypted && msg.ciphertext && msg.senderId && msg.senderDeviceId) {
              try {
                const decryptedText = await decrypt(msg.ciphertext, msg.senderId, msg.senderDeviceId);
                return { ...msg, text: decryptedText, isEncrypted: false };
              } catch (error) {
                console.error('[Messages] Error decrypting local message:', error);
                const errMsg = error instanceof Error ? error.message : '';
                const friendly = errMsg.includes(PLACEHOLDER_UNDECRYPTABLE)
                  ? PLACEHOLDER_UNDECRYPTABLE
                  : PLACEHOLDER_DECRYPT_FAILED;
                return { ...msg, text: friendly };
              }
            }
            return msg;
          })
        );

        if (decryptedLocal.length > 0) {
          get().setMessages(conversationId, decryptedLocal);
        }

        // Index the (decrypted) local copies by id so we can both DEDUP server
        // decryption and let local entries win the merge.
        const localById = new Map<string, Message>(decryptedLocal.map((m) => [m.id, m]));

        // If cloud sync is enabled, fetch from server
        if (get().cloudSyncEnabled) {
          try {
            const netInfo = await NetInfo.fetch();
            if (netInfo.isConnected) {
              const response = await api.get('/messages', { conversationId });
              const serverMessages: RawServerMessage[] = response.data.messages || [];

              const processedServerMessages = await Promise.all(
                serverMessages.map(async (msg): Promise<Message | null> => {
                  const id = msg._id || msg.id || '';
                  // DEDUP-BEFORE-DECRYPT: if we already hold a successfully
                  // decrypted copy, reuse it and never touch the ratchet again.
                  const local = localById.get(id);
                  if (local && !local.isEncrypted) {
                    return null;
                  }
                  return transformServerMessage(msg, currentUserId, decrypt);
                })
              );

              const freshServerMessages = processedServerMessages.filter(
                (msg): msg is Message => msg !== null
              );

              // Merge: local already-decrypted copies win; server supplies new
              // messages and refreshes still-encrypted local entries.
              const merged = new Map<string, Message>();
              for (const msg of freshServerMessages) merged.set(msg.id, msg);
              for (const msg of decryptedLocal) {
                const existing = merged.get(msg.id);
                if (!existing || !msg.isEncrypted) merged.set(msg.id, msg);
              }

              const uniqueMessages = Array.from(merged.values()).sort(
                (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
              );

              get().setMessages(conversationId, uniqueMessages);
            }
          } catch (error) {
            console.warn('[Messages] Error fetching from server (using local):', error);
          }
        }

        set((state) => {
          state.loadingByConversation[conversationId] = false;
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch messages';
        set((state) => {
          state.loadingByConversation[conversationId] = false;
          state.errorByConversation[conversationId] = errorMessage;
        });
      }
    },

    sendMessage: async (conversationId, text, senderId, recipientUserId, fontSize) => {
      try {
        const deviceKeysStore = useDeviceKeysStore.getState();
        const deviceKeys = deviceKeysStore.deviceKeys;
        
        if (!deviceKeys) {
          // Try to initialize device keys if not already initialized
          if (!deviceKeysStore.isInitialized && !deviceKeysStore.isLoading) {
            try {
              console.log('[Messages] Initializing device keys...');
              await deviceKeysStore.initialize();
              
              // Wait a bit for state to update
              await new Promise(resolve => setTimeout(resolve, 100));
              
              // Re-check device keys after initialization
              const updatedStore = useDeviceKeysStore.getState();
              console.log('[Messages] Device keys after init:', {
                hasKeys: !!updatedStore.deviceKeys,
                isInitialized: updatedStore.isInitialized,
                isLoading: updatedStore.isLoading,
                error: updatedStore.error,
              });
              
              if (!updatedStore.deviceKeys) {
                const errorMsg = updatedStore.error || 'Device keys initialization completed but keys are missing';
                console.error('[Messages] Device keys initialization failed:', errorMsg);
                throw new Error(`Encryption setup failed: ${errorMsg}. Please refresh the page and try again.`);
              }
            } catch (initError) {
              console.error('[Messages] Error initializing device keys:', initError);
              const errorMessage = initError instanceof Error ? initError.message : 'Unknown error';
              throw new Error(`Encryption setup failed: ${errorMessage}. Please refresh the page and try again.`);
            }
          } else if (deviceKeysStore.isLoading) {
            throw new Error('Encryption is initializing. Please wait a moment and try again.');
          } else if (deviceKeysStore.error) {
            throw new Error(`Encryption error: ${deviceKeysStore.error}. Please refresh the page.`);
          } else {
            throw new Error('Encryption not ready. Please wait a moment and try again.');
          }
        }
        
        // Re-get device keys in case they were just initialized
        const finalDeviceKeys = useDeviceKeysStore.getState().deviceKeys;
        if (!finalDeviceKeys) {
          const storeState = useDeviceKeysStore.getState();
          const errorDetails = storeState.error 
            ? ` Error: ${storeState.error}` 
            : ' Please check the console for details.';
          throw new Error(`Encryption not available.${errorDetails}`);
        }

        const plaintext = text.trim();

        // Encrypt one envelope per recipient device (multi-device fan-out). Falls
        // back to plaintext only when the recipients are genuinely deviceless.
        const { envelopes, plaintextFallback } = await encryptEnvelopes(
          conversationId,
          plaintext,
          senderId
        );
        const isEncrypted = !plaintextFallback;

        // Create message object with pending status (will update when sent).
        // Locally we keep the plaintext for display; the ciphertext stays in the
        // per-device envelopes (never persisted as a single blob for v3).
        const message: Message = {
          id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          text: plaintext,
          senderId,
          senderDeviceId: finalDeviceKeys.deviceId,
          timestamp: new Date(),
          isSent: true,
          conversationId,
          fontSize,
          isEncrypted: false, // stored locally as decrypted plaintext
          readStatus: 'pending',
          ...(isEncrypted ? { encryptionVersion: ENCRYPTION_VERSION_ENVELOPES } : {}),
        };

        // Add to local storage immediately (offline-first)
        get().addMessage(message);

        // P2P fast path: only when both sides have exactly one active device and
        // this is a direct conversation. Otherwise relay so every device receives
        // its own envelope.
        const netInfo = await NetInfo.fetch();
        if (netInfo.isConnected && isEncrypted) {
          const p2pEligible = await isP2PEligible(conversationId, recipientUserId, senderId);
          if (p2pEligible) {
            try {
              const soleEnvelope = envelopes.find((e) => e.recipientUserId === recipientUserId);
              if (soleEnvelope) {
                const p2pEnvelope: P2PMessageEnvelope = {
                  type: 'msg',
                  clientMessageId: message.id,
                  conversationId,
                  senderId,
                  senderDeviceId: finalDeviceKeys.deviceId,
                  timestamp: message.timestamp.toISOString(),
                  messageType: 'text',
                  fontSize,
                  isEncrypted: true,
                  ciphertext: soleEnvelope.ciphertext,
                };
                const sentViaP2P = p2pManager.sendMessage(recipientUserId, p2pEnvelope);
                if (sentViaP2P) {
                  get().updateMessage(conversationId, message.id, { readStatus: 'sent' });
                  return message;
                }
              }
            } catch (error) {
              console.warn('[Messages] P2P send failed, using server:', error);
            }
          }
        }

        const baseServerData: Record<string, unknown> = {
          messageType: 'text',
          fontSize,
        };

        // Fallback to server (if cloud sync enabled)
        if (netInfo.isConnected && get().cloudSyncEnabled) {
          try {
            if (isEncrypted) {
              await postEnvelopeMessage(
                conversationId,
                plaintext,
                senderId,
                finalDeviceKeys.deviceId,
                envelopes,
                baseServerData
              );
            } else {
              await api.post('/messages', {
                conversationId,
                senderDeviceId: finalDeviceKeys.deviceId,
                text: plaintext,
                ...baseServerData,
              });
            }
            get().updateMessage(conversationId, message.id, { readStatus: 'sent' });
          } catch (error) {
            console.error('[Messages] Error sending to server:', error);
            // Keep as 'pending' if send fails — queue a directly-postable v3
            // payload (the freshly-built envelope set) so a future replay sends
            // exactly this fan-out rather than a stale single blob.
            await addToSyncQueue({
              type: 'send_message',
              conversationId,
              data: buildQueuedSendData(
                conversationId,
                finalDeviceKeys.deviceId,
                isEncrypted,
                envelopes,
                plaintext,
                baseServerData
              ),
            });
          }
        }

        // If offline or cloud sync disabled, add to sync queue
        if (!netInfo.isConnected || !get().cloudSyncEnabled) {
          await addToSyncQueue({
            type: 'send_message',
            conversationId,
            data: buildQueuedSendData(
              conversationId,
              finalDeviceKeys.deviceId,
              isEncrypted,
              envelopes,
              plaintext,
              baseServerData
            ),
          });
        }

        return message;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to send message';
        set((state) => ({
          errorByConversation: {
            ...state.errorByConversation,
            [conversationId]: errorMessage,
          },
        }));
        return null;
      }
    },

    sendAttachmentMessage: async (conversationId, payload, senderId, recipientUserId) => {
      try {
        const deviceKeysStore = useDeviceKeysStore.getState();
        if (!deviceKeysStore.deviceKeys && !deviceKeysStore.isInitialized && !deviceKeysStore.isLoading) {
          try {
            await deviceKeysStore.initialize();
            await new Promise((r) => setTimeout(r, 100));
          } catch (e) {
            console.warn('[Messages] Attachment send: device keys init failed:', e);
          }
        }
        const finalDeviceKeys = useDeviceKeysStore.getState().deviceKeys;
        if (!finalDeviceKeys) {
          throw new Error('Encryption not available. Please try again.');
        }

        const captionText = (payload.text || '').trim();

        // Only the caption is encrypted. Media/structured payloads are public.
        // A captioned message fans out one envelope per recipient device (v3);
        // a caption-less attachment is sent without any ciphertext.
        let envelopes: MessageEnvelopeDTO[] = [];
        let isEncrypted = false;
        if (captionText.length > 0) {
          try {
            const result = await encryptEnvelopes(conversationId, captionText, senderId);
            if (!result.plaintextFallback && result.envelopes.length > 0) {
              envelopes = result.envelopes;
              isEncrypted = true;
            }
          } catch (error) {
            console.warn('[Messages] Attachment caption encryption failed:', error);
          }
        }

        const localMessage: Message = {
          id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          text: captionText,
          senderId,
          senderDeviceId: finalDeviceKeys.deviceId,
          timestamp: new Date(),
          isSent: true,
          conversationId,
          isEncrypted: false, // stored locally as decrypted plaintext caption
          readStatus: 'pending',
          attachmentType: payload.attachmentType,
          media: payload.media,
          location: payload.location,
          contact: payload.contact,
          poll: payload.poll,
          forwardedFrom: payload.forwardedFrom,
          ...(isEncrypted ? { encryptionVersion: ENCRYPTION_VERSION_ENVELOPES } : {}),
        };

        get().addMessage(localMessage);

        const messageTypeMap: Record<string, string> = {
          location: 'location',
          contact: 'contact',
          poll: 'poll',
          file: 'file',
          audio: 'audio',
          image: 'media',
          video: 'media',
          gif: 'media',
        };

        // Public attachment metadata, shared by both the encrypted (v3) and
        // plaintext send paths.
        const attachmentMeta: Record<string, unknown> = {
          messageType: messageTypeMap[payload.attachmentType] || 'media',
          attachmentType: payload.attachmentType,
          ...(payload.media ? { media: payload.media } : {}),
          ...(payload.location ? { location: payload.location } : {}),
          ...(payload.contact ? { contact: payload.contact } : {}),
          ...(payload.poll ? { poll: payload.poll } : {}),
          ...(payload.forwardedFrom ? { forwardedFrom: payload.forwardedFrom } : {}),
        };

        const handleServerResult = (responseBody: { data?: unknown } | unknown): Message => {
          const body = responseBody as { data?: unknown } | undefined;
          const serverMsg = (body?.data ?? body) as { _id?: string; id?: string; poll?: PollData } | undefined;
          if (serverMsg && (serverMsg._id || serverMsg.id)) {
            const newId = (serverMsg._id || serverMsg.id) as string;
            get().updateMessage(conversationId, localMessage.id, {
              id: newId,
              readStatus: 'sent',
              poll: serverMsg.poll || localMessage.poll,
            });
            set((state) => {
              const idSet = new Set(state.messageIdsByConversation[conversationId] || []);
              idSet.delete(localMessage.id);
              idSet.add(newId);
              state.messageIdsByConversation[conversationId] = idSet;
            });
            return { ...localMessage, id: newId, readStatus: 'sent' };
          }
          get().updateMessage(conversationId, localMessage.id, { readStatus: 'sent' });
          return localMessage;
        };

        const netInfo = await NetInfo.fetch();
        if (netInfo.isConnected && get().cloudSyncEnabled) {
          try {
            let response: { data: unknown };
            if (isEncrypted) {
              response = await postEnvelopeMessage(
                conversationId,
                captionText,
                senderId,
                finalDeviceKeys.deviceId,
                envelopes,
                attachmentMeta
              );
            } else {
              response = await api.post('/messages', {
                conversationId,
                senderDeviceId: finalDeviceKeys.deviceId,
                ...attachmentMeta,
                ...(captionText.length > 0 ? { text: captionText } : {}),
              });
            }
            return handleServerResult(response.data);
          } catch (error) {
            console.error('[Messages] Error sending attachment to server:', error);
            await addToSyncQueue({
              type: 'send_message',
              conversationId,
              data: {
                conversationId,
                senderDeviceId: finalDeviceKeys.deviceId,
                ...attachmentMeta,
                ...(isEncrypted
                  ? { encryptionVersion: ENCRYPTION_VERSION_ENVELOPES, envelopes }
                  : captionText.length > 0
                    ? { text: captionText }
                    : {}),
              },
            });
          }
        } else {
          await addToSyncQueue({
            type: 'send_message',
            conversationId,
            data: {
              conversationId,
              senderDeviceId: finalDeviceKeys.deviceId,
              ...attachmentMeta,
              ...(isEncrypted
                ? { encryptionVersion: ENCRYPTION_VERSION_ENVELOPES, envelopes }
                : captionText.length > 0
                  ? { text: captionText }
                  : {}),
            },
          });
        }

        return localMessage;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to send attachment';
        set((state) => {
          state.errorByConversation[conversationId] = errorMessage;
        });
        return null;
      }
    },

    deleteMessageForScope: async (conversationId, messageId, scope) => {
      try {
        if (scope === 'me') {
          // Optimistically remove locally
          get().removeMessage(conversationId, messageId);
        } else {
          // Mark as tombstone locally (replace content)
          get().updateMessage(conversationId, messageId, {
            text: '',
            media: undefined,
            attachmentType: undefined,
            location: undefined,
            contact: undefined,
            poll: undefined,
            locallyDeleted: true,
          });
        }

        const netInfo = await NetInfo.fetch();
        if (netInfo.isConnected) {
          try {
            await api.delete(`/messages/${messageId}?scope=${scope}`);
            return true;
          } catch (error) {
            console.error('[Messages] Error deleting message:', error);
            // Queue retry
            await addToSyncQueue({
              type: 'delete_message',
              conversationId,
              data: { messageId, scope },
            });
            return false;
          }
        }

        await addToSyncQueue({
          type: 'delete_message',
          conversationId,
          data: { messageId, scope },
        });
        return true;
      } catch (error) {
        console.error('[Messages] deleteMessageForScope error:', error);
        return false;
      }
    },

    voteInPoll: async (conversationId, messageId, optionIndexes) => {
      try {
        const response = await api.post(`/messages/${messageId}/poll/vote`, { optionIndexes });
        const data = response.data?.data || response.data;
        if (data?.poll) {
          get().updateMessage(conversationId, messageId, { poll: data.poll });
          return true;
        }
        return false;
      } catch (error) {
        console.error('[Messages] voteInPoll error:', error);
        return false;
      }
    },

    // Selectors
    getMessages: (conversationId) => {
      return get().messagesByConversation[conversationId] || [];
    },

    getLatestMessage: (conversationId) => {
      const messages = get().getMessages(conversationId);
      return messages.length > 0 ? messages[messages.length - 1] : undefined;
    },

    isLoading: (conversationId) => {
      return get().loadingByConversation[conversationId] || false;
    },

    getError: (conversationId) => {
      return get().errorByConversation[conversationId] || null;
    },

    // Lifecycle: clear all in-memory messages on logout / account switch.
    // Persisted plaintext caches in AsyncStorage are wiped separately by
    // `clearAllOfflineData()` (see `lib/auth/sessionCleanup.ts`).
    reset: () => {
      set((state) => {
        state.messagesByConversation = {};
        state.messageIdsByConversation = {};
        state.loadingByConversation = {};
        state.errorByConversation = {};
        state.lastUpdatedByConversation = {};
        state.cloudSyncEnabled = true;
      });
    },
  }))
);
