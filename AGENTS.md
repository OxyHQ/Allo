# Allo — Encrypted Messaging

Expo/RN frontend + Express backend. Agent: `allo`.

## Deployment

- **Port**: `8080` | **Domain**: `api.allo.oxy.so` | **ECR**: `oxy/allo`
- Build: `linux/arm64` Dockerfile in `packages/backend/`.

## Commands

```bash
bun run dev                 # All packages dev mode
bun run dev:frontend        # Frontend only (Expo tunnel)
bun run dev:backend         # Backend only
bun run build               # Build all (shared-types → backend)
bun run test                # Test all
bun run lint                # Lint all
bun run clean               # Clean everything
```

## Architecture

```
packages/
  frontend/       @allo/frontend      Expo 56 / React Native 0.85 / React 19 / NativeWind 4.2
  backend/        @allo/backend       Express 4.21 / Mongoose 8.17 / Socket.io
  shared-types/   @allo/shared-types  TypeScript type definitions
```

## Key Features

- **E2E Encryption**: Signal Protocol (`lib/signalProtocol.ts`) — X3DH + Double Ratchet (X25519, Ed25519, ChaCha20-Poly1305)
- **Offline-first**: Queue + sync (`lib/offlineQueue/`, `lib/offlineStorage.ts`, `lib/optimistic/`)
- **Real-time**: Socket.io for messaging, WebRTC for calls and P2P data channels
- **i18n**: i18next with locales

## Theming

`BloomThemeProvider` in `app/_layout.tsx`, mode/colorPreset from `appearanceStore`.

Components use `useTheme()` from `@/hooks/useTheme` — a thin wrapper over `@oxyhq/bloom`'s theme hook that adds Allo-specific chat-bubble colors (`messageBubble*`, `chatBackground`) from the user's conversation theme in `styles/colorThemes.ts`. Never hardcode colors; always use `theme.colors.*`. `styles/colors.ts` is reserved for SVG icon defaults only.

## Dependency Gotchas

**Root `overrides` + `resolutions` for Oxy SDK:** `@oxyhq/services` declares `@oxyhq/core` as a peer. Without explicit root `overrides` AND `resolutions`, Bun may hoist a different core build inside the services package → type mismatches and runtime errors. Root `package.json` must carry BOTH entries pointing to the current target.

**`@react-native-community/netinfo`:** root `overrides` + `resolutions` pin to `^11.4.1`; frontend declares it as a direct dep.

**`bun.lock` regeneration:** always run `bun install` from the **monorepo root** (not inside a package). A sub-package install can drop workspace resolution lines from `bun.lock`, breaking CI's `--frozen-lockfile`. CI and `packages/backend/Dockerfile` both pin bun 1.3.14 — keep them aligned with your local bun when regenerating the lockfile.
