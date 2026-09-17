# @allo/backend

> The backend package of the Allo monorepo — the Express/TypeScript API service.

---

## Overview

This is the **backend package** of the **Allo** monorepo. It owns what the
messaging platform needs on a server — conversations, membership, client
instances, E2EE coordination, events, delivery, sync, media and push — plus the
account-side features that sit beside it: profile settings, blocks and
restricts, a people directory that projects Oxy profiles, and account reports
delivered to CrowdSource. Authentication is Oxy's, so there is no user
management here.

Messaging platform routes: see [docs/platform/api-v1.md](../../docs/platform/api-v1.md).

## Tech Stack

- Node.js with TypeScript
- Express.js for REST API
- PostgreSQL with drizzle-orm — the only store, for every domain
- Oxy Services for authentication (users managed by Oxy platform)

## Getting Started

### Prerequisites

- Node.js 20.19+ and Bun 1.3+
- A PostgreSQL instance (the service, and the `*.realdb.test.ts` suites)
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

Create a `.env` file in this package directory. `.env.example` is the annotated
list; the short form:

```env
# Database. REQUIRED — the server refuses to boot without it.
DATABASE_URL=postgres://allo:allo@127.0.0.1:5432/allo_dev

# Authentication
# WE USE OXY FOR AUTHENTICATION - users are managed by Oxy platform
# Read by @oxy.so/core (OxyServices.ts), not by this package directly.
# Defaults to https://api.oxy.so when unset.
OXY_API_URL=https://api.oxy.so

# Server Configuration
# 4140 is Allo's slot in the per-app local port map; ECS injects PORT=8080.
PORT=4140
NODE_ENV=development

# Redis for the Socket.IO adapter (optional; unset or unreachable means
# single-instance mode, never a boot failure).
REDIS_URL=

# Largest accepted blob upload, in bytes (optional; default 25 MiB).
ALLO_BLOB_MAX_BYTES=

# Push providers (optional; each platform is all-or-nothing, see
# src/config/push.ts). Used by the delivery worker only.
FIREBASE_PROJECT_ID=
FIREBASE_SERVICE_ACCOUNT_BASE64=
ALLO_APNS_KEY_ID=
ALLO_APNS_TEAM_ID=
ALLO_APNS_PRIVATE_KEY_BASE64=
ALLO_APNS_TOPIC=
ALLO_APNS_ENVIRONMENT=production

# CrowdSource moderation (optional; the webhook route is not mounted when unset)
CROWDSOURCE_ENABLED=false
CROWDSOURCE_ENFORCEMENT_MODE=shadow
CROWDSOURCE_WEBHOOK_SECRET=your_webhook_secret
# Set during a secret rotation so in-flight deliveries signed with the old
# secret still verify.
CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS=

# Allo's own credential for calling the Oxy API as itself (optional; both or
# neither). Every Oxy route the directory uses is public, so the lookups work
# without it — see "People directory" below.
ALLO_OXY_SERVICE_API_KEY=
ALLO_OXY_SERVICE_API_SECRET=

# Tests only: the Postgres server each run creates its throwaway database ON.
# Point it at a maintenance database, never one holding anything. Falls back to
# DATABASE_URL when unset — see "Running the tests" below.
TEST_DATABASE_URL=
```

There is no `FRONTEND_URL`: the CORS allowlist is not read from the environment.
`createOxyCors` admits the Oxy apex family (`*.oxy.so`) automatically, and the
extra development origins are the literal list at the top of `server.ts`.

`FRONTEND_URL` and `JWT_SECRET` appear in older deployment docs but are read
neither by this package nor by `@oxy.so/core`. Setting them changes nothing.

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

PostgreSQL is the only store, for every domain. `DATABASE_URL` is required at
boot: the server refuses to start without it rather than serving 500s from
whichever route is hit first.

Apply the schema with `bun run db:migrate -- --target-database=<name>
--phase=all`; see "Migrations" below. **The AWS deploy does this for you** —
`deploy-aws.yml` sets `RUN_MIGRATIONS: "true"` and runs `--phase=pre` before the
rollout and `--phase=post` after it, so merging a schema change ships it.

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
- **Public URL** — `api.allo.you`.

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

One way to be signed in: an Oxy access token.

```
Authorization: Bearer <oxy access token>
```

`createOxyAuthMiddleware(oxy)` from `@oxy.so/core/server`, mounted on `/api`
and `/v1` in `src/app.ts`, alongside `createOxyCors` and `createOxyRateLimit`
from the same package. It produces `req.userId` / `req.user` for every route
behind it. The `/v1` routes that act as one installation additionally require
the instance signature (see "Messaging platform" below).

`/api` carries `/profile`, `/reports` and `/directory`. The CrowdSource webhook
is mounted at `/webhooks/crowdsource`, ahead of the JSON body parser, because it
needs the raw body to verify its signature; so is `POST /v1/blobs`.

### People directory

`/api/directory/*` answers the five Oxy lookups the app makes, so the app draws
a person through this backend rather than by calling Oxy itself.

| Route | Replaces |
| --- | --- |
| `GET /api/directory/profiles/username/:username` | `oxyServices.getProfileByUsername` |
| `GET /api/directory/users/:userId` | `oxyServices.getUserById` |
| `POST /api/directory/users/by-ids` (`{ ids }`, max 100) | `oxyServices.getUsersByIds` |
| `GET /api/directory/profiles/search?query=&limit=&offset=` | `oxyServices.searchProfiles` |
| `GET /api/directory/assets/:fileId/url?variant=` | `oxyServices.getFileDownloadUrl` |

Every one answers a `DirectoryUser` (or a list of them) from
`@allo/shared-types`, which is a **projection**: id, handle, display name,
first/last, avatar id, resolved avatar URL, bio. The Oxy `User` carries `email`,
`phone`, `address` and `birthday`, and this backend asks Oxy as itself, so
anything it forwarded it would forward to every signed-in user.

Each `DirectoryUser` already carries `avatarUrl`, so a place in the app that
turns an avatar id into a URL becomes a field read rather than a request. The
asset endpoint exists for an id that arrives from somewhere else.

Authenticated, even though every underlying Oxy route is public: an
unauthenticated profile lookup here would be an enumeration endpoint pointed at
Oxy's whole user base with Allo's IP reputation in front of it.

No service credential is required, for the same reason. Setting
`ALLO_OXY_SERVICE_API_KEY` / `ALLO_OXY_SERVICE_API_SECRET` only changes how the
bulk lookup authenticates; see `src/config/oxyService.ts`, which also documents
the console.oxy.so step that mints them.

### Health

- `GET /health/live` — always 200 `{ status: "alive" }`. A draining task is
  still alive; draining is reported by readiness only.
- `GET /health/ready` — 200 once the process has booted, verified the migration
  ledger (production) and can `select 1` against Postgres; 503 otherwise, with
  `phase` and `dependencies: { postgres, migrations }`. Drops to 503 on the
  first SIGTERM, before anything else closes.
- `GET /api/health` — an alias of `/health/ready`, kept for the existing ALB
  target group.

Redis is deliberately absent from readiness: the Socket.IO adapter is optional
and a task without it serves correctly in single-instance mode.

### Messaging platform (`/v1`)

The route-by-route contract is [docs/platform/api-v1.md](../../docs/platform/api-v1.md);
every request and response shape is a zod schema in `@allo/shared-types`, and
the backend validates with the same schemas the SDK parses with. In short:

| Area | Routes | Auth |
| --- | --- | --- |
| Instances | `POST/GET /v1/instances`, `GET /v1/accounts/:accountId/instances` | Oxy |
| Enrollment | `GET /v1/instances/pending`, `POST /v1/instances/:id/{approve,reject,revoke}`, `PUT/DELETE /v1/instances/me/push` | instance-signed |
| Key packages | `PUT /v1/key-packages`, `POST /v1/key-packages/claim` | instance-signed |
| Conversations | `POST/GET /v1/conversations`, `GET /v1/conversations/:id`, `POST /v1/conversations/:id/leave` | instance-signed |
| Events | `POST/GET /v1/conversations/:id/events` | instance-signed |
| Sync | `GET /v1/sync`, `POST /v1/sync/ack` | instance-signed |
| Blobs | `POST /v1/blobs` (raw octet-stream), `GET /v1/blobs/:id` | instance-signed |

"Instance-signed" means the Oxy bearer PLUS `X-Allo-Instance`,
`X-Allo-Timestamp` and `X-Allo-Signature`: an Ed25519 signature by the
installation's key over the method, the request target, the timestamp and the
SHA-256 of the raw body (`src/middleware/instanceAuth.ts`). The raw body is
captured by `express.json({ verify })`, which is why the blob upload — raw
bytes, size-capped by `ALLO_BLOB_MAX_BYTES` — is mounted ahead of the JSON
parser in `src/app.ts` with its own chain.

Socket.IO namespace `/v1` takes the same three fields in `handshake.auth`
(path `/socket`, empty body) after `oxy.authSocket()`. A socket joins
`instance:<id>` and `account:<accountId>`; the server emits `sync.nudge`,
`instance.approved`, `instance.revoked`, `keypackages.low` and `presence`, and
relays `typing` ciphertext to a conversation's other active leaves without
storing it (`src/runtime/socket.ts`).

Every non-2xx answer on `/v1` is `{ error: { code, message, details? } }` with
`code` from `ALLO_ERROR_CODES`; the one place that shape is written is the error
handler in `src/app.ts`, and routes throw `AlloHttpError` (`src/utils/httpErrors.ts`).

The server never sees plaintext: every `payload` is MLS ciphertext, a `typing`
frame is ciphertext, a push says only "New message" with the conversation and
event ids, and `__tests__/platform/noPlaintextPaths.test.ts` scans the routers'
TypeScript AST to keep it that way.

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

Account reports only. Message content is deliberately never sent for review — it
is end-to-end encrypted and the server never holds a key — and that is enforced
in three places rather than one: `ModerationSubjectProvider` only types an
account subject, so a `message` provider does not compile; a test pins
`deliverableTypes()` to `['user']`; and a second test pins the module graph the
providers can reach, so no provider can describe a conversation.

#### POST /api/reports
- File a report against an account
- `reportedId` is an Oxy account id. An `@handle` is accepted and stored, with
  the reason it cannot be reviewed recorded on the row, and never delivered —
  resolve a handle through the directory first. The response is identical
  either way
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

### Push

`src/services/push/` delivers a `{ title, body, data }` notification to a list
of `{ platform, token }` devices through FCM and APNs (`sendPush` in
`dispatch.ts`). APNs is HTTP/2 plus an ES256 provider token, with no library.
The senders never see message content; what a notification says and who is
notified is decided by `src/workers/deliveryWorker.ts`: title "Allo", body
"New message", `data = { conversationId, eventId }`, sent only for an
`app_message` to an instance with no live socket and a registered token. A
token lives on the `client_instances` row (`PUT /v1/instances/me/push`), is a
protected column, and is cleared when a provider rejects it.

### Workers

All started by `server.ts` after Postgres is verified, all stopped in the
shutdown drain before the pool closes, none leader-gated (every claim is
`FOR UPDATE SKIP LOCKED`, so every task may run one):

| Worker | Interval | What it does |
| --- | --- | --- |
| `workers/deliveryWorker.ts` | 1 s, batch 100 | Claims `pending` `instance_deliveries` under a lease; nudges a connected instance over the socket, pushes otherwise (app messages only), backs off transient failures (`min(2^attempts s, 1h)`) |
| `db/expiry.ts` | 60 s | Deletes rows past `expires_at`: moderation tables, deliveries older than 30 days, blobs unreferenced for 7 days |
| `workers/blobGc.ts` | 1 h | The blob delete the sweep cannot express: unreferenced blobs of a revoked uploader |
| `services/moderation/ModerationOutboxDispatcher.ts` | configured | CrowdSource report delivery and decision application |

## Module map

```
server.ts                       bootstrap only: env → Postgres → ledger → sockets → workers → listen → ready
src/app.ts                      createApp(deps): pure HTTP assembly, middleware order, error handler
src/runtimeApp.ts               the concrete deps (Oxy client, CORS, rate limit, auth, routers)
src/runtime/                    health state, realtime seam, Socket.IO server, Redis adapter, shutdown, global handlers
src/middleware/                 instanceAuth (Ed25519 request signature), requestObservability
src/routes/v1/                  one router per contract file: instances, keyPackages, conversations, events, sync, blobs
src/routes/                     kept /api routers: directory, profileSettings, reports, crowdSourceWebhook
src/services/platform/          the rules: instance lifecycle, key packages, conversations, events + sync, blobs, wire projections
src/db/schema/                  one file per domain; CONVENTIONS.md is binding
src/db/platform/                repositories; appendClientEvent is the event-log transaction
src/workers/                    deliveryWorker, blobGc
src/services/push/              FCM and APNs senders
src/services/moderation/        CrowdSource pipeline
drizzle/                        generated migrations, one phase marker each
```

## Development Scripts

- `bun run dev` — Start development server with hot reload
- `bun run build` — Build the project
- `bun run start` — Start production server
- `bun run test` — Run the vitest suite
- `bun run clean` — Clean build artifacts
- `bun run db:generate` — Generate a migration from `src/db/schema/`
- `bun run db:migrate -- --target-database=<name> --phase=pre|post|all` — Apply
  migrations. The only migrator; never `drizzle-kit migrate`.

This package declares no `lint` script. CI runs the suite on every PR
(`.github/workflows/ci.yml`).

### Running the tests

The suite in `src/__tests__/` needs a real PostgreSQL server and nothing else.
Each `*.realdb.test.ts` file creates its own throwaway, fully-migrated database
on it, named `oxydb_test_<hex>`, and drops it afterwards.

```bash
docker compose -f docker-compose.postgres.yml up -d
TEST_DATABASE_URL=postgres://allo:allo@127.0.0.1:5440/postgres bun run test
```

Without `TEST_DATABASE_URL` (or `DATABASE_URL`) the schema suite fails with a
message naming this command. That is deliberate: a database test that skips
itself when no server is present is a test nobody notices has stopped running.

A real server rather than a mock, because the properties under test only exist
on one: `ON CONFLICT` against a unique index, `xmin`, a CHECK rendered from a
tuple, an increment evaluated in SQL. A mocked `insert` accepts statements the
server rejects outright. See `src/db/schema/CONVENTIONS.md` for the decisions
the schema is bound by.

## Monorepo Integration

This package is part of the Allo monorepo and integrates with:

- **@allo/frontend**: React Native application
- **@allo/shared-types**: Shared TypeScript type definitions

### Shared Dependencies
- Uses `@allo/shared-types` for type safety across packages
- Integrates with `@oxy.so/core` for authentication, CORS and rate limiting. This
  package does not depend on `@oxy.so/services` — that is the React Native SDK
  and is a frontend dependency only.
- Uses `@oxy.so/crowdsource*` for the moderation pipeline

## Notes

- **No User Management**: Users are managed by the Oxy platform. The backend only stores Oxy user IDs.
- **Authentication**: All authenticated endpoints use Oxy's authentication middleware.
- **Encryption**: the backend stores and relays ciphertext only and never holds
  a decryption key. See [docs/platform/crypto.md](../../docs/platform/crypto.md).
