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

The lead sets each status after verifying the tree. Values: `met`,
`met, test exists`, `open`, `not in scope of this change`.

### E2EE

| Test | Status |
|---|---|
| Backend DB contains no plaintext for new chats | TBD-BY-LEAD |
| Blobs contain no plaintext media | TBD-BY-LEAD |
| Logs and push contain no content | TBD-BY-LEAD |
| A stolen Oxy token cannot decrypt history | TBD-BY-LEAD |
| The server cannot silently add a reader | TBD-BY-LEAD |
| Key substitution is detectable or rejected per the final model | TBD-BY-LEAD |

### Multi-device

| Test | Status |
|---|---|
| Three installations send and receive with the first switched off | TBD-BY-LEAD |
| Messages sent from one device appear on the user's other devices | TBD-BY-LEAD |
| Revoking an installation cuts future access | TBD-BY-LEAD |
| A new installation recovers only the permitted history | TBD-BY-LEAD |
| Desktop is first class without a primary phone | TBD-BY-LEAD |

### Apps

| Test | Status |
|---|---|
| Mention reads only its authorised conversations | TBD-BY-LEAD |
| Allo can show Mention conversations | TBD-BY-LEAD |
| Visual grouping shares no keys | TBD-BY-LEAD |
| A shared thread requires explicit consent | TBD-BY-LEAD |

### Reliability

| Test | Status |
|---|---|
| Timeout plus retry does not duplicate messages | TBD-BY-LEAD |
| A crash between the DB write and the notification loses no delivery | TBD-BY-LEAD |
| Redis down loses no messages | TBD-BY-LEAD |
| A large backfill keeps memory bounded | TBD-BY-LEAD |
| Concurrent commits and revocations leave no inconsistent crypto state | TBD-BY-LEAD |

### Clean break

| Test | Status |
|---|---|
| No Matrix imports on the final product path | TBD-BY-LEAD |
| No legacy `signalProtocol.ts` | TBD-BY-LEAD |
| No endpoint accepts native chat plaintext | TBD-BY-LEAD |
| No compatibility DTOs without a consumer | TBD-BY-LEAD |
| No dual writes | TBD-BY-LEAD |
| No migration code without a real need | TBD-BY-LEAD |
| No feature flag that reactivates the old architecture | TBD-BY-LEAD |
