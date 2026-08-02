# @allo/shared-types

TypeScript contracts shared between the Allo frontend (`@allo/frontend`) and
backend (`@allo/backend`).

This package models the **wire / transport layer** only: the HTTP response
envelope and the serialized DTOs the backend returns. It deliberately does
*not* contain the frontend's presentation-shaped store types, nor mongoose
schema types — the models import the primitives from here and layer their own
document types on top.

## Package Structure

```
src/
├── api.ts           # HTTP response envelope + pagination
├── message.ts       # Message DTOs (encrypted + legacy plaintext media)
├── conversation.ts  # Conversation + Oxy-enriched participant DTOs
├── device.ts        # Device key bundle / pre-key DTOs
└── index.ts         # Re-exports every module
```

## Core Types

### API transport (`api.ts`)

Mirrors `packages/backend/src/utils/apiHelpers.ts`.

- **`ApiSuccessResponse<T>`** — success envelope; payload lives under `data`.
- **`ApiErrorResponse`** — `{ error, message }` shape emitted on failure.
- **`PaginationOptions`** — offset-based `{ limit, offset }` for list endpoints.

### Messages (`message.ts`)

Mirrors the `Message` model as served by `routes/messages.ts`.

- **`MessageDto`** — serialized message. Mongoose `Map` fields (`readBy`,
  `reactions`) are typed as `Record<string, …>` because they serialize to plain
  JSON objects on the wire.
- **`EncryptedMediaItem`** — media descriptor on the encrypted-message path. The type exists in the schema, but no client code currently produces one — see [docs/encryption.mdx](../../docs/encryption.mdx).
- **`MediaItem`** — plaintext media descriptor, retained for the legacy
  pre-encryption path only.
- **`MediaKind`** / **`MessageKind`** — `"image" | "video" | "audio" | "file"`
  and `"text" | "media" | "system"`.

### Conversations (`conversation.ts`)

Mirrors the `Conversation` model plus the enrichment done by
`utils/oxyUserDisplay.ts` for `GET /api/conversations`.

- **`ConversationDto`** — serialized conversation with enriched participants.
- **`ConversationParticipant`** — raw participant as stored on the document.
- **`EnrichedConversationParticipant`** — participant plus Oxy profile data
  (name, username, avatar).
- **`ParticipantDisplayName`** — `displayName` is canonical and composed by the
  Oxy API; `first` / `last` must never be used to recompose it.
- **`ConversationType`** / **`ConversationParticipantRole`**.

### Devices (`device.ts`)

Mirrors the `Device` model as exchanged by `routes/devices.ts`. All key
material is Base64 encoded.

- **`DeviceDto`** — full device record, including one-time pre-keys.
- **`PublicDeviceBundle`** — bundle returned for key exchange
  (`GET /api/devices/user/:userId`); excludes one-time pre-keys.
- **`SignedPreKey`** / **`PreKey`**.

## Usage

The package is a workspace dependency — no install step beyond the root
`bun install`. Import types directly from the package root:

```typescript
import type { ConversationDto, MessageDto, PublicDeviceBundle } from "@allo/shared-types";
```

## Development

```bash
bun run build   # tsc → dist/
bun run dev     # tsc --watch
bun run clean
```

A `lint` script is declared but does not run: this package ships neither eslint
nor an `eslint.config.js`, so it exits with "ESLint couldn't find an
eslint.config.js". `tsc` is the only check this package has, and it runs on
every `bun install` — the root `postinstall` calls `build:shared-types`, so a
type error here fails the install before anything else compiles.

The backend and frontend consume `dist/`, so `shared-types` builds first in the
root `bun run build` chain.

## Contributing

When adding types:

1. Only add what crosses the frontend/backend boundary. Types used by a single
   package belong in that package.
2. Document which model / route the DTO mirrors, so drift is easy to spot.
3. Model mongoose `Map` fields as `Record<string, …>` — that is their JSON shape.
4. Export the module from `index.ts`.

## License

UNLICENSED — private package for Allo.
