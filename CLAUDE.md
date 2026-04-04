# Allo

## Custom Agents

Use this agent for all implementation work:
- `allo` — Full-stack engineer (Expo/RN frontend + Express backend)

## Commands

```bash
bun run dev                 # All packages dev mode
bun run dev:frontend        # Frontend only (Expo tunnel)
bun run dev:backend         # Backend only (nodemon + ts-node)
bun run build               # Build all (shared-types → backend)
bun run build:shared-types  # Shared types only
bun run build:frontend      # Frontend web export
bun run build:backend       # Backend TypeScript compilation
bun run test                # Test all
bun run lint                # Lint all
bun run clean               # Clean everything
```

## Architecture

Monorepo (v2.0.0) — encrypted messaging app with offline-first architecture.

```
packages/
  frontend/       @allo/frontend      Expo 54 / React Native 0.81 / React 19
  backend/        @allo/backend       Express 4.21 / Mongoose 8.17 / Socket.io
  shared-types/   @allo/shared-types  TypeScript type definitions
```

## Key Features

- **E2E Encryption**: Signal Protocol (`lib/signalProtocol.ts`)
- **Offline-first**: Queue + sync (`lib/offlineQueue/`, `lib/offlineStorage.ts`, `lib/optimistic/`)
- **Real-time**: Socket.io for messaging
- **AI**: @ai-sdk/openai integration
- **i18n**: i18next with locales

## Tech

- **Frontend**: Expo Router 6, NativeWind 4.2, TanStack React Query 5, Zustand 5, Immer
- **Backend**: Express 4, Mongoose 8, Firebase Admin, JWT, bcryptjs, rate limiting

## Dependencies

- `@oxyhq/core` (1.11.4), `@oxyhq/services` (6.9.12) — Oxy platform integration
