# ADR 0001: Allo Platform is a clean break

Status: Accepted, 2026-09-17
Source: OxyHQ/Allo issue #139 ("Allo Platform, CLEAN BREAK"), sections 0, 21 and 24.
Implementation brief: the lead's target design for branch `feat/allo-platform-clean-break`.

## Context

Allo has no real users whose data, clients or protocol must be preserved. What
exists in the tree at the base commit (`ab66060`) is a prototype:

- An Express plus Socket.IO backend over Postgres with the legacy messaging
  routes (`routes/messages.ts`, `routes/conversations.ts`, `routes/devices.ts`)
  and their tables (`messages`, `message_*`, `devices`, `device_pre_keys`).
- A frontend encryption module, `packages/frontend/lib/signalProtocol.ts`,
  that performs static ECDH P-256 between long-lived identity keys with no KDF
  and AES-256-GCM. It is not the Signal Protocol: no forward secrecy, pre-keys
  generated but unused, one recipient device chosen per send, groups broken,
  and a plaintext fallback when encryption cannot proceed. `docs/encryption.mdx`
  documents this in full.
- A Matrix client port (`packages/frontend/lib/matrix/`) selected by
  `EXPO_PUBLIC_CHAT_BACKEND`, a Matrix Authentication Service token path in the
  backend (`middleware/matrixAuth.ts`), a Matrix push gateway, Matrix-bound
  bridge tables and routes, two Matrix spikes under `spikes/`, and a design
  corpus in `docs/matrix/` whose product tiers (normal, ephemeral, bridged;
  `data-model.md` section 5) depend on Matrix semantics.
- A homeserver that was never deployed (`matrix.allo.you` does not resolve).

Two transports coexist behind a flag and neither is a credible foundation:
the legacy one has the crypto above, the Matrix one has no homeserver of our
own and pins the product to somebody else's protocol and SDK release cycle.
Continuing incrementally would mean carrying both while building a third.

Oxy needs Allo to be a messaging platform other Oxy apps (Mention first) can
consume through an SDK, with real end-to-end encryption and real multi-device.

## Decision

The following are decided, taken from the issue's section 24 table and the
section 0 rules.

| Question | Decision |
|---|---|
| Own backend? | Yes. A modular monolith over Postgres, built on the operational patterns of Mention's backend (fail-fast boot, migrations before readiness, transactional outbox, lease-claimed workers, graceful shutdown, sanitised logs). |
| Matrix as the core? | No. Removed entirely: client port, SDKs, WASM copy step, MAS auth path, push gateway, bridges, DNS workflow, spikes and `docs/matrix/`. |
| Backward compatibility? | No. No DTO, endpoint, table or wire format is kept for a client that does not exist. |
| Migrate old conversations? | No. Development tables are reset; retired tables are dropped. |
| Keep the current crypto? | No. `signalProtocol.ts`, the device key model and the plaintext-capable routes and columns are deleted. |
| SDK from the start? | Yes. `@allo/core` (headless) and `@allo/react`. Allo App is a consumer of the same packages Mention will consume; there is no second engine inside the app. |
| Crypto engine? | MLS (RFC 9420) after the spike. Wrapped behind a `CryptoEngine` interface so the implementation can be swapped. |
| Primary phone? | No. Every authorised installation is an independent cryptographic instance and is first class; a computer needs no phone. |
| Mention first? | Yes, as the first real integration. That is Phase 4 and is not part of this change. |
| Merge chats per person automatically? | No. Visual grouping is optional and is a UI preference. |
| Truly shared thread across apps? | Yes, but explicit and authorised (a ConversationBinding, later phase). |
| Cloud bridges under the same privacy promise? | No. A cloud-operated bridge is a separate trust boundary that can read the remote network's content. |
| Microservices from day one? | No. Monolith plus workers when needed. |

Rules that bind every part of this change (issue section 0): no migration
layer, no dual stack, no legacy crypto reader, no dual write, no temporary
compatibility without a date, no plaintext branch, no feature flag back to the
old engine.

## Consequences

- The backend's messaging surface is `/v1` and is new. Every chat table is new.
  The old tables are dropped in a post-rollout migration; nothing reads them.
- The backend stores and relays ciphertext only. It never holds a key that
  decrypts a message, a group name, a read receipt or a media file. Read
  receipts and group names are application messages inside the MLS group.
- Authentication has two layers: an Oxy bearer token identifies the account,
  and an Ed25519 signature bound to a registered client instance authorises
  everything that touches a conversation. A stolen Oxy token alone cannot act
  as an instance.
- Frontend chat code goes through `@allo/react` hooks over `@allo/core`. The
  Zustand messaging stores, the AsyncStorage message cache, the offline queue,
  the optimistic layer and the P2P scaffold are deleted rather than adapted.
- Product tiers that depended on Matrix are gone: the ephemeral tier and the
  bridged tier. Ephemeral messaging becomes a future policy on the new engine.
  Bridges return in Phase 5 on the connector contract, not as Matrix bridges.
- `@allo/shared-types` is broken deliberately: it now carries the v1 wire
  contract (zod schemas and types) and nothing legacy.
- History transfer between instances, encrypted backup and recovery, app grants
  for third-party apps, and connectors are designed and not built. Until they
  exist, a new instance sees only events from the epoch it joined onward, and
  losing every instance loses history. See `docs/platform/roadmap.md`.
- Documentation describing the retired architecture (`docs/encryption.mdx`,
  `docs/architecture.mdx`, `docs/matrix/`) is replaced, not annotated.

## What is replaced and why

| Replaced | Why | Replaced by |
|---|---|---|
| `lib/signalProtocol.ts`, `stores/deviceKeysStore.ts`, `devices` and `device_pre_keys` tables, `routes/devices.ts` | Static ECDH with no KDF: one constant key per pair forever, no forward secrecy, no groups, one device per recipient, plaintext fallback. Verified in `docs/encryption.mdx`. | MLS groups via the `CryptoEngine` in `@allo/core`; `client_instances`, `key_packages`, `conversation_leaves`. |
| `routes/messages.ts`, `routes/conversations.ts`, `messages`, `message_reads`, `message_deliveries`, `message_reactions`, `conversation_participants` | Routes and columns able to carry plaintext (`text`, `last_message_*`); receipts and reactions visible to the server; no per-instance delivery or sync cursor. | `conversation_events` (ciphertext), `instance_deliveries` (outbox and per-instance cursor), receipts and reactions as encrypted application messages. |
| Matrix client port (`lib/matrix/`), `EXPO_PUBLIC_CHAT_BACKEND`, Matrix SDKs and WASM copy step, `__mocks__/@unomed`, `spikes/`, `docs/matrix/` | No homeserver of our own, foreign protocol as the product core, two transports behind a flag. | One transport: `/v1` over REST and Socket.IO, consumed by `@allo/core`. |
| `middleware/matrixAuth.ts`, `config/matrixAuth.ts`, `services/auth/*` (MAS introspection) | Only existed to admit Matrix Authentication Service tokens. | Oxy bearer plus instance signature (`middleware/instanceAuth.ts`). |
| `routes/pushGateway.ts`, `routes/push.ts` (gateway capability minting), `services/push/gatewayToken.ts`, `services/push/notification.ts` | Implemented the Matrix Push Gateway; Synapse owned the pusher registry. | Push token per instance (`PUT /v1/instances/me/push`) and the delivery worker sending "New message" with an event reference only. The FCM and APNs senders are kept. |
| `bridge_*` tables, `routes/bridges.ts`, `routes/bridgesInternal.ts`, `services/bridges/*`, `config/bridges.ts`, `lib/bridges/`, linked-accounts screens | Bound to mautrix-style Matrix bridges; nothing could be linked in any environment. | Nothing in this change. Phase 5 connectors on the connector contract (`docs/platform/concepts.md`). |
| `lib/offlineStorage.ts`, `lib/offlineQueue/`, `lib/optimistic/`, `stores/messagesStore.ts`, `stores/conversationsStore.ts` | Plaintext messages serialised into AsyncStorage; queue drained to the server regardless of settings. | `@allo/core` storage (encrypted at rest with a key in the platform secret store), outbox and sync modules. |
| `cloudSyncEnabled` setting and `lib/security/cloudSync.ts`, `security_cloud_sync_enabled` column | Its two ends disagreed and "off" did not keep messages off the server. | Explicit history, retention and recovery design (Phase 3). |
| `lib/p2pMessaging.ts` | Never established a connection. | Nothing. Not a goal of the platform. |
| Ephemeral tier (`lib/matrix/ephemeral/`, `lib/chat/ephemeralSweep.ts`, `so.oxy.allo.ephemeral_rooms`) | Built on Matrix account data and redaction; the other participants were never told. | Nothing in this change; a future policy on the new engine. |

## What is deliberately NOT built

From issue section 21:

- A reader for old ciphertext.
- An ECDH to MLS converter.
- A Matrix room importer.
- A Matrix id to Allo id translator.
- Dual write.
- Message mirroring between systems.
- Migration of the current device keys.
- A compatibility API for clients that do not exist.
- A permanent feature flag that can return to the insecure protocol.

## Rollback meaning during development

Rollback means returning code and infrastructure to an earlier commit in
development environments. It does not mean keeping the legacy protocol
activatable in production. Once the new protocol is the launch baseline there
is no switch that silently degrades a conversation to the old system.

Development data for messaging is reset when that is simpler and safer than
writing a migration that only exists to preserve test data.

## Cutover checklist (issue section 21) and its status in this change

The lead fills the status column after verifying the tree. Values: `done`,
`not applicable`, `later phase`.

| Issue checkbox | Status in this change |
|---|---|
| Allo App switches to the new SDK/core | TBD-BY-LEAD |
| Remove `EXPO_PUBLIC_CHAT_BACKEND` | TBD-BY-LEAD |
| Remove the Matrix backend as a product path | TBD-BY-LEAD |
| Remove unused Matrix SDKs | TBD-BY-LEAD |
| Remove unused Matrix WASM and copy scripts | TBD-BY-LEAD |
| Remove unused Matrix stores, hooks and adapters | TBD-BY-LEAD |
| Remove Matrix documentation describing a retired architecture | TBD-BY-LEAD |
| Remove Matrix workflows, DNS and config | TBD-BY-LEAD |
| Remove `signalProtocol.ts` and the legacy key model | TBD-BY-LEAD |
| Remove legacy plaintext endpoints | TBD-BY-LEAD |
| Remove columns and tables that only served the legacy contract | TBD-BY-LEAD |
| Remove `cloudSyncEnabled` | TBD-BY-LEAD |
| Remove `offlineStorage.ts` and AsyncStorage messaging | TBD-BY-LEAD |
| Remove old types, DTOs, aliases and compat shims | TBD-BY-LEAD |
| Reset development data instead of writing an artificial migration | TBD-BY-LEAD |
