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

- Node.js 20.19+ and Bun 1.3+
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

# Authentication
# WE USE OXY FOR AUTHENTICATION - users are managed by Oxy platform
# Read by @oxyhq/core (OxyServices.ts), not by this package directly.
# Defaults to https://api.oxy.so when unset.
OXY_API_URL=https://api.oxy.so

# Server Configuration
# 4140 is Allo's slot in the per-app local port map; ECS injects PORT=8080.
PORT=4140
NODE_ENV=development

# Push notifications (optional). Without these, utils/push.ts logs that push is
# disabled and returns. Setting them is still not enough to make push work —
# see the note at the end of this file.
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_SERVICE_ACCOUNT_BASE64=base64_encoded_service_account_json

# CrowdSource moderation (optional; the webhook route is not mounted when unset)
CROWDSOURCE_ENABLED=false
CROWDSOURCE_ENFORCEMENT_MODE=shadow
CROWDSOURCE_WEBHOOK_SECRET=your_webhook_secret
# Set during a secret rotation so in-flight deliveries signed with the old
# secret still verify.
CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS=

# Tests only: point the vitest suite at an existing MongoDB replica set instead
# of downloading a mongodb-memory-server binary.
ALLO_TEST_MONGODB_URI=
```

There is no `FRONTEND_URL`: the CORS allowlist is not read from the environment.
`createOxyCors` admits the Oxy apex family (`*.oxy.so`) automatically, and the
extra development origins are the literal list at the top of `server.ts`.

`FRONTEND_URL` and `JWT_SECRET` appear in older deployment docs but are read
neither by this package nor by `@oxyhq/core`. Setting them changes nothing.

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

## Deployment

The backend runs on **AWS ECS**, and that is the only deployment there is. The
whole pipeline is [`.github/workflows/deploy-aws.yml`](../../.github/workflows/deploy-aws.yml);
nothing is deployed by hand.

- **Trigger** — every push to `main` that touches something other than Markdown
  or `docs/`, plus manual `workflow_dispatch`.
- **Image** — `packages/backend/Dockerfile`, built for `linux/arm64` on an ARM
  runner because the ECS tasks run on Graviton. Pushed to ECR as
  `oxy/allo`, tagged with both the commit SHA and `latest`.
- **Release** — a rolling `update-service` on the `oxy-cluster` ECS cluster,
  followed by a wait for the service to stabilise. If the service does not exist
  yet the image still lands in ECR and the deploy step is skipped, so a first
  push does not fail the workflow.
- **Port** — the container listens on the `PORT` that ECS injects (8080; set in
  oxy-infra's `terraform-uswest2/app-allo.tf`). The `4140` in `server.ts` is the
  local fallback only.
- **Public URL** — `api.allo.oxy.so`.

### Credentials

AWS access uses **GitHub OIDC** — the workflow assumes `oxy-github-deploy` and
no long-lived keys are stored anywhere.

Runtime configuration is **GitHub Secrets as the source of truth**. Each deploy
copies them into SSM Parameter Store as `SecureString`, at `/oxy/allo/<NAME>`
for this app and `/oxy/_shared/<NAME>` for the values shared across Oxy apps
(`REDIS_URL`, the LiveKit pair, ...). Editing a parameter directly in SSM is
therefore pointless: the next deploy overwrites it. Change the GitHub secret.

## API Endpoints

### Authentication

All authenticated endpoints require a Bearer token from Oxy. The middleware
comes from `@oxyhq/core/server` — `createOxyAuthMiddleware(oxy)`, mounted on
`/api` in `server.ts` — alongside `createOxyCors` and `createOxyRateLimit` from
the same package. There is no local middleware directory.

Routes are split into two routers: `publicApiRouter` (health only) and
`authenticatedApiRouter`, which carries `/profile`, `/conversations`,
`/messages`, `/devices` and `/reports`. The CrowdSource webhook is mounted
separately at `/webhooks/crowdsource`, ahead of the JSON body parser, because it
needs the raw body to verify its signature.

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

### Reports (moderation)

Account reports only. Message content is deliberately never sent for review —
it is end-to-end encrypted, and the moderation pipeline's `deliverableTypes()`
is pinned to `['user']` by a test so nobody can widen it by accident.

#### POST /api/reports
- File a report against an account
- Returns the created report

#### GET /api/reports/mine
- List the reports the calling user has filed

### CrowdSource webhook

#### POST /webhooks/crowdsource
- Public, but signature-verified. Mounted **only** when
  `CROWDSOURCE_WEBHOOK_SECRET` is set; without it the server logs that the route
  is not mounted and carries on.
- Registered before `express.json()` so the raw body survives for signature
  verification.

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

- `typing` - Typing indicator
  - Payload: `{ conversationId: string, userId: string, isTyping: boolean }`

#### Server → Client

- `newMessage` - New message received
  - Payload: `Message`

- `messageUpdated` - Message was edited
  - Payload: `Message`

- `messageDeleted` - Message was deleted
  - Payload: `{ id: string }`

- `typing` - Mirrored to everyone in the room except the sender
  - Payload: `{ conversationId: string, userId: string, isTyping: boolean }`

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
  senderDeviceId: number, // Device that sent it

  // Encrypted content
  ciphertext?: string, // Base64; the server cannot decrypt this
  encryptedMedia?: EncryptedMediaItem[],

  // Legacy plaintext fields — also what the plaintext fallback writes
  text?: string,
  media?: MediaItem[],

  encryptionVersion?: number,
  messageType?: "text" | "media" | "system",

  replyTo?: string, // Message ID
  fontSize?: number,
  editedAt?: Date,
  deletedAt?: Date,
  readBy: Record<string, Date>, // userId -> read timestamp
  deliveredTo: string[], // Array of user IDs
  reactions?: Record<string, string[]>, // emoji -> userIds
  createdAt: Date,
  updatedAt: Date
}
```

## Development Scripts

- `bun run dev` — Start development server with hot reload
- `bun run build` — Build the project
- `bun run start` — Start production server
- `bun run test` — Run the vitest suite
- `bun run clean` — Clean build artifacts

This package declares no `lint` script. The suite in `src/__tests__/` runs
against a real MongoDB replica set started by `vitest.globalSetup.ts`; set
`ALLO_TEST_MONGODB_URI` to point it at an existing server instead of letting
`mongodb-memory-server` download one. CI runs it on every PR
(`.github/workflows/ci.yml`).

## Monorepo Integration

This package is part of the Allo monorepo and integrates with:

- **@allo/frontend**: React Native application
- **@allo/shared-types**: Shared TypeScript type definitions

### Shared Dependencies
- Uses `@allo/shared-types` for type safety across packages
- Integrates with `@oxyhq/core` for authentication, CORS and rate limiting. This
  package does not depend on `@oxyhq/services` — that is the React Native SDK
  and is a frontend dependency only.
- Uses `@oxyhq/crowdsource*` for the moderation pipeline

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

- **Matrix migration**: Allo is moving to Matrix and this service is what it
  will move off. See [docs/matrix/](../../docs/matrix/) for the design. Nothing
  has changed here yet — this backend is still the transport the app uses.
- **Push notifications do not work**: `src/routes/notifications.ts` was deleted in
  commit `670f008` and never remounted, so the `POST /notifications/push-token`
  the client still sends 404s and no `PushToken` document is ever written.
  `utils/push.ts` can talk to Firebase, but `sendPushToUser` queries an empty
  collection — and the only thing that calls it is `createNotification`, which
  nothing outside its own file calls either.
- **No User Management**: Users are managed by the Oxy platform. The backend only stores Oxy user IDs.
- **Authentication**: All authenticated endpoints use Oxy's authentication middleware.
- **Real-time**: Socket.IO is used for real-time message delivery and updates.
- **Encryption**: Direct messages are end-to-end encrypted when the client can encrypt them; the backend never sees the keys needed to decrypt ciphertext, but see [docs/encryption.mdx](../../docs/encryption.mdx) for the plaintext fallback and other gaps (no forward secrecy, broken group encryption, non-functional multi-device and P2P).
- **Device-First**: Messages stored locally by default. Cloud sync is optional.
