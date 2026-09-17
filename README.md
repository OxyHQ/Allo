# Allo

<p align="center">
  <b>A cross platform chat app with end to end encrypted direct messages.</b><br>
  One Expo codebase for iOS, Android and web, an Express backend on PostgreSQL, and identity from Oxy.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-440151?style=flat-square"></a>
  <img alt="Expo" src="https://img.shields.io/badge/Expo-57-440151?style=flat-square&logo=expo&logoColor=white">
  <img alt="React Native" src="https://img.shields.io/badge/React%20Native-0.86-440151?style=flat-square&logo=react&logoColor=white">
  <img alt="Bun" src="https://img.shields.io/badge/bun-1.0+-440151?style=flat-square&logo=bun&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-440151?style=flat-square&logo=typescript&logoColor=white">
</p>

---

<table>
<tr>
<td valign="top" width="50%">

### 🔐 Encrypted where it counts

Direct messages are encrypted on the device before they leave it. The server stores
ciphertext and public keys, never private key material.

Private keys live in the iOS Keychain and the Android Keystore through
`expo-secure-store`. Only the public half of a device bundle ever reaches the backend.

</td>
<td valign="top" width="50%">

### 📱 Device first

Messages are written locally first and the server is secondary.

Mutations made offline are queued and replayed on reconnect, so the app keeps working
without a network.

</td>
</tr>
</table>

> [!WARNING]
> **Read the crypto claims carefully before trusting them.** Allo uses a static ECDH
> (P-256) agreement between long lived identity keys plus AES-256-GCM. There is no KDF
> and no ratchet, so the AES key for a pair of identity keys is constant and only the IV
> changes per message. There is **no forward secrecy**. Group chats, multi device and
> media are not covered, and when a recipient has no registered device the message is
> sent in plaintext rather than blocked.
>
> The module is named `signalProtocol.ts` for historical reasons only. It does not
> implement the Signal Protocol: no X3DH, no Double Ratchet. The generated pre-keys are
> never used to encrypt, and the pre-key signature is never verified.
>
> [`docs/encryption.mdx`](docs/encryption.mdx) documents all of this, including the gaps.

## Packages

The repo is a Bun workspace monorepo. Everything lives under `packages/`.

| Package | What it is |
|---|---|
| [`@allo/frontend`](packages/frontend/) | The Expo app for iOS, Android and web. Expo Router, NativeWind, Zustand, TanStack Query |
| [`@allo/backend`](packages/backend/) | Express API and Socket.IO server — PostgreSQL via drizzle, for every domain |
| [`@allo/shared-types`](packages/shared-types/) | TypeScript types shared by both |

Identity and sessions come from the Oxy platform rather than from a login system in this
repo: [`@oxy.so/services`](https://github.com/OxyHQ/oxy) on the frontend,
`@oxy.so/core/server` for the backend's auth, CORS and rate limit middleware, and
`@oxy.so/bloom` for shared UI.

There is no `controllers/`, `middleware/` or `sockets/` directory in the backend. Routes
hold their own handlers and the Socket.IO wiring sits directly in `server.ts`.

## Quick start

You need Node 20.19+, Bun and a PostgreSQL instance. The root `engines` field pins Node
`>=20.19.0` and Bun `>=1.0.0`.

```bash
bun install          # postinstall builds @allo/shared-types for you
bun run dev          # frontend and backend together
```

Or one at a time:

```bash
bun run dev:frontend   # Expo on Metro port 8140, then press w, i or a
bun run dev:backend    # nodemon + ts-node with hot reload
```

iOS needs macOS and Xcode. Android needs Android Studio. The per platform scripts have no
root aliases, so reach them through the workspace filter:

```bash
bun run --filter @allo/frontend web     # or ios, or android
```

Before opening a pull request, run what CI runs:

```bash
bun run typecheck && bun run test
```

<details>
<summary><b>Every script, by package</b></summary>

<br>

**Root**

| Script | What it does |
|---|---|
| `bun run dev` | Start every package in dev mode |
| `bun run dev:frontend` / `dev:backend` | Start one of them |
| `bun run build` | Build every package |
| `bun run build:shared-types` / `build:frontend` / `build:backend` | Build one of them |
| `bun run typecheck` | `tsc --noEmit` over backend then frontend |
| `bun run test` | Tests across all packages |
| `bun run start:frontend` / `start:backend` | Production start |
| `bun run clean` | Remove build artifacts and `node_modules` |

**`@allo/frontend`**: `start`, `dev`, `android`, `ios`, `web`, `build`, `build-web`,
`test` (Jest), `lint` (`expo lint`), `clean`, plus `clear-cache` and `reset-project`.

**`@allo/backend`**: `dev`, `start`, `build`, `test` (Vitest, which needs a real Postgres
server — each `*.realdb.test.ts` suite creates its own throwaway, fully-migrated
database on it), `clean`, plus `db:generate` and `db:migrate`.

**`@allo/shared-types`**: `build`, `dev` (watch), `lint`, `clean`.

**Postgres migrations ARE applied by the deploy, in two phases.** `packages/backend/drizzle/`
holds them and `bun run db:migrate -- --target-database=<name> --phase=<pre|post|all>` is the
only migrator. `deploy-aws.yml` sets `RUN_MIGRATIONS: "true"` and runs `--phase=pre` before
the rollout and `--phase=post` after it, each as a one-shot ECS task — so merging a schema
change ships it, and the `-- oxy:deploy-phase=` marker on each `.sql` decides which side of
the rollout it lands on.

</details>

> [!NOTE]
> The root `lint` script does not work end to end. The backend declares no `lint` script,
> and `shared-types` declares one without shipping ESLint or a config, so it fails with
> "ESLint couldn't find an eslint.config.js". Only the frontend is lintable today, via
> `bun run --filter @allo/frontend lint`.

## The Allo platform

The chat transport is being replaced, not extended. The decision and the design are in
[`docs/adr/0001-clean-break-platform.md`](docs/adr/0001-clean-break-platform.md) and
[`docs/platform/`](docs/platform/).

## Documentation

Describing the system as it runs today:

| Doc | Subject |
|---|---|
| [Overview](docs/index.mdx) | What Allo is and how the pieces fit together |
| [Architecture](docs/architecture.mdx) | Packages, data flow, and the realtime transport |
| [Encryption](docs/encryption.mdx) | Device keys, static ECDH derivation, and what is not implemented |
| [API reference](docs/api.mdx) | The REST and Socket.IO surface |

Per package detail lives in [`packages/backend/README.md`](packages/backend/README.md) and
[`packages/frontend/README.md`](packages/frontend/README.md).

## Contributing

Issues and pull requests are welcome. Fork, branch, make the change, run
`bun run typecheck && bun run test`, then open a pull request.

## License

[MIT](LICENSE). Copyright (c) 2024-present OxyHQ.
