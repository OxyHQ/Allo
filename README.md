# Allo

<p align="center">
  <b>A cross platform chat app with end to end encrypted direct messages.</b><br>
  One Expo codebase for iOS, Android and web, an Express backend on PostgreSQL and MongoDB, and identity from Oxy.
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

Messages are written locally first and the cloud is secondary. Cloud sync is a setting
the user controls, not a requirement.

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
| [`@allo/backend`](packages/backend/) | Express API and Socket.IO server — PostgreSQL via drizzle (social, moderation, bridges) and MongoDB via Mongoose (messaging) |
| [`@allo/shared-types`](packages/shared-types/) | TypeScript types shared by both |

Identity and sessions come from the Oxy platform rather than from a login system in this
repo: [`@oxyhq/services`](https://github.com/OxyHQ/oxy) on the frontend,
`@oxyhq/core/server` for the backend's auth, CORS and rate limit middleware, and
`@oxyhq/bloom` for shared UI.

There is no `controllers/`, `middleware/` or `sockets/` directory in the backend. Routes
hold their own handlers and the Socket.IO wiring sits directly in `server.ts`.

## Quick start

You need Node 20.19+, Bun, a PostgreSQL instance AND a MongoDB instance — the Mongo→Postgres port is partway through, so both stores are live. The root `engines` field pins Node
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
`test` (Jest), `lint` (`expo lint`), `clean`, plus `copy-matrix-wasm`, `clear-cache` and
`reset-project`. The dev, start, web and build scripts run `copy-matrix-wasm` first.

**`@allo/backend`**: `dev`, `start`, `build`, `test` (Vitest, which starts a real MongoDB
replica set and needs a real Postgres for the schema suite), `clean`, plus
`db:generate` and `db:migrate`.

**`@allo/shared-types`**: `build`, `dev` (watch), `lint`, `clean`.

**Postgres migrations exist and are NOT applied automatically.** `packages/backend/drizzle/`
holds them and `bun run db:migrate -- --target-database=<name> --phase=all` is the only
migrator. The AWS deploy does not run it — `.github/scripts/deploy-ecs-image.sh` defaults
`RUN_MIGRATIONS` to `false` and no workflow sets it — so merging a schema change does not
ship it. The Mongoose schemas backing the messaging domain are still applied on connect,
which is why this sentence used to say there were no migrations at all.

</details>

> [!NOTE]
> The root `lint` script does not work end to end. The backend declares no `lint` script,
> and `shared-types` declares one without shipping ESLint or a config, so it fails with
> "ESLint couldn't find an eslint.config.js". Only the frontend is lintable today, via
> `bun run --filter @allo/frontend lint`.

## Moving to Matrix

Allo is migrating to [Matrix](https://matrix.org) and will stop carrying its own
transport. The design work is deliberately ahead of the code.

**Nothing has switched over yet.** What ships today is REST plus Socket.IO against
`@allo/backend`. A Matrix client port exists under
[`packages/frontend/lib/matrix/`](packages/frontend/lib/matrix/), with separate native and
web implementations, but no screen in the app imports it.

<details>
<summary><b>Design notes and the spikes that informed them</b></summary>

<br>

Design only, no implementation proposed yet:

| Note | Subject |
|---|---|
| [`data-model.md`](docs/matrix/data-model.md) | How Allo conversations map onto Matrix rooms, and what the mapping costs |
| [`client-strategy.md`](docs/matrix/client-strategy.md) | Which SDK on which platform, and why |
| [`bridges.md`](docs/matrix/bridges.md) | Bridge topology and its constraints |
| [`interim-homeserver.md`](docs/matrix/interim-homeserver.md) | Homeserver plan for the transition |
| [`linked-accounts.md`](docs/matrix/linked-accounts.md) | Tying Matrix identities to Oxy accounts |
| [`ephemeral.md`](docs/matrix/ephemeral.md) | Typing notifications and receipts |
| [`push.md`](docs/matrix/push.md) | Push notification routing |
| [`ui-wiring.md`](docs/matrix/ui-wiring.md) | Connecting the client port to screens |

`spikes/` holds the throwaway apps that tested the risky assumptions first. They are not
workspaces and no root script builds them.

- [`spikes/matrix-web/`](spikes/matrix-web/) runs `matrix-js-sdk` and
  `matrix-sdk-crypto-wasm` under a production Expo web export. Its `RESULTS.md` records
  what it proved and what it did not.
- [`spikes/matrix-rn/`](spikes/matrix-rn/) runs `@unomed/react-native-matrix-sdk` on a
  physical Android device. It needs ARM hardware, because the native library ships only
  `armeabi-v7a` and `arm64-v8a`, so an x86_64 emulator installs and then crashes. The
  generated `android/` project is not committed, so run `expo prebuild` first.

</details>

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
