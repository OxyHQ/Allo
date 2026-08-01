# Allo

> A modern, cross-platform chat app built with Expo, React Native, TypeScript, and a Node.js/Express backend in a monorepo structure.

---

## Table of Contents
- [About](#about)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Development Scripts](#development-scripts)
- [API Documentation](#api-documentation)
- [Contributing](#contributing)
- [License](#license)

---

## About

**Allo** is a chat platform for mobile and web with **end-to-end encrypted direct messages** and a **device-first architecture**. It features offline support and a clean, modern UI. Built with Expo, React Native, and a Node.js backend in a modern monorepo structure, it supports file-based routing, multi-language support, and a modern UI.

### Key Security Features

- 🔐 **End-to-End Encryption** - Direct messages are encrypted client-side with static ECDH (P-256) between identity keys + AES-256-GCM. There is no KDF and no forward secrecy — see [Encryption](./docs/encryption.mdx) for what that means and for known gaps (group chats, multi-device, plaintext fallback)
- 📱 **Device-First Architecture** - Messages stored locally first, cloud is secondary
- ☁️ **Optional Cloud Sync** - Users can enable/disable cloud backup in settings
- 🔑 **Automatic Key Management** - Device keys generated and registered with the backend automatically
- ⚠️ **Plaintext Fallback** - If encryption isn't possible (e.g. the recipient has no registered device), the message is sent unencrypted rather than blocked

## Project Structure

This is a **monorepo** using Bun workspaces with the following structure:

```
/
├── packages/            # All code packages
│   ├── frontend/        # Expo React Native app (Allo)
│   │   ├── app/         # App entry, screens, and routing
│   │   │   ├── [username]/  # User profile, followers, following
│   │   │   ├── kaana/       # AI assistant or help section
│   │   │   ├── p/[id]/      # Post details, replies, quotes
│   │   │   └── ...
│   │   ├── components/  # UI components
│   │   ├── assets/      # Images, icons, fonts
│   │   ├── constants/   # App-wide constants
│   │   ├── context/     # React context providers
│   │   ├── features/    # Feature modules
│   │   ├── hooks/       # Custom React hooks
│   │   ├── interfaces/  # TypeScript interfaces
│   │   ├── lib/         # Library code
│   │   │   ├── signalProtocol.ts  # End-to-end encryption (static ECDH + AES-256-GCM)
│   │   │   ├── offlineStorage.ts  # Offline message storage
│   │   │   ├── p2pMessaging.ts     # Peer-to-peer scaffolding (not functional)
│   │   │   └── ...
│   │   ├── locales/     # i18n translation files
│   │   ├── scripts/     # Utility scripts
│   │   ├── stores/      # State management (Zustand)
│   │   │   ├── messagesStore.ts    # Encrypted message store
│   │   │   ├── deviceKeysStore.ts  # Device key management
│   │   │   └── ...
│   │   ├── styles/      # Global styles and colors
│   │   └── utils/       # Utility functions
│   ├── backend/         # Node.js/Express API server
│   │   ├── src/         # Backend source code
│   │   │   ├── controllers/ # API controllers
│   │   │   ├── middleware/  # Express middleware
│   │   │   ├── models/      # MongoDB models
│   │   │   │   ├── Conversation.ts  # Chat conversations
│   │   │   │   ├── Message.ts       # Encrypted messages
│   │   │   │   ├── Device.ts         # Device public key bundles
│   │   │   │   └── ...
│   │   │   ├── routes/      # API routes
│   │   │   │   ├── conversations.ts # Conversation endpoints
│   │   │   │   ├── messages.ts      # Message endpoints
│   │   │   │   ├── devices.ts       # Device key management
│   │   │   │   └── ...
│   │   │   ├── scripts/     # Utility scripts
│   │   │   ├── sockets/     # WebSocket handlers
│   │   │   ├── types/       # TypeScript types
│   │   │   └── utils/       # Utility functions
│   │   └── ...
│   └── shared-types/    # Shared TypeScript types
│       ├── src/         # Type definitions
│       └── dist/        # Compiled types
├── package.json         # Root package.json with workspaces
├── tsconfig.json        # Root TypeScript config
└── ...
```

## Getting Started

### Prerequisites
- Node.js 18+ and Bun 1.3+
- MongoDB instance
- Expo CLI for mobile development

### Initial Setup
1. **Clone the repository**
   ```bash
   git clone https://github.com/OxyHQ/Allo.git
   cd Allo
   ```

2. **Install all dependencies**
   ```bash
   bun install
   ```

### Development

#### Start All Services
```bash
bun run dev
```

#### Start Individual Services
```bash
# Frontend only
bun run dev:frontend

# Backend only
bun run dev:backend
```

#### Frontend Development
The frontend is an Expo React Native app that can run on:
- **Web**: `bun run web` (or `bun run dev:frontend` then press 'w')
- **iOS**: `bun run ios` (requires macOS and Xcode)
- **Android**: `bun run android` (requires Android Studio)

#### Backend Development
The backend runs on the development server with hot reload:
```bash
bun run dev:backend
```

## Development Scripts

### Root Level (Monorepo)
- `bun run dev` — Start all services in development mode
- `bun run dev:frontend` — Start frontend development server
- `bun run dev:backend` — Start backend development server
- `bun run build` — Build all packages
- `bun run build:shared-types` — Build shared types package
- `bun run build:frontend` — Build frontend for production
- `bun run build:backend` — Build backend for production
- `bun run test` — Run tests across all packages
- `bun run lint` — Lint all packages
- `bun run clean` — Clean all build artifacts
- `bun install` — Install dependencies for all packages

### Frontend (`@allo/frontend`)
- `bun run start` — Start Expo development server
- `bun run android` — Run on Android device/emulator
- `bun run ios` — Run on iOS simulator
- `bun run web` — Run in web browser
- `bun run build-web` — Build static web output
- `bun run lint` — Lint codebase
- `bun run clean` — Clean build artifacts

### Backend (`@allo/backend`)
- `bun run dev` — Start development server with hot reload
- `bun run build` — Build the project
- `bun run start` — Start production server
- `bun run lint` — Lint codebase
- `bun run clean` — Clean build artifacts
- `bun run migrate` — Run database migrations
- `bun run migrate:dev` — Run database migrations in development

### Shared Types (`@allo/shared-types`)
- `bun run build` — Build TypeScript types
- `bun run dev` — Watch and rebuild types
- `bun run clean` — Clean build artifacts

## Documentation

### Project Documentation

All project documentation is available in the [`docs/`](./docs/) folder:

- [Allo System Overview](./docs/allo_SYSTEM_README.md) - Legacy system overview
- [Allo Format Specification](./docs/allo_FORMAT_FINAL.md) - Legacy format summary
- [Allo Implementation](./docs/allo_IMPLEMENTATION_COMPLETE.md) - Legacy implementation details
- [Notifications System](./docs/allo_NOTIFICATIONS.md) - Notification system documentation
- [Visual Guide](./docs/allo_VISUAL_GUIDE.md) - Visual design guide
- [Theming Guide](./docs/THEMING_REFACTOR_SUMMARY.md) - Complete theming system documentation
- [Theme Quick Reference](./docs/THEME_QUICK_REFERENCE.md) - Quick reference for developers
- [Theming Troubleshooting](./docs/THEMING_TROUBLESHOOTING.md) - Common theming issues and solutions
- [Performance Optimizations](./docs/PERFORMANCE_OPTIMIZATIONS.md) - Performance best practices
- [Vercel Deployment](./docs/VERCEL_DEPLOYMENT.md) - Deployment guide for Vercel
- [Code Cleanup Summary](./docs/CODE_CLEANUP_SUMMARY.md) - Code cleanup documentation

### API Documentation

The Allo API is a backend service built with Express.js and TypeScript, providing messaging functionality, device key management, authentication, and real-time communications. Direct messages that the client can encrypt arrive as opaque ciphertext (static ECDH + AES-256-GCM); the server never has the keys to read them. See [Encryption](./docs/encryption.mdx) for the full model, including the plaintext fallback and other known gaps.

For detailed API information, see:
- [Backend README](packages/backend/README.md) - Complete API documentation
- [Frontend README](packages/frontend/README.md) - Frontend implementation details

### Security Documentation

- **End-to-End Encryption**: Static ECDH (P-256) between identity keys + AES-256-GCM, no forward secrecy — see [Encryption](./docs/encryption.mdx) for the full model and known gaps (group chats, multi-device, P2P, media)
- **Device-First**: Messages stored locally, cloud sync is optional
- **Key Exchange**: Automatic device key registration and exchange
- **Offline Support**: Full functionality without internet connection
- **Peer-to-Peer**: Scaffolded (`lib/p2pMessaging.ts`) but not yet functional — every message currently goes through the server relay

## Contributing

Contributions are welcome! Please open issues or pull requests for bug fixes, features, or improvements.

### Development Workflow
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting: `bun run test && bun run lint`
5. Submit a pull request

## License

This project is licensed under the MIT License.