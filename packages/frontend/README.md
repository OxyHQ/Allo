# @allo/frontend

> The frontend package of the Allo monorepo - A modern, cross-platform chat app built with Expo, React Native, and TypeScript.

---

## Table of Contents
- [About](#about)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Development Scripts](#development-scripts)
- [Contributing](#contributing)
- [License](#license)

---

## About

This is the **frontend package** of the **Allo** monorepo. **Allo** is a chat platform for mobile and web with **end-to-end encrypted direct messages** and a **device-first architecture**. It features offline support and a clean UI. Built with Expo and React Native, it supports file-based routing, multi-language support, and a modern UI.

This package contains the complete React Native application that runs on Android, iOS, and Web platforms.

## Features

### Security & Encryption
- 🔐 **End-to-End Encryption** - Direct messages encrypted client-side with static ECDH (P-256) between identity keys + AES-256-GCM
- 📱 **Device-First Architecture** - Messages stored locally first, cloud is secondary
- ☁️ **Optional Cloud Sync** - Users can enable/disable cloud backup in settings
- 🔑 **Device Key Management** - Automatic key generation and exchange on first launch
- ⚠️ **No Forward Secrecy** - The same key encrypts every message between a pair of identity keys; compromising either private key decrypts that pair's entire message history, past and future
- ⚠️ **Plaintext Fallback** - If encryption fails or the recipient has no registered device, the message is sent unencrypted rather than blocked

### Messaging
- Real-time messaging, encrypted for direct conversations
- Offline support with local storage
- Message reactions and replies
- Read receipts and delivery status

### User Experience
- Universal app: Android, iOS, and Web
- User profiles with followers/following
- Notifications (push and in-app)
- Multi-language support (English, Spanish, Italian)
- Responsive design and theming
- Modern UI with custom icons and animations

## Tech Stack
- [Expo](https://expo.dev/) & React Native
- TypeScript
- NativeWind (Tailwind CSS for React Native)
- Zustand (state management)
- i18next (internationalization)
- Expo Router (file-based routing)
- Custom SVG icons
- Expo Notifications, Secure Store, Camera, Video, Image Picker
- **Static ECDH (P-256) + AES-256-GCM** - End-to-end encryption for direct messages (see [Encryption](../../docs/encryption.mdx) for what this does and doesn't provide)
- **AsyncStorage** - Offline-first message storage
- **Socket.IO** - Real-time messaging and P2P signaling

## Project Structure
```
├── app/                # App entry, screens, and routing
│   └── ...
├── components/         # UI components
├── assets/             # Images, icons, fonts
├── constants/          # App-wide constants
├── context/            # React context providers
├── features/           # Feature modules (e.g., trends)
├── hooks/              # Custom React hooks
├── interfaces/         # TypeScript interfaces
├── lib/                # Library code
│   ├── signalProtocol.ts  # End-to-end encryption/decryption (static ECDH + AES-256-GCM)
│   ├── offlineStorage.ts  # Offline message storage
│   ├── p2pMessaging.ts    # Peer-to-peer messaging
│   └── ...
├── locales/            # i18n translation files
├── scripts/            # Utility scripts
├── stores/             # State management (Zustand)
│   ├── messagesStore.ts      # Encrypted message store
│   ├── deviceKeysStore.ts    # Device key management
│   └── ...
├── styles/             # Global styles and colors
├── utils/              # Utility functions
├── app.config.js       # Expo app configuration
├── package.json        # Project metadata and dependencies
└── ...
```

## Getting Started

### Prerequisites
- Node.js 18+ and Bun 1.3+
- Expo CLI (optional, but recommended)
- For iOS development: macOS with Xcode
- For Android development: Android Studio

### Development Setup

#### Option 1: From the Monorepo Root (Recommended)
```bash
# Clone the repository
git clone https://github.com/OxyHQ/Allo.git
cd Allo

# Install all dependencies
bun install

# Start frontend development
bun run dev:frontend
```

#### Option 2: From This Package Directory
```bash
# Navigate to this package
cd packages/frontend

# Install dependencies
bun install

# Start the app
bun run start
```

### Running the App

Once the development server is running, you can:

- **Web**: Press `w` in the terminal or run `bun run web`
- **iOS**: Press `i` in the terminal or run `bun run ios` (requires macOS)
- **Android**: Press `a` in the terminal or run `bun run android`
- **Expo Go**: Scan the QR code with the Expo Go app on your device

### Environment Setup

The app uses environment variables for configuration. Create a `.env` file in this package directory:

```env
# API Configuration
EXPO_PUBLIC_API_URL=http://localhost:4140
EXPO_PUBLIC_WS_URL=ws://localhost:4140

# Analytics and Monitoring
EXPO_PUBLIC_POSTHOG_KEY=your_posthog_key
EXPO_PUBLIC_BITDRIFT_KEY=your_bitdrift_key
```

## Development Scripts

- `bun run start` — Start Expo development server
- `bun run dev` — Start Expo development server (alias for start)
- `bun run android` — Run on Android device/emulator
- `bun run ios` — Run on iOS simulator
- `bun run web` — Run in web browser
- `bun run build-web` — Build static web output
- `bun run build-web:prod` — Build static web output for production
- `bun run reset-project` — Reset to a fresh project state
- `bun run clear-cache` — Clear Expo cache
- `bun run lint` — Lint codebase
- `bun run test` — Run tests
- `bun run clean` — Clean build artifacts

## Monorepo Integration

This package is part of the Allo monorepo and integrates with:

- **@allo/backend**: API server for data and authentication
- **@allo/shared-types**: Shared TypeScript type definitions

### Shared Dependencies
- Uses `@allo/shared-types` for type safety across packages
- Integrates with `@oxyhq/services` for common functionality

## Security & Encryption

### End-to-End Encryption Implementation

`lib/signalProtocol.ts` implements static Diffie-Hellman, not the Signal Protocol despite the filename (kept for historical reasons / to orient readers already familiar with the code). See [docs/encryption.mdx](../../docs/encryption.mdx) for the full picture; summary:

- **Device Keys**: Each device generates an identity key pair, a signed pre-key, and 100 one-time pre-keys on first launch and uploads the public halves to the backend. Only the identity key pair is actually used for encryption — the signed pre-key and one-time pre-keys are generated, stored, and published, but no encrypt/decrypt path reads them.
- **Key Exchange**: Devices publish and fetch public identity keys through the backend API.
- **Encryption**: `deriveSharedSecret` computes the ECDH shared point between the sender's and recipient's identity keys and uses the raw X coordinate directly as the AES-256 key — there is no KDF. The same pair of identity keys always produces the same encryption key.
- **Decryption**: Messages are decrypted locally on the recipient's device using the same static shared secret.
- **No Forward Secrecy**: The encryption key for a pair of users never changes; only the IV is unique per message. If either party's identity private key is ever compromised, every past and future message between that pair can be decrypted.
- **Signatures Unused**: The signed pre-key's ECDSA signature is generated and stored, but `verifySignature` is never called on any send or receive path — nothing actually checks it.

### Known Limitations

- **Group chats**: When sending in a group conversation, the app encrypts the message for only the first other participant returned by the conversation's participant list. Every other participant sees a decryption-failure placeholder.
- **Multi-device**: `getRecipientKeys` (`stores/deviceKeysStore.ts`) always picks the recipient's first registered device (`devices[0]`, sorted by device id) rather than the device the recipient is actually using. A second device the same user owns generally cannot decrypt messages sent to them.
- **Plaintext fallback**: If encryption fails, or the recipient has no registered devices, the message is sent as plaintext instead of being blocked (`stores/messagesStore.ts`).
- **Peer-to-peer**: Not implemented. `lib/p2pMessaging.ts`'s `establishP2PConnection` always returns `false` (a placeholder), and the WebRTC offer/answer/ICE-candidate handlers are unimplemented stubs. Every message currently goes through the server relay.
- **Media attachments**: Not implemented. The attachment menu's photo, document, camera, location, contact, and poll handlers are all no-ops (`components/conversation/ConversationView.tsx`), and there is no upload endpoint on the backend.

### Device-First Architecture

- **Local Storage**: All messages are stored locally using AsyncStorage (offline-first)
- **Cloud Sync**: Optional cloud backup can be enabled in Settings → Security
- **Offline Support**: App works completely offline, messages sync when online
- **Privacy**: When cloud sync is disabled, messages never leave the device

### Message Flow

1. User types message → encrypted locally (static ECDH + AES-256-GCM), or sent as plaintext if encryption fails
2. Message stored locally in AsyncStorage (offline-first)
3. Message POSTed to the server (if cloud sync is enabled), which relays it to the recipient — there is no working P2P path yet
4. Recipient receives the message → decrypts locally if it was encrypted
5. Message displayed in conversation

### Security Settings

Access security settings via: **Settings → Security & Encryption**

- **Cloud Sync Toggle**: Enable/disable cloud backup
- **Encryption Status**: View encryption initialization status
- **Device ID**: View your device's registered device ID

## Push Notifications (Expo + FCM)

- `expo-notifications` is configured via plugin in `app.config.js` for native builds.
- The app registers the device push token after the user authenticates and posts it to the backend endpoint `/api/notifications/push-token`.
- Backend requires Firebase Admin credentials via env vars to send FCM pushes.
- Push notifications are encrypted and don't contain message content.

## Contributing

Contributions are welcome! Please see the [main README](../../README.md) for the complete contributing guidelines.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting: `bun run test && bun run lint`
5. Submit a pull request

## License

This project is licensed under the MIT License.
