# Allo

## AWS Deployment

The backend runs on **AWS ECS Fargate** (region `us-west-2`, cluster `oxy-cluster`), behind an ALB with ACM HTTPS.

- **Port**: `8080` | **Domain**: `api.allo.oxy.so`
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` builds a `linux/arm64` Docker image → pushes to ECR (`237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/allo`) → `aws ecs update-service --force-new-deployment`
- **Auth**: GitHub OIDC → role `oxy-github-deploy`. No AWS keys stored in GitHub.
- **Secrets**: GitHub Actions secrets are the source of truth. The deploy workflow syncs them to AWS SSM (`/oxy/allo/*`; shared secrets to `/oxy/_shared/*`); ECS injects them into the container. To change a secret: edit it in GitHub — the next deploy applies it.
- **Dockerfile**: must build for `linux/arm64` (Graviton).
- **WARNING**: Never put secret values in this file.

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
  frontend/       @allo/frontend      Expo 56 / React Native 0.85 / React 19
  backend/        @allo/backend       Express 4.21 / Mongoose 8.17 / Socket.io
  shared-types/   @allo/shared-types  TypeScript type definitions
```

## Key Features

- **E2E Encryption**: Signal Protocol (`lib/signalProtocol.ts`) — X3DH + Double Ratchet (X25519, Ed25519, ChaCha20-Poly1305)
- **Offline-first**: Queue + sync (`lib/offlineQueue/`, `lib/offlineStorage.ts`, `lib/optimistic/`)
- **Real-time**: Socket.io for messaging, WebRTC for calls and P2P data channels
- **i18n**: i18next with locales

## Tech

- **Frontend**: Expo Router 6, NativeWind 4.2, TanStack React Query 5, Zustand 5, Immer
- **Backend**: Express 4, Mongoose 8, Firebase Admin, JWT, bcryptjs, rate limiting

## Theming

The app uses the shared **Bloom** design system from `@oxyhq/bloom` — the same
system used by Mention, Clarity, Homiio, and other Oxy apps.

- **Provider**: `<BloomThemeProvider>` is wired in `app/_layout.tsx` and reads
  `mode` / `colorPreset` from the `appearanceStore` (synced with Oxy user
  settings).
- **Hook**: components read theme via `useTheme()` from `@/hooks/useTheme` —
  a thin wrapper over `@oxyhq/bloom`'s theme hook that adds Allo-specific
  chat-bubble colors (`messageBubble*`, `chatBackground`) from the user's
  selected conversation theme in `styles/colorThemes.ts`.
- **Never** hardcode colors. Always use `theme.colors.*`. The static palette
  in `styles/colors.ts` is reserved for SVG icon defaults only.

## Dependencies

- `@oxyhq/core` (1.11.23), `@oxyhq/services` (6.10.7), `@oxyhq/bloom` (0.6.11) — Oxy platform integration
