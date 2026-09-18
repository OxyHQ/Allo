# @allo/frontend

> The frontend package of the Allo monorepo - A modern, cross-platform chat app built with Expo, React Native, and TypeScript.

---

## Table of Contents
- [About](#about)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Development Scripts](#development-scripts)
- [Contributing](#contributing)
- [License](#license)

---

## About

This is the **frontend package** of the **Allo** monorepo. **Allo** is a chat platform for mobile and web where every conversation, direct or group, is **end-to-end encrypted with MLS** by the Allo platform SDK (`@allo/core`), and every message is decrypted and stored on the device. Built with Expo and React Native, it supports file-based routing, multi-language support, and a modern UI.

This package contains the complete React Native application that runs on Android, iOS, and Web platforms.

## Features

### Security & Encryption
- 🔐 **End-to-End Encryption** - Every conversation is an MLS group; `@allo/core` encrypts, decrypts and stores on the device. The server carries ciphertext and public keys only.
- 📱 **Devices, not sessions** - Each installation is an *instance* with its own signing key. The first device of an account is active at once; every later one waits on an approval screen until an already-active device approves it from Settings → Devices, comparing a verification code.
- 🗄️ **Encrypted at rest** - The SDK's store is SQLite on iOS/Android and IndexedDB on the web, and every value in it is ciphertext. The storage key and the signing key live in the Keychain/Keystore (`expo-secure-store`) on a phone.
- ⚠️ **Web secret store** - A browser has no Keychain. On the web those two keys live in an IndexedDB store named `secrets`, and any script on the origin can read them; see `lib/allo/secrets.web.ts`. Clearing site data revokes the device.

### Messaging
- Real-time, encrypted messaging for direct and group conversations, through `@allo/react`
- Works offline on what the device already has; sends are queued and retried by the SDK
- Message edits, deletes, reactions and replies
- Read receipts and delivery status
- Encrypted media: pictures, videos, voice notes and documents, decrypted only when shown

### User Experience
- Universal app: Android, iOS, and Web
- User profiles (`app/(chat)/u/[id].tsx`)
- Multi-language support (English, Spanish, Italian)
- Responsive design and theming
- Modern UI with custom icons and animations

Push notifications go through the platform: see
[Push Notifications](#push-notifications) below.

## Tech Stack
- [Expo](https://expo.dev/) SDK 57 & React Native 0.86 (React 19.2)
- TypeScript
- NativeWind 5 (preview) — Tailwind CSS for React Native, paired with `tailwindcss` 4.3
- Zustand (state management)
- i18next (internationalization)
- Expo Router (file-based routing)
- Custom SVG icons
- Expo Notifications, Secure Store, Camera, Video, Image Picker
- **`@allo/core` + `@allo/react`** - The Allo platform SDK: MLS end-to-end encryption, sync, outbox, media, devices (see [`docs/platform/`](../../docs/platform/))
- **expo-sqlite / IndexedDB** - The SDK's encrypted store, per platform
- **expo-secure-store** - The storage key and this device's signing key (native)

## Project Structure
```
├── app/                # App entry, screens, and routing
│   └── ...
├── components/         # UI components
├── assets/             # Images, icons, fonts
├── constants/          # App-wide constants
├── context/            # React context providers
├── hooks/              # Custom React hooks
├── lib/                # Library code
│   ├── allo/           # THE seam to the SDK: the only place a client is built (see below)
│   ├── chat/           # Chat view-model types, projections, pickers, viewer arithmetic
│   └── ...
├── locales/            # i18n translation files (en, es, it)
├── plugins/            # Expo config plugins
├── scripts/            # Utility scripts
├── metro/              # Stub modules Metro is pointed at for the MLS engine (see metro.config.js)
├── stores/             # State management (Zustand): UI state, preferences, the people cache
│   └── ...
├── styles/             # Global styles and colors
├── types/              # TypeScript types
├── utils/              # Utility functions
├── __mocks__/          # Jest manual mocks
├── __tests__/          # Jest suites
├── app.config.js       # Expo app configuration
├── config.ts           # Base URLs and third-party keys
├── package.json        # Project metadata and dependencies
└── ...
```

## The messaging seam: `lib/allo/`

Screens and components never import `@allo/core` for a value; they use the
hooks in `@allo/react` (`useConversations`, `useTimeline`, `useOwnInstances`,
…) and the projections in `lib/chat/model.ts`. `lib/allo/` is the only place
the SDK is *constructed*, and every platform adapter it needs lives there:

| File | What it is |
|---|---|
| `client.ts` | `createAppAlloClient` — the one `createAlloClient(...)` call, with the adapters below |
| `storage.native.ts` / `storage.web.ts` | `StorageAdapter` over `expo-sqlite` (`allo.db`, table `kv`) / IndexedDB (`allo`, store `kv`); `batch` is one transaction |
| `secrets.native.ts` / `secrets.web.ts` | `SecretStore` over `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) / IndexedDB (`allo-secrets`); the web file documents the limitation |
| `session.ts` | `OxySessionAdapter` over the `OxyServices` instance `useOxy()` provides — the session authority |
| `people.ts` | `PeopleDirectory` and the coalesced `getUsersByIds` lookup that fills `usersStore`; the only place the chat path asks Oxy about a person |
| `push.ts` | The device push token → `client.instance.setPushToken`, once permission is granted; cleared on sign-out |
| `useMediaUri.ts` + `mediaSink.*.ts` | A `MediaRef` → a URI a player can open: a cache file on native, an object URL on web, released on unmount |
| `AlloRoot.tsx` + `EnrollmentGate.tsx` | Client lifecycle (one per signed-in account; stop on switch, `reset()` on sign-out) and the approval / revoked screens |
| `RestoreHistoryPrompt.tsx` | "Restore your history?", asked once of a fresh device whose account has a backup on the server (see [Backup and recovery](#backup-and-recovery)) |
| `recoveryPhrase.ts` | The phrase normalisation the SDK applies, re-exported so the backup screen counts words the way `restore()` will |

A source scan, `__tests__/allo/noLegacyChatPath.test.ts`, keeps it that way:
no `socket.io-client`, no AsyncStorage on the chat path, no legacy messaging
endpoint, and `@allo/core` imported for values only inside `lib/allo/`.

### Metro and the MLS engine

`metro.config.js` carries a resolver for three things the engine's dependencies
need and Metro cannot do on its own: `crypto` (a Node-only fallback in
`@hpke/common`, behind a `globalThis.crypto` check that never fails in a browser
or on Hermes) resolves to `metro/empty-module.js`; the optional `ts-mls` peers
for ciphersuites Allo does not use (`@hpke/ml-kem` and friends) resolve to
`metro/ts-mls-optional-peer.js`, which throws by name if anything ever reads it;
and `@hpke/*` are pointed at their ESM builds, because the CJS ones are UMD
wrappers whose `require` parameter shadows the global and leaves Metro's
dependency collector blind. All three apply to every platform, including the
static-render bundle `expo export` runs in Node.

## Getting Started

### Prerequisites
- Node.js 20.19+ and Bun 1.3+
- Expo CLI (optional, but recommended)
- For iOS development: macOS with Xcode
- For Android development: Android Studio

### Development Setup

#### Option 1: From the Monorepo Root (Recommended)
```bash
# Clone the repository
git clone https://github.com/OxyHQ/Allo.git
cd Allo

# Install all dependencies
bun install

# Start frontend development
bun run dev:frontend
```

#### Option 2: From This Package Directory
```bash
# Navigate to this package
cd packages/frontend

# Install dependencies
bun install

# Start the app
bun run start
```

### Running the App

Once the development server is running, you can:

- **Web**: Press `w` in the terminal or run `bun run web`
- **iOS**: Press `i` in the terminal or run `bun run ios` (requires macOS)
- **Android**: Press `a` in the terminal or run `bun run android`
- **Expo Go**: Scan the QR code with the Expo Go app on your device

### Environment Setup

Base URLs are resolved in `config.ts`, which hardcodes production
(`https://api.allo.you`) and only consults the environment in development.
None of the variables below is required to run against a local backend — the
defaults already point at `localhost:4140`, Allo's slot in the Oxy per-app port
map.

```env
# Dev-only API overrides, read by config.ts
API_URL=http://localhost:4140/api
API_URL_SOCKET=ws://localhost:4140

# Oxy identity. OXY_BASE_URL defaults to https://api.oxy.so in every build —
# there is deliberately no dev branch, because pointing identity at a local port
# renders a signed-out app instead of failing loudly.
EXPO_PUBLIC_OXY_BASE_URL=https://api.oxy.so
EXPO_PUBLIC_OXY_CLIENT_ID=your_oxy_client_id

# Selects the build variant in app.config.js ('testflight' | 'production')
EXPO_PUBLIC_ENV=

# Optional third-party keys; empty string when unset
EXPO_PUBLIC_KLIPY_APP_KEY=
EXPO_PUBLIC_STRIPE_LINK_PLUS=
EXPO_PUBLIC_STRIPE_LINK_FILE=
```

`EXPO_PUBLIC_WS_URL`, `EXPO_PUBLIC_POSTHOG_KEY` and `EXPO_PUBLIC_BITDRIFT_KEY`
appear in older docs and are read nowhere in this package. Setting them changes
nothing. (`@bitdrift/react-native` is configured as an Expo plugin in
`app.config.js`, not through an environment variable.)

## Development Scripts

- `bun run start` — Start Expo development server
- `bun run dev` — Start Expo development server (alias for start)
- `bun run android` — Run on Android device/emulator
- `bun run ios` — Run on iOS simulator
- `bun run web` — Run in web browser
- `bun run build-web` — Build static web output
- `bun run build-web:prod` — Build static web output for production
- `bun run reset-project` — Reset to a fresh project state
- `bun run clear-cache` — Clear Expo cache
- `bun run lint` — Lint codebase
- `bun run test` — Run tests
- `bun run clean` — Clean build artifacts

## Monorepo Integration

This package is part of the Allo monorepo and integrates with:

- **@allo/backend**: API server for data and authentication
- **@allo/shared-types**: Shared TypeScript type definitions

### Shared Dependencies
- Uses `@allo/shared-types` for type safety across packages
- Integrates with `@oxy.so/services` for common functionality

## Security & Encryption

Encryption is the platform's, not the app's. `@allo/core` keeps every
conversation as an MLS group; the app never touches a key, a ciphertext or a
group state. What the app is responsible for is where the SDK keeps its
secrets and its store on each platform — the adapters in `lib/allo/` — and the
enrollment gate that keeps an unapproved device out. The design, the threat
model and what is still open are in [`docs/platform/`](../../docs/platform/).

### Known Limitations

- **Web keys are readable by the origin.** No Keychain in a browser: the storage
  key and the signing key are in IndexedDB. See `lib/allo/secrets.web.ts`.
- **No thumbnail on send.** `UploadMediaMeta` carries none, so a receiver draws a
  picture only after downloading the original; a video with no thumbnail draws a
  play mark until opened.
- **No history for a new device.** A second device reads from the moment it was
  approved; history transfer is a later phase of the SDK.
- **The pending device cannot show its own verification code.** The SDK's
  `InstanceView` omits the challenge; the approving device shows it, and the
  pending screen asks the user to check the device name.
- **Sign-out wipes this device's messages.** `AlloRoot` calls `reset()` on
  sign-out, which revokes the instance and clears its store; signing back in
  enrols the device afresh.

## The Allo platform

The app runs on it: `@allo/react` for the hooks, `lib/allo/` for the seam (see
[above](#the-messaging-seam-liballo)). The design is in
[`docs/adr/0001-clean-break-platform.md`](../../docs/adr/0001-clean-break-platform.md)
and [`docs/platform/`](../../docs/platform/).

The Jest suites run under the `jest-expo` preset, which is why `bun run test`
here is not interchangeable with `bun test`.

### History on a new device

A device that is approved into an account has no history: MLS keys are per
leaf, and nothing before this device's join epoch is decryptable with them.
Two things in `@allo/core` bring history across, and the app's part in each is
small.

#### Transfer

Automatic. The device that adds a newly approved device to the account's
groups offers its history once, end-to-end encrypted to the new device's
transfer key, and the new device accepts on its own — only from a verified,
active instance of the same account (`UntrustedInstanceError` otherwise). The
app makes no decision about trust. It draws a banner above the conversation
list, `components/conversation/HistoryTransferBanner.tsx`, while
`useHistoryTransfer().progress.phase !== 'idle'`: "Receiving history from
<device>" (the donor from `fromInstanceId`, named through `useOwnInstances()`,
or a generic line for a device the list does not know) or "Sending history to
<device>", with `done of total` once the total is known. `pendingOffers` and
`accept()` exist in the hook for an offer the SDK would not take by itself;
no screen lists them yet.

#### Backup and recovery

**Settings → Backup and recovery** (`app/(chat)/settings/backup.tsx`, the
panel in `components/backup/BackupPanel.tsx`, the hook `useBackup()`):

- **Status:** on or off on this device, when the last backup was made and how
  many events it covered, and whether the server holds one for the account —
  which is only known after `refreshStatus()` has asked, so the panel asks once
  on mount and draws "checking" until the answer lands.
- **Turn on** calls `enable()` and shows the 12-word recovery phrase ONCE, in a
  numbered grid with a copy button. The panel refuses to let the words go, and
  the route refuses to be left (back arrow, hardware back, swipe), until "I
  wrote them down" is ticked. **The app never persists the phrase:** it lives in
  the panel's state while on screen and nowhere once it is not — not in a store,
  not in a log, not in a preference. The SDK keeps only the key derived from it.
- **Back up now** (`refresh()`) and **Turn off** (`disable()`, behind a
  confirm) once it is on. The SDK also refreshes on its own after enough new
  events.
- **Restore from recovery phrase** appears when `status.remote?.exists` and the
  backup is not enabled here: a paste-friendly 12-word input (lower-cased,
  whitespace-normalised before `restore(phrase)`). A wrong phrase is refused by
  the SDK before anything is downloaded and drawn as a friendly message
  (`RecoveryPhraseError`); anything else is a generic failure.

Why the restore section keys on the server's answer and never on an empty
list: a fresh device already sees the account's conversation rows — `joined:
false`, empty timelines — before it has restored anything.

**First run.** `lib/allo/RestoreHistoryPrompt.tsx`, mounted by `AlloRoot`,
asks "Restore your history?" once: the instance is active, the server holds a
backup (asked once per client), the backup is not enabled here, no timeline on
this device has anything in it, and this instance has not answered before.
"Restore" opens the backup screen; "Not now" is remembered for this instance in
`stores/restorePromptStore.ts` — a preference, like the conversation themes,
and keyed by instance id so a device that starts over is asked afresh. It is a
card over the bottom of the app, never a gate: the app is usable behind it and
boot does not wait for it.

**What cannot be offered:** restore on a pending device. `client.backup.restore`
and `refreshStatus` both refuse a non-active instance, so the approval screen
cannot even say whether a backup exists; approval comes first. Losing every
device and the phrase loses history, and the screens say so rather than
implying the server can help.

`__tests__/allo/backupScreen.test.tsx` drives the panel against a real
`@allo/core` client over the fake server — enable, the confirm gate, a wrong
phrase, the right phrase from a second install of the same account —
and `__tests__/allo/transferBanner.test.tsx` covers the banner's states.

### Message status marks

`components/messages/messageStatus.ts` maps a message's `readStatus` to a mark
and a tone, and `MessageMetadata` only draws them: pending is the clock, `sent`
one tick (the server has it), `delivered` two ticks in the quiet colour (a
recipient's device sent a delivered receipt), `read` the same two ticks in the
accent colour, `failed` the error mark in its own colour even inside a bubble.
`__tests__/messages/messageStatus.test.ts` pins the table.

### Thumbnails

`lib/chat/attachments.ts` renders a JPEG thumbnail for every picture and video
the sender picks, and `ConversationView` passes its bytes in
`UploadMediaMeta.thumbnail` so the SDK encrypts and uploads it as a second blob
whose key travels in the same `media` message. A receiver's bubble
(`MediaCarousel`) draws `thumbnailRef` when there is one and downloads the
original only for the viewer. A thumbnail that cannot be read is dropped and the
attachment still goes.

## Push Notifications

The device token is the SDK's to register. Once the OS grants permission —
either from the first-run sheet (`NotificationPermissionGate`) or the switch in
Settings — `lib/allo/push.ts` reads the FCM/APNs token through
`expo-notifications` and hands it to `client.instance.setPushToken`, which
makes it this instance's pusher on the backend. Nothing about the token is
stored in the app, and `clearPushToken` removes it on sign-out.

Where a token cannot be had — the web, a simulator, an Expo Go client (remote
push needs a development build) — nothing is registered and nothing is said.
What the notification says, and whether it is delivered at all, is the
backend's: the app only registers the device.

## Contributing

Contributions are welcome! Please see the [main README](../../README.md) for the complete contributing guidelines.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting: `bun run test && bun run lint`
5. Submit a pull request

## License

This project is licensed under the MIT License.
