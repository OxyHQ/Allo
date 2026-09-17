# Allo Platform roadmap

Phases from issue #139 section 22. "This change" is branch
`feat/allo-platform-clean-break` as specified by the lead's design; the lead
confirms each "delivered" item against the tree before merge. Anything under
"remains" is not built.

## Environment constraint on the crypto spike

The issue asks for OpenMLS and `mls-rs` to be compared on iOS, Android,
web and desktop. The spike in this change ran with a pure TypeScript
implementation of RFC 9420, `ts-mls`, because no Rust toolchain was available
in the environment and it was the only MLS implementation that could be
installed. `@allo/core` wraps it behind a `CryptoEngine` interface so that a
native implementation can replace it without touching the rest of the SDK.
OpenMLS and `mls-rs` remain to be compared on device for binary size, memory,
performance, persistence, crash recovery and audit status. The details and
the ciphersuite decision are in `crypto.md`, written after the spike.

## Phases

### Phase 0: Clean slate

Delivered by this change: feature freeze on Matrix and the legacy crypto; the
ADR (`docs/adr/0001-clean-break-platform.md`); the threat model; the
conceptual contract (`concepts.md`); removal of documentation that made
incorrect claims (`docs/encryption.mdx`, `docs/architecture.mdx`,
`docs/matrix/` are replaced).

Remains: deciding the real licence of the published packages.

### Phase 1: Crypto spike

Delivered by this change: an MLS spike with `ts-mls` covering group creation,
add and remove, multi-instance exchange, welcome, persistence and restart,
run under Node and a production web build; the `CryptoEngine` interface; the
ciphersuite choice; a crypto provider decision for React Native (Hermes has
no `crypto.subtle`).

Remains: OpenMLS and `mls-rs` on iOS, Android and desktop; on-device
measurements; concurrent commit and offline-member behaviour at scale; an
external security review.

### Phase 2: New Allo Core

Delivered by this change: the v1 wire contract in `@allo/shared-types`; the
new backend schema (`client_instances`, `key_packages`, `conversations`,
`conversation_members`, `conversation_leaves`, `conversation_events`,
`instance_deliveries`, `blobs`) with pre and post deploy-phase migrations;
instance registration, enrollment approval, rejection and revocation; key
package upload and claim; conversations and events with per-conversation
sequence and epoch compare-and-set; per-instance delivery outbox, sync
cursor and ack; Socket.IO nudges, presence and encrypted typing relay;
`@allo/core` (session, instance, crypto, encrypted storage, transport, sync,
outbox, conversations, messages, media, devices, events) with an in-memory
fake server for multi-instance tests; `@allo/react` provider and hooks; Allo
App consuming `@allo/react` only, with a devices screen and a
pending-approval gate.

Remains: whatever the lead lists as undone after verification (see the
acceptance table below).

### Phase 3: History, media, recovery

Delivered by this change: encrypted media (per-file keys, encrypted
thumbnails, blob upload and download, GC, size limit); minimal push through
FCM and APNs; revocation with the Remove commit performed by a remaining leaf.

Remains: encrypted history archive and manifests; E2EE history transfer
between instances; encrypted backup unlocked by user-held recovery material; a
self-custodied recovery mechanism able to approve an instance; resumable
uploads and quotas; client-generated push previews; an S3 blob store.

### Phase 4: Mention

Nothing delivered by this change beyond the `appId` field on instances and
conversations.

Remains: end-to-end Mention integration over `@allo/core`; app grants;
origin badges; unified thread views; shared-thread permissions
(ConversationBinding); the minimum proof from issue section 14 (send from
Mention web, receive on Allo Android, reply from Allo desktop, update on
Mention iOS, switch off the originating device, keep working).

### Phase 5: External connectors

Nothing delivered by this change. The Matrix-bound bridge code is removed.

Remains: one pilot network; the runner model (local, user node, Oxy cloud
under a separate trust boundary); `@allo/connector-kit`; then network by
network.

### Phase 6: Legacy destruction and hardening

Delivered by this change: deletion of Matrix code, SDKs, WASM, workflows and
docs; deletion of the legacy crypto and key model; deletion of legacy
endpoints and schema.

Remains: security audit; load tests; launch.

## Acceptance tests (issue section 23)

Statuses were set on 2026-09-17 against the tree of the pull request that closes
issue #139 (the named tests are the evidence).

### E2EE

| Test | Status |
|---|---|
| Backend DB contains no plaintext for new chats | met, test exists: `integration/coreClient.realdb.test.ts` searches every `conversation_events.payload` for every message text sent |
| Blobs contain no plaintext media | met, test exists: the same suite uploads a file through the SDK and searches every blob for a window of its bytes |
| Logs and push contain no content | met by design, partly tested: the log sanitiser and the route-template-only request log are unit tested; push carries only `{ conversationId, eventId }` with a fixed body (`deliveryWorker` tests); no test reads production logs |
| A stolen Oxy token cannot decrypt history | met by design: keys never leave the instance; instance-signed requests keep a bare token from acting as an instance (`instanceAuth` tests) |
| The server cannot silently add a reader | met, test exists: `@allo/core` verifies every approval chain before claiming a key package; e2e (i) plants server-side instances with forged or absent signatures and they are never added |
| Key substitution is detectable or rejected per the final model | met for enrollment: `(account_id, signing_public_key)` is unique, approvals are signed over the published challenge, chains are verified by every client; the user-facing fingerprint comparison is built on both devices |

### Multi-device

| Test | Status |
|---|---|
| Three installations send and receive with the first switched off | met, test exists: core e2e (b, c) and the backend integration suite run three instances across two accounts with one offline |
| Messages sent from one device appear on the user's other devices | met, test exists: core e2e (b) and the integration suite (Bob desktop receives what Bob iOS sends) |
| Revoking an installation cuts future access | met, test exists: core e2e (d) and the integration suite (no delivery row, sockets cut, cannot decrypt) |
| A new installation recovers only the permitted history | open: a new instance receives future messages only; history transfer and backup are Phase 3 (`history.requestFrom` throws NotImplemented) |
| Desktop is first class without a primary phone | met by design and by test: any active instance approves, adds and revokes; the integration suite has Bob desktop approve-free after enrollment and revoke Bob iOS |

### Apps

| Test | Status |
|---|---|
| Mention reads only its authorised conversations | not in scope of this change (Phase 4) |
| Allo can show Mention conversations | not in scope of this change (Phase 4) |
| Visual grouping shares no keys | not in scope of this change (Phase 4); the rule is written in concepts.md |
| A shared thread requires explicit consent | not in scope of this change (Phase 4) |

### Reliability

| Test | Status |
|---|---|
| Timeout plus retry does not duplicate messages | met, test exists: outbox idempotency (core `outbox.test.ts`, backend idempotency replay test) |
| A crash between the DB write and the notification loses no delivery | met by design, test exists for the mechanism: deliveries are rows written in the event's transaction and claimed with leases; the socket nudge is only the fast path |
| Redis down loses no messages | met by design: Redis only fans out Socket.IO nudges; the delivery stream is Postgres. `socketRedisAdapter` degrades to single-instance mode without throwing (tested) |
| A large backfill keeps memory bounded | partly: sync pages (`MAX_SYNC_PAGE`) and pipelines per delivery; no load test was run (Phase 6 hardening) |
| Concurrent commits and revocations leave no inconsistent crypto state | met, test exists: epoch CAS with 409 and re-sync (core e2e (e), integration suite concurrent add of Carol); revocation Remove commit by the elector (core e2e (d)) |

### Clean break

| Test | Status |
|---|---|
| No Matrix imports on the final product path | met, test exists: zero references in packages/*; the frontend census `noLegacyChatPath` and the backend `noMongo` scan run in CI |
| No legacy `signalProtocol.ts` | met |
| No endpoint accepts native chat plaintext | met, test exists: `noPlaintextPaths.test.ts` (AST scan of the v1 routes and the zod contract) |
| No compatibility DTOs without a consumer | met: the old DTOs are deleted with their routes |
| No dual writes | met: there is one store and one event table |
| No migration code without a real need | met: 0004 creates, 0005 drops; no data is converted |
| No feature flag that reactivates the old architecture | met: `EXPO_PUBLIC_CHAT_BACKEND` and the MAS/bridge configuration are gone |
