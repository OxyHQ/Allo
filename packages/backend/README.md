# @allo/backend

> The backend package of the Allo monorepo - A modern chat API service built with Express.js and TypeScript.

---

## Overview

This is the **backend package** of the **Allo** monorepo. Allo is a modern chat application with **end-to-end encrypted direct messages**, **device-first architecture**, and **optional cloud sync**. The backend provides the API service for messaging, conversations, user settings, and device key management. The backend uses Oxy for authentication, so no user management is needed.

### Key Features

- 🔐 **End-to-End Encryption** - Direct messages are encrypted client-side (static ECDH P-256 + AES-256-GCM) before reaching the server; see [docs/encryption.mdx](../../docs/encryption.mdx) for the full model and known gaps
- 📱 **Device-First Architecture** - Messages stored locally first, cloud is secondary
- ☁️ **Optional Cloud Sync** - Users can enable/disable cloud backup in settings
- 🔑 **Device Key Management** - Device public key bundles and key exchange
- ⚠️ **Plaintext Fallback** - The client falls back to sending plaintext when it can't encrypt a message; the server stores whatever it's given

## Tech Stack

- Node.js with TypeScript
- Express.js for REST API
- MongoDB with Mongoose for data storage
- Socket.IO for real-time messaging
- Oxy Services for authentication (users managed by Oxy platform)

## Getting Started

### Prerequisites

- Node.js 18+ and Bun 1.3+
- MongoDB instance
- Git

### Development Setup

#### Option 1: From the Monorepo Root (Recommended)
```bash
# Clone the repository
git clone https://github.com/OxyHQ/Allo.git
cd Allo

# Install all dependencies
bun install

# Start backend development
bun run dev:backend
```

#### Option 2: From This Package Directory
```bash
# Navigate to this package
cd packages/backend

# Install dependencies
bun install

# Start development server
bun run dev
```

### Environment Configuration

Create a `.env` file in this package directory with the following variables:

```env
# Database
MONGODB_URI=your_mongodb_connection_string

# Server Configuration
PORT=4140
NODE_ENV=development
```

Authentication is handled entirely by `@oxyhq/core`'s Oxy auth middleware and CORS by `createOxyCors` with a built-in allowlist (see `server.ts`) — `OXY_API_URL`, `FRONTEND_URL`, and `JWT_SECRET` are not read anywhere in this package's code, despite appearing in some deployment docs. Don't rely on setting them to change auth or CORS behavior.

### Running the API

#### Development Mode
```bash
bun run dev
```

#### Production Mode
```bash
bun run build
bun run start
```

### Database Setup

The API uses MongoDB with Mongoose. Make sure your MongoDB instance is running and accessible.

## API Endpoints

### Authentication

All authenticated endpoints require a Bearer token from Oxy. The backend uses `@oxyhq/services` for authentication middleware.

### Health Check

#### GET /api/health
- Public endpoint
- Returns: `{ status: "ok", service: "allo-backend" }`

### Conversations

#### GET /api/conversations
- Get all conversations for the authenticated user
- Query params: `limit` (default: 50), `offset` (default: 0)
- Returns: `{ conversations: Conversation[] }`

#### GET /api/conversations/:id
- Get a specific conversation by ID
- Returns: `Conversation`

#### POST /api/conversations
- Create a new conversation
- Body:
```json
{
  "type": "direct" | "group",
  "participantIds": ["user1", "user2"],
  "name": "Group Name", // Optional, for groups only
  "description": "Group description", // Optional, for groups only
  "avatar": "avatar_url" // Optional, for groups only
}
```
- Returns: `Conversation`

#### PUT /api/conversations/:id
- Update a conversation (name, description, avatar for groups)
- Body:
```json
{
  "name": "Updated Name",
  "description": "Updated description",
  "avatar": "new_avatar_url"
}
```

#### POST /api/conversations/:id/participants
- Add participants to a group conversation
- Body: `{ "participantIds": ["user1", "user2"] }`

#### DELETE /api/conversations/:id/participants/:participantId
- Remove a participant from a group conversation

#### POST /api/conversations/:id/archive
- Archive a conversation

#### POST /api/conversations/:id/unarchive
- Unarchive a conversation

#### POST /api/conversations/:id/mark-read
- Mark conversation as read

### Messages

**Important**: Direct messages are end-to-end encrypted client-side (static ECDH P-256 + AES-256-GCM) when the client is able to encrypt them, and the backend stores that ciphertext as-is — it never has the keys to decrypt it. When encryption isn't possible (e.g. the recipient has no registered device), the client falls back to plaintext and the backend stores that too. See [docs/encryption.mdx](../../docs/encryption.mdx) for the full model.

#### GET /api/messages
- Get messages for a conversation
- Returns encrypted messages - client must decrypt them
- Query params:
  - `conversationId` (required)
  - `limit` (default: 50)
  - `before` (ISO date string for pagination)
- Returns: `{ messages: Message[] }` (encrypted)

#### GET /api/messages/:id
- Get a specific message by ID
- Returns: `Message`

#### POST /api/messages
- Send a new message (encrypted or plaintext for backward compatibility)
- Body (encrypted):
```json
{
  "conversationId": "conv_id",
  "senderDeviceId": 1,
  "ciphertext": "base64_encoded_encrypted_message",
  "encryptedMedia": [ // Optional
    {
      "id": "media_id",
      "type": "image" | "video" | "audio" | "file",
      "ciphertext": "base64_encoded_encrypted_media",
      "thumbnailCiphertext": "base64_encoded_encrypted_thumbnail", // Optional
      "fileName": "file.jpg", // Optional
      "fileSize": 1024, // Optional
      "mimeType": "image/jpeg", // Optional
      "width": 1920, // Optional
      "height": 1080, // Optional
      "duration": 120 // Optional, for video/audio
    }
  ],
  "encryptionVersion": 1,
  "messageType": "text" | "media" | "system",
  "replyTo": "message_id", // Optional
  "fontSize": 16 // Optional, custom font size
}
```
- Body (legacy plaintext - deprecated):
```json
{
  "conversationId": "conv_id",
  "senderDeviceId": 1,
  "text": "Message text",
  "media": [...]
}
```
- Returns: `Message`

#### PUT /api/messages/:id
- Edit a message
- Body: `{ "text": "Updated text" }`

#### DELETE /api/messages/:id
- Delete a message (soft delete)

#### POST /api/messages/:id/read
- Mark a message as read

#### POST /api/messages/:id/delivered
- Mark a message as delivered

### Device Management (key registration)

#### GET /api/devices
- Get all devices for the authenticated user
- Returns: `{ devices: Device[] }`

#### GET /api/devices/:deviceId
- Get a specific device by deviceId
- Returns: `Device`

#### POST /api/devices
- Register a new device with its public key bundle
- Body:
```json
{
  "deviceId": 1,
  "identityKeyPublic": "base64_encoded_public_key",
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "base64_encoded_public_key",
    "signature": "base64_encoded_signature"
  },
  "preKeys": [
    {
      "keyId": 1,
      "publicKey": "base64_encoded_public_key"
    }
  ],
  "registrationId": 12345
}
```

#### GET /api/devices/user/:userId
- Get all devices for a specific user (for key exchange)
- Returns public keys only

#### GET /api/devices/user/:userId/prekeys/:deviceId
- Get preKeys for a specific device (for key exchange)
- Returns: `{ preKeys: PreKey[] }`

### Profile Settings

#### GET /api/profile/settings/me
- Get current user's settings
- Returns: `UserSettings`

#### GET /api/profile/settings/:userId
- Get settings by oxy user id
- Returns: `UserSettings`

#### PUT /api/profile/settings
- Update current user's settings
- Body:
```json
{
  "appearance": {
    "themeMode": "light" | "dark" | "system",
    "primaryColor": "#000000"
  },
  "profileHeaderImage": "url",
  "privacy": {
    "profileVisibility": "public" | "private" | "followers_only",
    "showContactInfo": true,
    "allowTags": true,
    "allowallos": true,
    "showOnlineStatus": true,
    "hideLikeCounts": false,
    "hideShareCounts": false,
    "hideReplyCounts": false,
    "hideSaveCounts": false,
    "hiddenWords": ["word1", "word2"],
    "restrictedUsers": ["user1", "user2"]
  },
  "profileCustomization": {
    "coverPhotoEnabled": true,
    "minimalistMode": false,
    "displayName": "Display Name",
    "coverImage": "url"
  },
  "security": {
    "cloudSyncEnabled": false, // Device-first by default
    "encryptionEnabled": true, // Encryption on/off
    "peerToPeerEnabled": true // Stored but not enforced — P2P isn't functional yet, see docs/encryption.mdx
  }
}
```

#### DELETE /api/profile/settings/behavior
- Reset user behavior/preferences

#### GET /api/profile/blocks
- Get list of blocked users

#### POST /api/profile/blocks
- Block a user
- Body: `{ "blockedId": "user_id" }`

#### DELETE /api/profile/blocks/:blockedId
- Unblock a user

#### GET /api/profile/restricts
- Get list of restricted users

#### POST /api/profile/restricts
- Restrict a user
- Body: `{ "restrictedId": "user_id" }`

#### DELETE /api/profile/restricts/:restrictedId
- Unrestrict a user

## Real-time Messaging (Socket.IO)

The backend provides real-time messaging through Socket.IO.

### Connection

Connect to the `/messaging` namespace:

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:4140/messaging', {
  auth: {
    token: 'your_oxy_token',
    userId: 'your_user_id'
  }
});
```

### Events

#### Client → Server

- `joinConversation` - Join a conversation room
  - Payload: `conversationId: string`

- `leaveConversation` - Leave a conversation room
  - Payload: `conversationId: string`

#### Server → Client

- `newMessage` - New message received
  - Payload: `Message`

- `messageUpdated` - Message was edited
  - Payload: `Message`

- `messageDeleted` - Message was deleted
  - Payload: `{ id: string }`

## Database Schema

### Conversation

```typescript
{
  type: "direct" | "group",
  participants: [
    {
      userId: string, // Oxy user ID
      role: "admin" | "member",
      joinedAt: Date,
      lastReadAt?: Date
    }
  ],
  name?: string, // For groups
  description?: string, // For groups
  avatar?: string, // For groups
  createdBy: string, // Oxy user ID
  lastMessageAt?: Date,
  lastMessage?: {
    text?: string,
    senderId: string,
    timestamp: Date
  },
  unreadCounts: Record<string, number>, // userId -> unread count
  archivedBy: string[], // Array of user IDs
  createdAt: Date,
  updatedAt: Date
}
```

### Message

```typescript
{
  conversationId: string,
  senderId: string, // Oxy user ID
  text?: string,
  media?: MediaItem[],
  replyTo?: string, // Message ID
  fontSize?: number,
  editedAt?: Date,
  deletedAt?: Date,
  readBy: Record<string, Date>, // userId -> read timestamp
  deliveredTo: string[], // Array of user IDs
  createdAt: Date,
  updatedAt: Date
}
```

## Development Scripts

- `bun run dev` — Start development server with hot reload
- `bun run build` — Build the project
- `bun run start` — Start production server
- `bun run lint` — Lint codebase
- `bun run clean` — Clean build artifacts

## Monorepo Integration

This package is part of the Allo monorepo and integrates with:

- **@allo/frontend**: React Native application
- **@allo/shared-types**: Shared TypeScript type definitions

### Shared Dependencies
- Uses `@allo/shared-types` for type safety across packages
- Integrates with `@oxyhq/services` for authentication

## Security & Encryption

### End-to-End Encryption

Direct messages are encrypted client-side with a static Diffie-Hellman scheme (see [docs/encryption.mdx](../../docs/encryption.mdx) for the full model; the frontend module is named `signalProtocol.ts` for historical reasons but does not implement the Signal Protocol):

- **Device Keys**: Each device has its own identity key, signed pre-key, and one-time pre-keys. Only the identity key is used for encryption — the pre-keys are generated and stored but not consumed by any encrypt/decrypt path.
- **Key Exchange**: Devices exchange public keys through the backend.
- **Storage**: The backend stores whatever the client sends — encrypted ciphertext when the client was able to encrypt, plaintext when it falls back because it couldn't (e.g. the recipient has no registered device).
- **No Forward Secrecy**: The same static shared secret encrypts every message between a pair of identity keys; there is no per-message or per-session key.
- **Device Management**: Users can register multiple devices, each with separate keys, but a recipient's non-primary devices generally cannot decrypt messages sent to them (see [docs/encryption.mdx](../../docs/encryption.mdx)).

### Device-First Architecture

- **Local Storage**: Messages are stored locally on the device first
- **Optional Cloud Sync**: Users can enable cloud backup in settings (disabled by default)
- **Privacy**: When cloud sync is disabled, messages are only stored on devices
- **P2P**: Peer-to-peer messaging is scaffolded (`lib/p2pMessaging.ts`) but not yet functional — every message currently goes through the server relay

### Message Encryption Flow

1. Client attempts to encrypt the message with the recipient's identity key (static ECDH + AES-256-GCM); if that fails, it falls back to plaintext
2. Client sends the resulting ciphertext (or plaintext) to the backend
3. Backend stores the message as received — it never has the keys to decrypt a ciphertext payload
4. Backend delivers the message to recipient devices
5. Recipient devices decrypt locally when the payload is encrypted

## Notes

- **No User Management**: Users are managed by the Oxy platform. The backend only stores Oxy user IDs.
- **Authentication**: All authenticated endpoints use Oxy's authentication middleware.
- **Real-time**: Socket.IO is used for real-time message delivery and updates.
- **Encryption**: Direct messages are end-to-end encrypted when the client can encrypt them; the backend never sees the keys needed to decrypt ciphertext, but see [docs/encryption.mdx](../../docs/encryption.mdx) for the plaintext fallback and other gaps (no forward secrecy, broken group encryption, non-functional multi-device and P2P).
- **Device-First**: Messages stored locally by default. Cloud sync is optional.
