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

This is the **frontend package** of the **Allo** monorepo. **Allo** is a secure, universal chat platform designed for mobile and web with **Signal Protocol encryption**, **device-first architecture**, and **peer-to-peer messaging**. It features end-to-end encrypted messaging, offline support, and a clean UI. Built with Expo and React Native, it supports file-based routing, multi-language support, and a modern UI.

This package contains the complete React Native application that runs on Android, iOS, and Web platforms.

## Features

### Security & Encryption
- 🔐 **Signal Protocol Encryption** - End-to-end encryption for all messages
- 📱 **Device-First Architecture** - Messages stored locally first, cloud is secondary
- ☁️ **Optional Cloud Sync** - Users can enable/disable cloud backup in settings
- 🔑 **Device Key Management** - Automatic Signal Protocol key generation and exchange
- 🚫 **No Plaintext Storage** - Server never sees unencrypted message content
- 🔒 **Forward Secrecy** - Each message uses a unique encryption key

### Messaging
- Real-time encrypted messaging
- Offline support with local storage
- Peer-to-peer messaging when both users are online
- Media attachments (images, videos, files)
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
- **Signal Protocol** - End-to-end encryption (ECDH + AES-GCM)
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
│   ├── signalProtocol.ts  # Signal Protocol encryption/decryption
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
EXPO_PUBLIC_API_URL=http://localhost:3000
EXPO_PUBLIC_WS_URL=ws://localhost:3000

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

### Signal Protocol Implementation

Allo uses **Signal Protocol** for end-to-end encryption:

- **Device Keys**: Each device automatically generates identity keys, signed pre-keys, and one-time pre-keys on first launch
- **Key Exchange**: Devices exchange public keys through the backend API
- **Encryption**: Messages are encrypted using ECDH key exchange + AES-GCM encryption
- **Decryption**: Messages are decrypted locally on the recipient's device
- **Forward Secrecy**: Each message uses a unique encryption key derived from the session

### Device-First Architecture

- **Local Storage**: All messages are stored locally using AsyncStorage (offline-first)
- **Cloud Sync**: Optional cloud backup can be enabled in Settings → Security
- **Offline Support**: App works completely offline, messages sync when online
- **Privacy**: When cloud sync is disabled, messages never leave the device

### Peer-to-Peer Messaging

- **P2P Support**: Direct device-to-device messaging when both users are online
- **Automatic Fallback**: Falls back to server relay if P2P is unavailable
- **WebRTC Signaling**: Uses Socket.IO for P2P connection establishment
- **Encrypted P2P**: All P2P messages are still encrypted with Signal Protocol

### Message Flow

1. User types message → Encrypted locally with Signal Protocol
2. Message stored locally in AsyncStorage (offline-first)
3. If P2P available → Send directly to recipient device
4. If P2P unavailable → Send to server (if cloud sync enabled)
5. Recipient receives encrypted message → Decrypts locally
6. Message displayed in conversation

### Security Settings

Access security settings via: **Settings → Security & Encryption**

- **Cloud Sync Toggle**: Enable/disable cloud backup
- **Encryption Status**: View encryption initialization status
- **Device ID**: View your device's Signal Protocol device ID

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
