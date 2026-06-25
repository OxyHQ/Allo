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

## Oxy SDK Conventions

- **Versions**: `@oxyhq/core ^3.10.0`, `@oxyhq/services ^11.0.0`, `@oxyhq/bloom ^0.19.1`, `@oxyhq/contracts ^0.2.1` (transitive via core). `@oxyhq/services ^11.0.0` is a packaging-only major — deps moved to peerDependencies; app must declare `@tanstack/react-query`, `@tanstack/react-query-persist-client`, `@tanstack/query-async-storage-persister` (all `^5.100.0`) in its own `dependencies`.
- **Media**: avatars/images resolve ONLY through `oxyServices.getFileDownloadUrl(id, variant)` + bloom's variant-aware `<Avatar source={fileId} variant="thumb">`. Never hardcode `cloud.oxy.so` or `/media/` URLs.
- **Display names**: render `name.displayName` directly (core 3.10 fixes the type under node resolution). No local name fallbacks.
- **Backend auth**: `@oxyhq/core/server` only — `createOxyAuthMiddleware`/`getRequiredOxyUserId`/`authSocket`. No local `requireAuth`, bearer parsers, or token-decoding middleware.
- **CORS**: backend uses `createOxyCors` from `@oxyhq/core/server`. No hand-rolled CORS middleware.
- **Canonical backend domain**: `api.allo.oxy.so`. Do not use `allo.you` or `allo.chat` as backend targets.
- **Backend client**: `oxyServices.createLinkedClient({ baseURL })` — no local token providers, auth interceptors, manual `Authorization` headers, refresh retries, or session invalidation.

## Dependencies

- `@oxyhq/core ^3.10.0`, `@oxyhq/services ^11.0.0`, `@oxyhq/bloom ^0.19.1` — Oxy platform integration

## CRITICAL — Dependency Gotchas

**@oxyhq/core and @oxyhq/services must be pinned via root overrides AND resolutions.**
`@oxyhq/services` declares `@oxyhq/core` as a peer. Without an explicit override, Bun may
hoist a satisfying-but-different core build inside the services package, causing type mismatches and
runtime errors. The root `package.json` must carry both `overrides` and `resolutions` entries pointing
to the current target (`^3.10.0`). The frontend/backend should use the same major/minor line.

**Expo web SSO callback bootstrap:** `packages/frontend/app/+html.tsx` injects
`getSsoCallbackBootstrapScript()` from `@oxyhq/core`. Do not add a local
`/__oxy/sso-callback` route or copy SSO helper logic. Frontend auth/session state
belongs to `OxyProvider` with a registered `clientId`; SDK cold boot owns callback
consumption, stored-session restore, FedCM/silent restore, and SSO bounce. App
backend clients use `oxyServices.createLinkedClient({ baseURL })`, not local token
providers, auth interceptors, manual `Authorization` plumbing, refresh retries, or
session invalidation. Backend auth middleware comes from `@oxyhq/core/server`
(`createOxyAuthMiddleware`, `createOptionalOxyAuth`, `createOxyRateLimit`,
`requireOxyAuth`, `getRequiredOxyUserId`, `authSocket`); do not define local
`AuthRequest`, `requireAuth`, `getUserId`, bearer parsers, or token-decoding
middleware. Bearer-authenticated writes do not fetch app-local CSRF tokens; CSRF
remains for ambient cookie credentials.

**`@react-native-community/netinfo` is now a peer of `@oxyhq/services@7` (no longer bundled).**
Both root `overrides` and `resolutions` pin it to `^11.4.1` so the services side and the app share
the same instance; the frontend declares it as a direct dependency.

**Version history (abbreviated):**
- `@oxyhq/services` 8.0.0: `@tanstack/*` moved to peerDependencies. Consumers must declare `@tanstack/react-query`, `@tanstack/react-query-persist-client`, and `@tanstack/query-async-storage-persister` (all `^5.100.0`) themselves.
- `@oxyhq/services` 10.0.0: `appName` prop removed from `OxyProvider` — use `clientId`.
- `@oxyhq/services` 11.0.0: packaging-only major — deps moved to peerDependencies. Public API unchanged. Current target.
- `@oxyhq/core` 3.10.0: current target. `name.displayName` type corrected under node resolution.
- `@oxyhq/bloom` 0.19.1: variant-aware media — `ImageResolver` + `<Avatar source={fileId} variant="thumb">`. Current target.

**bun.lock regeneration checklist (MUST follow when bumping these deps):**
1. Run `bun install` from the **monorepo root** (not inside a package) — a single install from root
   is the only way to guarantee ALL workspace resolutions (including `@allo/backend/@allo/shared-types`)
   are written correctly to `bun.lock`.
2. Verify `bun install --frozen-lockfile` passes locally before pushing.
   A partial/stale regeneration once dropped the `@allo/backend/@allo/shared-types` workspace resolution
   line, which made CI's `bun install --frozen-lockfile` (deploy-frontends.yml) fail and
   would have blocked the allo.oxy.so redeploy.
3. CI and the backend Dockerfile both pin **bun 1.3.14** (matches local). Keep `deploy-frontends.yml`
   and `packages/backend/Dockerfile` aligned with your local bun when regenerating `bun.lock`
   to avoid format drift that fails CI.
4. Commit the updated `bun.lock` together with `package.json` changes in the same commit.
