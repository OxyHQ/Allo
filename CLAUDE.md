# Allo

## AWS Deployment

The backend runs on **AWS ECS Fargate** (region `eu-west-1`, cluster `oxy-cluster`), behind an ALB with ACM HTTPS.

- **Port**: `8080` | **Domain**: `api.allo.oxy.so`
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` builds a `linux/arm64` Docker image → pushes to ECR (`237343248947.dkr.ecr.eu-west-1.amazonaws.com/oxy/allo`) → `aws ecs update-service --force-new-deployment`
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
  bridge/         @allo/bridge        Telegram bridge connector (Express + gramjs, HMAC-signed contract with backend, flag-gated by BRIDGE_ENABLED)
```

## Key Features

- **E2E Encryption**: Signal Protocol (`lib/signalProtocol.ts`) — X3DH + Double Ratchet (X25519, Ed25519, ChaCha20-Poly1305)
- **Multi-device E2E**: Per-device Signal envelopes stored in the `MessageEnvelope` collection (`encryptionVersion: 3`). Each device gets its own encrypted copy. Devices communicate via Socket.io rooms keyed as `device:{userId}:{deviceId}`. The `X-Device-Id` request header identifies the active device. Frontend exposes a linked-devices screen with revocation support and P2P history transfer via pairing code. Media E2E keys ride inside the encrypted message body.
- **Offline-first**: Queue + sync (`lib/offlineQueue/`, `lib/offlineStorage.ts`, `lib/optimistic/`)
- **Real-time**: Socket.io for messaging, WebRTC for calls and P2P data channels
- **i18n**: i18next with locales

## Tech

- **Frontend**: Expo Router 6, NativeWind 4.2, TanStack React Query 5, Zustand 5, Immer
- **Backend**: Express 4, Mongoose 8, Firebase Admin, JWT, bcryptjs, rate limiting

## Interop Bridge

The `packages/bridge` package (`@allo/bridge`) is a standalone Express service that connects Allo to external networks (initially Telegram, via gramjs). It is **disabled by default** — set `BRIDGE_ENABLED=true` on the backend to activate.

Communication between backend and bridge connector is HMAC-signed. The canonical signature string is `${METHOD}.${path}.${ts}.${rawBody}`. Types are shared via `@allo/shared-types`: `BridgeEvent`, `BridgeCommand`, `BridgeLinkStepResult`.

**Required env vars to provision (never commit values):**

| Variable | Notes |
|---|---|
| `TELEGRAM_API_ID` | From my.telegram.org |
| `TELEGRAM_API_HASH` | From my.telegram.org |
| `BRIDGE_SHARED_SECRET` | >= 32 chars, identical on backend and bridge |
| `BRIDGE_SESSION_KEY` | >= 32 chars, bridge-side only |
| `BRIDGE_SERVICE_URL` | URL the backend calls to reach the bridge |
| `ALLO_INTERNAL_URL` | URL the bridge calls to reach the backend |
| `BRIDGE_MONGODB_URI` | Separate DB for bridge session state |

The bridge is **not yet wired into CI/ECS** — it requires manual deployment.

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

## CRITICAL — Dependency Gotchas

Two production outages have been caused by duplicate or stale dependency copies. Read before touching `bun.lock` or `package.json`:

- **bun.lock must be regenerated only with bun 1.3.11** (the CI-pinned version). Using any other bun version produces a different lockfile that can break frozen-install in CI.
- **Root `overrides`/`resolutions` are load-bearing.** The root `package.json` pins:
  - `@oxyhq/core` → `1.11.23`
  - `@react-navigation/native` → `7.2.4`
  - `@react-navigation/core` → `7.17.4`
  - `expo-modules-core` (version pinned in overrides)
  Do NOT remove or change these without understanding why they exist.
- **`@allo/shared-types` uses `workspace:*` protocol** — never replace with `file:` references.
- **`packages/frontend` must declare `@oxyhq/core` explicitly** in its own `package.json`. It does not inherit the resolution automatically.
- **`@oxyhq/services` declares `@oxyhq/core: "*"`** upstream (known issue). The root override is what keeps the correct version resolved. Do not assume the upstream will fix this soon.

## Testing

`bun run test` runs tests across all packages. Approximate counts as of 2026-06-12:

| Package | Tests |
|---|---|
| backend | 320 |
| bridge | 99 |
| frontend | 217 |

The frontend `tsc` type-check has a pre-existing ~75-error baseline (legacy code). The rule is **zero new errors** — do not add to the count, and do not suppress errors with `@ts-ignore` or `as any`.

## Production Domains

| Surface | URL | Notes |
|---|---|---|
| Web app | https://allo.oxy.so | Cloudflare Pages project `allo-frontend`, deploys on push to `main` |
| API | https://api.allo.oxy.so | ECS Fargate, port 8080 |
| Old API | ~~api.allo.earth~~ | **DEAD** — DNS removed in AWS migration. Do not reference. |
