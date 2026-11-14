# Allo

Encrypted messaging: Expo / React Native frontend, Express + Postgres backend, MLS-based `@allo/core` SDK. Agent: `allo`.

## Commands

```bash
bun install                 # postinstall builds contracts, SDK, shared-types, core, react
bun run dev                 # all packages (dev:frontend / dev:backend for one)
bun run build               # all packages
bun run typecheck           # backend, core, react, frontend; no emit
bun run test                # all packages
bun run lint                # biome check . plus the frontend's expo lint
bun run lint:fix            # Biome safe fixes; `bun run format` formats
bun run doctor:oxy          # Oxy dependency checks (also `i18n:check`)
```

Backend tests need a local Postgres and nothing else; see
[`packages/backend/README.md`](packages/backend/README.md).

## Map

- Agent rules by area: [`docs/agent-rules/`](docs/agent-rules/), one file per topic (see Docs below).
- Product and API docs: [`docs/index.mdx`](docs/index.mdx), [`docs/architecture.mdx`](docs/architecture.mdx), [`docs/platform/`](docs/platform/), ADRs in [`docs/adr/`](docs/adr/).
- Screens: [`packages/frontend/ARCHITECTURE.md`](packages/frontend/ARCHITECTURE.md). Schema decisions: [`packages/backend/src/db/schema/CONVENTIONS.md`](packages/backend/src/db/schema/CONVENTIONS.md).
- Packages: `packages/{frontend,backend,shared-types,core,react,contracts,sdk}`; workspace ids are `@allo/<name>`.

## Conventions that differ from defaults

- Biome is the only formatter and linter; add a new guard to `biome.jsonc`, never grow `packages/frontend/eslint.config.js` (it holds only what Biome cannot do).
- Build UI only from Bloom (`@oxy.so/bloom/<subpath>`, icons from `@oxy.so/bloom/icons`); a missing piece is fixed in Bloom and released, never hand-built here.
- Colours come from `useTheme().colors.*`, never literals. Do not add a second `QueryClientProvider`; `OxyProvider` owns it.
- Row ids are `text` in two shapes (uuid v7 and 24-char hex): never validate an id against one shape. Id-shape rule: [postgres-and-drizzle](https://github.com/OxyHQ/oxy/blob/main/docs/postgres-and-drizzle.md).
- Postgres is the only store; routes go through `db/<domain>/` repositories and never build SQL.
- `oxy.middleware.auth()` takes a token only from a header starting with exactly `"Bearer "`.
- First-party never asks people for permissions: this app acts for a person with `actingFor` on what oxy's first-party registry declares (oxy ADR 0066); permissions, scopes and consent are only for third parties.
- Read `EXPO_PUBLIC_*` only as a literal `process.env.X`; Metro inlines nothing else (enforced by the Expo ESLint in `lint`).
- Bump `packages/frontend` `version` only for a native change: it is the OTA runtime and store build number.

## Boundaries

- Never publish to npm from a laptop; merging a version bump to main publishes it ([npm-releases](https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md)).
- Never edit a generated migration `.sql` without keeping its `-- oxy:deploy-phase=` marker correct: `pre` is additive, `post` drops or narrows, and the deploy applies both around the rollout.
- Never assert an exact order for rows written within one millisecond in tests; space the writes.
- Ask first before changing the chat transport, MLS or key handling: read [`docs/agent-rules/the-allo-platform.md`](docs/agent-rules/the-allo-platform.md).

## Testing

- Backend change: `bun run typecheck` then the targeted `bun test` file; DB code uses the `*.realdb.test.ts` pattern (each creates its own database).
- Frontend change: typecheck plus `jest`; navigation changes also run `__tests__/routes/navigationTargets.test.ts` because `tsc` cannot check routes.
- Done means `bun run lint`, `bun run typecheck` and `bun run test` pass. CI runs the same in `.github/workflows/ci.yml`.

## PRs and commits

- Branch from `main`, one concern per PR, squash-merge with `gh pr merge <n> --squash`. Allo has no merge queue.
- Org-wide git, PR, naming and security standards: [OxyHQ/engineering](https://github.com/OxyHQ/engineering/blob/main/AGENTS.md).

## Secrets

`DATABASE_URL` and signing keys come from the environment / GitHub secrets and ECS task config. Never print or commit them. Android release signing uses `OXY_UPLOAD_*` Gradle properties, never the repo.

## Docs

Moved-out rules, read before changing the area:

- [`deployment.md`](docs/agent-rules/deployment.md): ECS deploy, migrations phases, boot gate, Android and OTA releases.
- [`tooling-and-ci.md`](docs/agent-rules/tooling-and-ci.md): Biome and ESLint split, CI, why `tsc` cannot check routes.
- [`frontend-architecture.md`](docs/agent-rules/frontend-architecture.md): Bloom-first screens, harness mode, NativeWind, theming, React Query.
- [`data-storage.md`](docs/agent-rules/data-storage.md): Postgres, id shapes, creation-order caveat.
- [`the-allo-platform.md`](docs/agent-rules/the-allo-platform.md), [`key-features.md`](docs/agent-rules/key-features.md), [`dependency-gotchas.md`](docs/agent-rules/dependency-gotchas.md).
- Oxy-wide: [lint-and-format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md), [build-and-runtime-traps](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/build-and-runtime-traps.md), [gate-writing](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/gate-writing.md), [Bloom app conventions](https://github.com/OxyHQ/Bloom/blob/main/docs/app-conventions.mdx).

Owner: OxyHQ (CODEOWNERS). Last reviewed: 2026-11-11.
