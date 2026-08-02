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

### Moving to Matrix

Allo is migrating to [Matrix](https://matrix.org) and will stop carrying its own
transport. The design work lives in [`docs/matrix/`](./docs/matrix/) and comes
before the code on purpose.

Nothing has switched over yet. The messaging that works today is the one
described below and in [`docs/`](./docs/): REST plus Socket.IO against
`@allo/backend`, with the encryption in [Encryption](./docs/encryption.mdx).
A Matrix client port exists at `packages/frontend/lib/matrix/` — an interface, a
native implementation, and a web half that throws on purpose — but no screen in
the app imports it.

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
│   │   ├── app/         # Expo Router file-based routes
│   │   │   ├── (auth)/      # Sign-in
│   │   │   ├── (chat)/      # Conversation list, settings, c/[id] thread, u/[id] profile
│   │   │   ├── calls.tsx    # Calls screen (renders mock data)
│   │   │   └── ...
│   │   ├── components/  # UI components
│   │   ├── assets/      # Images, icons, fonts
│   │   ├── constants/   # App-wide constants
│   │   ├── context/     # React context providers
│   │   ├── hooks/       # Custom React hooks
│   │   ├── lib/         # Library code
│   │   │   ├── signalProtocol.ts  # End-to-end encryption (static ECDH + AES-256-GCM)
│   │   │   ├── offlineStorage.ts  # Offline message storage
│   │   │   ├── offlineQueue/       # Queued mutations, replayed on reconnect
│   │   │   ├── p2pMessaging.ts     # Peer-to-peer scaffolding (not functional)
│   │   │   ├── matrix/             # Matrix client port — not wired to the UI yet
│   │   │   └── ...
│   │   ├── locales/     # i18n translation files (en, es, it)
│   │   ├── plugins/     # Expo config plugins
│   │   ├── scripts/     # Utility scripts
│   │   ├── stores/      # State management (Zustand)
│   │   │   ├── messagesStore.ts    # Encrypted message store
│   │   │   ├── deviceKeysStore.ts  # Device key management
│   │   │   └── ...
│   │   ├── styles/      # Global styles and colors
│   │   ├── types/       # TypeScript types
│   │   ├── utils/       # Utility functions
│   │   ├── __mocks__/   # Jest manual mocks (the Matrix native binding)
│   │   └── __tests__/   # Jest suites
│   ├── backend/         # Node.js/Express API server
│   │   ├── server.ts    # Entry point: Express app + Socket.IO + route mounting
│   │   ├── src/
│   │   │   ├── config/      # CrowdSource moderation config
│   │   │   ├── models/      # MongoDB models
│   │   │   │   ├── Conversation.ts  # Chat conversations
│   │   │   │   ├── Message.ts       # Encrypted messages
│   │   │   │   ├── Device.ts        # Device public key bundles
│   │   │   │   └── ...
│   │   │   ├── routes/      # Express routers
│   │   │   │   ├── conversations.ts # Conversation endpoints
│   │   │   │   ├── messages.ts      # Message endpoints
│   │   │   │   ├── devices.ts       # Device key management
│   │   │   │   ├── reports.ts       # Account reports
│   │   │   │   └── ...
│   │   │   ├── services/    # Moderation pipeline (CrowdSource)
│   │   │   ├── types/       # TypeScript types
│   │   │   ├── utils/       # Utility functions
│   │   │   └── __tests__/   # Vitest suites
│   │   ├── Dockerfile   # linux/arm64 image built by the AWS deploy workflow
│   │   └── ...
│   └── shared-types/    # Shared TypeScript types
│       ├── src/         # Type definitions
│       └── dist/        # Compiled types
├── docs/                # Project documentation (see below)
│   └── matrix/          # Design notes for the Matrix migration
├── spikes/              # Throwaway apps that validated the Matrix decisions
├── package.json         # Root package.json with workspaces
├── tsconfig.json        # Root TypeScript config
└── ...
```

There is no `controllers/`, `middleware/` or `sockets/` directory in the
backend: routes hold their own handlers, the auth / CORS / rate-limit middleware
comes from `@oxyhq/core/server`, and the Socket.IO wiring lives directly in
`server.ts`.

## Getting Started

### Prerequisites
- Node.js 20.19+ and Bun 1.3+ (the root `engines` field pins both; CI and the backend Dockerfile use bun 1.3.14)
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
The frontend is an Expo React Native app that can run on Web, iOS and Android.
Start it with `bun run dev:frontend` from the root and press `w`, `i` or `a`.

The per-platform scripts live in `packages/frontend` (there are no root aliases
for them), so run them with a filter or from that directory:

```bash
bun run --filter @allo/frontend web      # or ios / android
```

iOS requires macOS and Xcode; Android requires Android Studio.

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
- `bun run typecheck` — Typecheck backend then frontend (no emit)
- `bun run test` — Run tests across all packages
- `bun run clean` — Clean all build artifacts
- `bun install` — Install dependencies for all packages

A root `lint` script exists but does not work end to end: the backend declares
no `lint` script, and `shared-types` declares one without shipping eslint or an
eslint config, so it fails with "ESLint couldn't find an eslint.config.js". Only
`packages/frontend` is lintable today (`bun run --filter @allo/frontend lint`).

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
- `bun run test` — Run the vitest suite (starts a real MongoDB replica set)
- `bun run clean` — Clean build artifacts

There are no migration scripts. The backend has never had one, and the Mongoose
schemas are applied on connect.

### Shared Types (`@allo/shared-types`)
- `bun run build` — Build TypeScript types
- `bun run dev` — Watch and rebuild types
- `bun run clean` — Clean build artifacts

## Documentation

### Project Documentation

All project documentation is available in the [`docs/`](./docs/) folder:

These describe the system as it runs today:

- [Overview](./docs/index.mdx) - What Allo is and how the pieces fit together
- [Architecture](./docs/architecture.mdx) - Packages, data flow, and real-time transport
- [Encryption](./docs/encryption.mdx) - Device keys, static ECDH derivation, and what isn't implemented
- [API Reference](./docs/api.mdx) - REST and Socket.IO surface

These describe where it is going — design only, no implementation proposed yet:

- [Matrix Migration: Data Model](./docs/matrix/data-model.md) - How Allo's conversations map onto Matrix rooms, and what the mapping costs
- [Matrix Migration: Bridges](./docs/matrix/bridges.md) - Bridge topology and its constraints
- [Matrix Migration: Client Strategy](./docs/matrix/client-strategy.md) - Which SDK on which platform, and why

### Spikes

`spikes/` holds the throwaway apps that tested the risky assumptions before the
design committed to them. They are not part of the workspaces and are not built
by any root script.

- `spikes/matrix-web/` — `matrix-js-sdk` + `matrix-sdk-crypto-wasm` under a
  production Expo web export. Has its own [README](./spikes/matrix-web/README.md)
  and a [RESULTS.md](./spikes/matrix-web/RESULTS.md) recording what it proved and
  what it did not.
- `spikes/matrix-rn/` — only the generated `android/` project is committed. Its
  JS side is not in the repo, so it cannot be run from a fresh checkout.

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
4. Run the checks CI runs: `bun run typecheck && bun run test`
5. Submit a pull request

## License

This project is licensed under the MIT License.