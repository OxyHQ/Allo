# @allo/shared-types

The Allo platform's API v1 wire contract, as zod schemas with their inferred
TypeScript types. `@allo/backend` validates request bodies and queries with
them; `@allo/core` types its calls and parses every answer through the same
ones. One definition, both sides.

`docs/platform/api-v1.md` is the route-by-route reference generated from
these modules by hand; the schema wins where the two disagree.

## Package structure

```
src/
├── common.ts           # ids, base64, timestamps, error envelope, AlloErrorCode, base64url codec
├── instances.ts        # ClientInstance, enrollment, push token, enrollmentApprovalMessage()
├── requestSigning.ts   # X-Allo-* headers, signedRequestMessage(), socket handshake auth
├── keyPackages.ts      # upload / claim MLS key packages
├── conversations.ts    # ConversationSummary, create/list, dmKeyFor()
├── events.ts           # ConversationEvent, SubmitEventRequest (+ CommitInfo), ControlEvent
├── sync.ts             # the delivery stream, cursors, Socket.IO event payloads
├── blobs.ts            # encrypted blob upload/download
├── appMessage.ts       # the E2EE envelope (plaintext before MLS), encode/decode
├── api.ts              # legacy success/error envelope (directory routes only)
├── directory.ts        # people directory DTOs (the Oxy lookups, projected)
├── index.ts            # re-exports every module
└── __tests__/          # vitest; positive AND negative cases per schema
```

Naming: `fooSchema` is the zod schema, `Foo` is `z.infer<typeof fooSchema>`,
and a closed set is an `as const` tuple (`FOO_KINDS`) beside its `z.enum`.
Pure helpers whose output both sides must agree on byte for byte
(`signedRequestMessage`, `enrollmentApprovalMessage`, `dmKeyFor`,
`encodeCursor` / `decodeCursor`, `encodeAppMessage` / `decodeAppMessage`)
live here so there is exactly one implementation.

No React, no Node-only API in anything that ships: the base64url codec and
the UTF-8 encoding are written against `Uint8Array`, `TextEncoder` and
`TextDecoder` so the same code runs in Node, browsers and Hermes.

## Usage

```typescript
import { submitEventRequestSchema, type SubmitEventRequest } from "@allo/shared-types";

const body: SubmitEventRequest = submitEventRequestSchema.parse(req.body);
```

## Development

```bash
bun run build       # tsc → dist/ (tests excluded)
bun run typecheck   # tsc --noEmit over src/ INCLUDING the tests
bun run test        # vitest run
bun run clean
```

`tsconfig.json` excludes `src/__tests__` so tests do not land in `dist/`;
`tsconfig.test.json` puts them back for `typecheck`, which is the only thing
that type-checks a test. Run `bun install` from the monorepo root only.

## Contributing

1. Only what crosses the backend/SDK boundary belongs here.
2. A schema change is a contract change: update `docs/platform/api-v1.md`.
3. Every schema gets at least one test that a wrong shape is REJECTED; a
   refinement (a field required under one discriminant) gets a mutation check.
4. Export the module from `index.ts`; `__tests__/index.test.ts` asserts a
   marker per module.
