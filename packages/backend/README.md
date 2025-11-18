# @allo/backend

> The backend package of the Allo monorepo - A modern chat API service built with Express.js and TypeScript.

---

## Overview

This is the **backend package** of the **Allo** monorepo. Allo is a modern, secure chat application with **Signal Protocol encryption**, **device-first architecture**, and **optional cloud sync**. The backend provides the API service for messaging, conversations, user settings, and device key management. The backend uses Oxy for authentication, so no user management is needed.

### Key Features

- 🔐 **Signal Protocol Encryption** - End-to-end encryption for all messages
- 📱 **Device-First Architecture** - Messages stored locally first, cloud is secondary
- ☁️ **Optional Cloud Sync** - Users can enable/disable cloud backup in settings
- 🔑 **Device Key Management** - Signal Protocol device keys and key exchange
- 🚫 **No Plaintext Storage** - Server never sees unencrypted message content

## Tech Stack

- Node.js with TypeScript
- Express.js for REST API
- MongoDB with Mongoose for data storage
- Socket.IO for real-time messaging
- Oxy Services for authentication (users managed by Oxy platform)

## Getting Started

### Prerequisites

- Node.js 18+ and npm 8+
- MongoDB instance
- Git

### Development Setup

#### Option 1: From the Monorepo Root (Recommended)
```bash
# Clone the repository
git clone https://github.com/OxyHQ/Allo.git
cd Allo

# Install all dependencies
npm run install:all

# Start backend development
npm run dev:backend
```

#### Option 2: From This Package Directory
```bash
# Navigate to this package
cd packages/backend

# Install dependencies
npm install

# Start development server
npm run dev
```

### Environment Configuration

Create a `.env` file in this package directory with the following variables:

```env
# Database
MONGODB_URI=your_mongodb_connection_string

# Authentication
# WE USE OXY FOR AUTHENTICATION - users are managed by Oxy platform
OXY_API_URL=https://api.oxy.so

# Server Configuration
PORT=3000
NODE_ENV=development

# Frontend URL (for CORS)
FRONTEND_URL=https://allo.earth
```

### Running the API

#### Development Mode
```bash
npm run dev
```

#### Production Mode
```bash
npm run build
npm start
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

**Important**: All messages are encrypted using Signal Protocol. The backend stores only encrypted ciphertext. Decryption happens on the client side.

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

### Device Management (Signal Protocol)

#### GET /api/devices
- Get all devices for the authenticated user
- Returns: `{ devices: Device[] }`

#### GET /api/devices/:deviceId
- Get a specific device by deviceId
- Returns: `Device`

#### POST /api/devices
- Register a new device with Signal Protocol keys
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
    "encryptionEnabled": true, // Signal Protocol encryption
    "peerToPeerEnabled": true // Enable P2P when possible
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

const socket = io('http://localhost:3000/messaging', {
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

- `npm run dev` — Start development server with hot reload
- `npm run build` — Build the project
- `npm run start` — Start production server
- `npm run lint` — Lint codebase
- `npm run clean` — Clean build artifacts

## Monorepo Integration

This package is part of the Allo monorepo and integrates with:

- **@allo/frontend**: React Native application
- **@allo/shared-types**: Shared TypeScript type definitions

### Shared Dependencies
- Uses `@allo/shared-types` for type safety across packages
- Integrates with `@oxyhq/services` for authentication

## Security & Encryption

### Signal Protocol

Allo uses **Signal Protocol** for end-to-end encryption:

- **Device Keys**: Each device has its own identity key, signed pre-key, and one-time pre-keys
- **Key Exchange**: Devices exchange public keys through the backend
- **Encrypted Storage**: Backend stores only encrypted ciphertext, never plaintext
- **Forward Secrecy**: Each message uses a unique encryption key
- **Device Management**: Users can manage multiple devices, each with separate keys

### Device-First Architecture

- **Local Storage**: Messages are stored locally on the device first
- **Optional Cloud Sync**: Users can enable cloud backup in settings (disabled by default)
- **Privacy**: When cloud sync is disabled, messages are only stored on devices
- **P2P Support**: Peer-to-peer messaging when both users are online (if enabled)

### Message Encryption Flow

1. Client encrypts message using Signal Protocol with recipient's device keys
2. Client sends encrypted ciphertext to backend
3. Backend stores encrypted message (never sees plaintext)
4. Backend delivers encrypted message to recipient devices
5. Recipient devices decrypt message locally

## Notes

- **No User Management**: Users are managed by the Oxy platform. The backend only stores Oxy user IDs.
- **Authentication**: All authenticated endpoints use Oxy's authentication middleware.
- **Real-time**: Socket.IO is used for real-time message delivery and updates.
- **Encryption**: All messages are encrypted using Signal Protocol. Backend never sees plaintext.
- **Device-First**: Messages stored locally by default. Cloud sync is optional.
