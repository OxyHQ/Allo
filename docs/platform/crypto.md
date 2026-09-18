# Allo Platform cryptography, as built

This page describes the protocol the tree implements: MLS groups relayed by
the Allo backend, an instance model that binds every leaf to an enrolled
installation, and encrypted storage on the device. It is written from the
code in `packages/core/src` and `packages/backend/src`, not from the design.
Where the two differ the code is described and the difference is noted.

Related: `threat-model.md` (assets, actors, what is and is not defended),
`concepts.md` (the vocabulary), `api-v1.md` (every route and payload),
`roadmap.md` (what is not built and when), `../adr/0001-clean-break-platform.md`
(why), and `spikes/mls/RESULTS.md` (the measurements behind the choices).
None of that is repeated here.

## 1. MLS through `CryptoEngine`

The engine is `packages/core/src/crypto/engine.ts`, a wrapper around the
`ts-mls` package (RFC 9420 in TypeScript; see the roadmap for why that library
and not OpenMLS or mls-rs). Everything else in the SDK, and everything in the
backend, sees only the wrapper: bytes in, bytes out, and a `GroupState` it
treats as opaque. The library can be replaced without touching sync, the
outbox or conversations.

`ts-mls` is functional: every call returns a new state and mutates nothing.
That is what makes the invariants in section 11 cheap to own.

### Ciphersuite

One suite, `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (suite id 1,
`CIPHERSUITE_ID`). The engine refuses to be created for any other. Application
messages are padded to a multiple of 256 bytes (`DEFAULT_PAD_UNTIL_LENGTH`,
configurable at engine creation), so the server sees sizes in 256-byte steps.

### Credential

Every leaf carries a basic credential whose identity is the UTF-8 string
`accountId:instanceId` (`identityString`). `parseIdentity` is its inverse and
refuses an identity without exactly one separator. The engine's
`validateCredential` checks only that shape. Whether the leaf's signature key
belongs to an instance the server actually enrolled is not the engine's
decision: the callers hold the instance listings and run the chain check of
section 6 before they claim a key package for anybody.

### The crypto provider, and why it is the same everywhere

`ts-mls` takes a `CryptoProvider`. The SDK ships one,
`crypto/nobleCryptoProvider.ts`, built on `@noble/hashes`, `@noble/ciphers`,
`@noble/curves`, and the `@hpke` packages with their KDF and KEM re-wired onto
noble so that nothing in the path calls `crypto.subtle`. The only platform
primitive it needs is `crypto.getRandomValues`.

It is the default on every platform, not only on React Native. The design
brief said WebCrypto where available and noble only on Hermes. The spike
(`RESULTS.md` section 5) found that the WebCrypto provider stores an Ed25519
signing key as a 48-byte PKCS#8 blob and the noble one as 32 raw bytes, and a
state written under one cannot sign under the other. One provider means one
key format, one persisted-state format and one code path to audit, so the
split was dropped. A host may still pass its own provider through
`createAlloClient({ crypto })`; nothing in the SDK does.

### Key packages

An instance's key packages are generated with `generateKeyPackageWithKey`, so
every one is signed by the instance's long-lived Ed25519 key (the same key
that signs requests, section 7). The server therefore holds exactly one
public key per instance, and a leaf added from a key package is signed by the
key the server enrolled.

The stock is kept by `instance/manager.ts`: after activation, and whenever the
server sends `keypackages.low` (the server nudges below 5 unconsumed,
`KEY_PACKAGE_LOW_WATER_MARK`), the instance generates enough to bring the
server's count back to `keyPackageTarget` (default 20, at most 50 per upload,
which is the contract's batch bound). The private parts (`initPrivateKey`,
`hpkePrivateKey`, `signaturePrivateKey`) are written to the encrypted store
before the public halves are uploaded, so the server never hands out a package
whose private half could be lost.

A claim (`POST /v1/key-packages/claim`) consumes at most one package per
requested instance in one transaction, and an instance with none left is
reported in `missing` rather than failing the call. The `ref` a Welcome is
addressed to is the RFC 9420 KeyPackageRef, recomputed by
`keyPackageRefFromWire` from the uploaded bytes so the server, the uploader
and a Welcome all name the same package.

## 2. Group lifecycle

**Create.** `conversations/service.ts` claims one key package for every
trusted, active instance of every member (the creator's other instances
included), creates the group with a fresh key package of its own under a
random 16-byte group id, and builds one commit adding all of them. The commit,
its Welcome and the conversation are posted in one `POST /v1/conversations`
request; the backend appends the commit and the Welcome in the same
transaction that creates the row. If the server answers `created: false` (a DM
that already existed), the local group is discarded and this instance waits to
be added by its account's elector (section 5).

**Creation with no reachable member.** A member account may have no trusted
active instance at all: the person has not installed Allo (the server has
never seen the account and `GET /v1/accounts/:id/instances` is 404), or every
device they had is gone. That is not an error. The account is still posted in
`memberAccountIds` and the server keeps it as a `joined` member; the group
starts with whatever leaves exist, possibly only the creator's, and when there
is nothing to add the request carries no `initialCommit` at all — the group is
epoch 0 with one leaf. The view reports such accounts in
`ConversationView.unreachableMemberAccountIds`, computed from the member rows
against the live tree, and the elector rule in section 5 adds their first
device when it appears. Two consequences the app must live with: nothing sent
before that device exists can ever be read on it, because it was encrypted at
epochs its leaf never held (there is no cross-account history, section 10),
which is why the outbox holds such messages rather than sending them into the
void; and a conversation whose members are all unreachable is fully formed
and listed, not a draft.

**Add and remove.** `CryptoEngine.commit` takes any mix of Add proposals
(from claimed key package bytes) and Remove proposals (leaf indexes) and
returns the wire commit, the Welcome when anything was added, and `next`, the
state after the commit. The input state is untouched. Commits carry the
ratchet tree extension, so a joiner needs nothing beyond the Welcome.

**Pending commit.** The outbox (`outbox/engine.ts`) persists `next` and the
exact request as a `pendingCommit` record before sending, keeps the pre-commit
state live, and swaps `next` in only when the server accepts. On `409
epoch_conflict` the pending record is discarded, a sync processes the winning
commit, and the intent (which instances to add or remove) is rebuilt on the
new state, minus whatever the winner already did. A retry after a crash or a
lost answer resends the byte-identical request, so the server's idempotency
replay applies. If this instance's own commit arrives through a gap fill
before the outbox recorded the answer, the dispatcher applies the pending
state instead of trying to decrypt its own commit.

**Welcome.** A Welcome is only ever sent in the same request as its commit,
and the backend stores it as a separate `mls_welcome` event delivered only to
the added leaves. So no instance can join from a Welcome whose commit was not
accepted (`RESULTS.md` section 4: a Welcome from an unacknowledged commit
joins a phantom epoch without error).

**Join.** On an `mls_welcome` delivery the dispatcher (`sync/dispatch.ts`)
finds which of the Welcome's KeyPackageRefs it holds, fetches the conversation
summary first (so an unreachable server retries the delivery without consuming
anything), takes the private half out of the stock, and joins. The epoch it
joined at is recorded as `joinedEpoch`; nothing before it is decryptable here,
and the sync loop skips events older than it.

**Epoch gating.** `processIncoming` reads the epoch off the wire before the
library sees the message. A future epoch throws `FutureEpochError` with the
state untouched; the dispatcher persists the delivery as `queued` and replays
the queue after every commit or join. A handshake message from a past epoch is
refused as stale; an application message from a past epoch is handed to the
library, which keeps keys for a bounded number of earlier epochs (the library
default, `RESULTS.md` section 4). A state that is no longer active refuses
everything.

**Removal of self.** When a commit removes this leaf, `ProcessResult.removedSelf`
is set and the conversation record is marked `removed`; sending and decrypting
then fail by construction, and the outbox marks anything still queued for that
conversation as failed.

**One live state copy.** `conversations/groups.ts` (`GroupRegistry`) holds
exactly one `GroupState` per conversation in memory, and every change to one
goes through a `StoreBatch` that also carries the delivery's other effects
(the event record, the conversation record, the sync cursor), committed as one
write. State-changing work runs under one FIFO mutex (`util/async.ts`), so two
paths never advance the same state concurrently. The engine caches nothing.

## 3. The application message

What a client encrypts is an `AppMessage` (`packages/shared-types/src/appMessage.ts`):
versioned JSON, `v: 1`, UTF-8, validated by its zod schema before encryption
so a malformed envelope never leaves the sender, and validated again after
decryption. The server is not a party to its versioning. The kinds:

| `t` | carries | effect on the timeline |
| --- | --- | --- |
| `text` | `body` (up to 64 KiB), optional `replyTo` | a message |
| `edit` | `target`, `body` | replaces the target's text, marks it edited; only the original sender's edits are applied |
| `delete` | `target` | the target becomes `deleted`; sender-only, as above |
| `reaction` | `target`, `key`, `op: add or remove` | toggles the sender's reaction on the target |
| `read` | `upTo` | a read receipt: own messages at or below that seq show `read` |
| `delivered` | `upTo` | a delivery receipt from a receiving instance: own messages at or below that seq show `delivered` unless already `read` (section 16) |
| `media` | blob id, content key, nonce, ciphertext digest, mime, filename, plaintext size, kind, optional dimensions, duration, caption, thumbnail | a media message (section 4) |
| `conversation` | optional `name` | the group's name, stored locally; the server never learns it |
| `typing` | `on` | never stored; only ever travels over the socket |

`EventRef` names another message by the server's event id once it has one, or
by the sender's idempotency key while the message is still a local echo. The
outbox rewrites a `local` reference into an `event` reference at send time
when the target has since been accepted.

Read receipts, delivery receipts and typing are ordinary MLS application
messages, so the server sees none of them. A read receipt is sent at most
once every five seconds per conversation (`messages/service.ts`), and a
delivery receipt under the same bound (section 16); typing is encrypted with the live group
state, emitted over the socket, relayed by the server to the conversation's
other active leaves, and decrypted on arrival. The relay does not name the
sender and the engine does not surface the sending leaf, so the SDK reports
only that someone in the conversation is typing (`isTyping`), not who. The
design brief promised typing user ids; that attribution is not built.

An own message goes from `pending` to `accepted` (the server took it) to
`delivered` (another account's `delivered` receipt covered it) to `read` (a
`read` receipt did). `read` is never downgraded, and a receipt from one of
the account's own instances moves nothing.

## 4. Media

`media/service.ts`. A file is encrypted on the device with a fresh random
32-byte key and 12-byte nonce under AES-256-GCM (`@noble/ciphers`), with no
additional data; the SHA-256 of the ciphertext is computed and sent as
`X-Allo-Blob-Sha256`; the ciphertext is uploaded as `application/octet-stream`
to `POST /v1/blobs`, whose request signature covers the bytes. The server
checks the size cap and that the digest matches, stores the bytes under a blob
id of 32 random bytes in hex, and knows nothing else. The key, nonce, digest,
mime, filename and plaintext size travel only inside the `media` app message.

Download fetches the blob by id, verifies the digest against the one from the
message before decrypting, then decrypts. Keys are persisted (encrypted at
rest, section 8) as `mediaKey` records so a `MediaRef` is enough to fetch later.

Any authenticated instance can read any blob by id: ids are unguessable and
content is ciphertext (`api-v1.md`, Blobs). A blob nobody references expires
seven days after upload; an event that names it in `blobIds` clears the
expiry, and so does a pending history offer or the account backup that names
it as an archive chunk (section 13). The hourly collector also deletes
unreferenced blobs whose uploader was revoked.

### Thumbnails

`UploadMediaMeta.thumbnail` is `{ bytes, mime, width, height }`: a preview
the app has already rendered. `MediaService.upload` encrypts it exactly as it
does the file, under its own fresh 32-byte key and 12-byte nonce, uploads it
as a second blob with its own digest, and names it inside the same `media`
message under `thumbnail` (blob id, key, nonce, digest, width, height). The
sender persists both `mediaKey` records and the outbox item declares both
blob ids, so neither expires. The receiving dispatcher stores the thumbnail
key beside the file key, and `MediaView.thumbnail` carries a `MediaRef` a
screen can pass to `download` without touching the original. The archive
(section 13) carries both keys. The server sees two blobs and nothing that
relates them.

## 5. Membership rules the SDK runs on its own

These run without a user action; they are what makes multi-device work.

**Adding the account's own instances.** After every sync
(`ConversationsService.reconcile`), in each conversation where this instance
is the lowest instance id among its account's leaves, it claims a key package
for every trusted, active own instance that has no leaf and no pending add,
and commits the Add. The lowest-id rule is the elector: with several devices
online, one of them commits and the others do nothing; if two race anyway the
server's epoch check makes one lose and rebuild (section 2).

**Adding a member's first device.** A joined member with no leaf at all — no
device when the conversation was created, or none left — is the second
elector's job. After every sync, in each conversation where this instance is
the lowest instance id among ALL leaves (not just its own account's), it looks
each such account up (`GET /v1/accounts/:id/instances`), claims key packages
for the trusted active instances found, and commits the Add. The lookup is
throttled to once a minute per account per conversation, because a person
who has not installed Allo stays that way for a long time and a thousand held
conversations must not poll on every sync. Two things shorten the wait. When
the lookup lists an instance but the claim returns nothing — the device
registered moments ago and its key packages are not up yet — the elector
retries once after five seconds, then falls back to the minute. And when one
of the account's instances becomes active (bootstrap registration or an
approval), the server sends `sync.nudge` with the `conversationId` to every
active leaf of every conversation where that account is a joined member with
no leaf; the nudged conversation's next reconcile skips the throttle. So in
the ordinary case the device is added within a sync of installing the app,
with no polling at all. Once the account holds one leaf, its own elector
(the first rule above) adds its further devices, and this rule has nothing to
do.

**The outbox hold.** While a conversation has other joined members and none of
them has a leaf, an application message would be encrypted for nobody who
will ever read it. The outbox (`outbox/engine.ts`) therefore leaves such items
`pending` and untouched — no attempt is burnt, nothing is posted — and the
view marks them `holdReason: "no_reachable_member"` (derived at read time,
never stored, so it cannot go stale). The Add commit above releases them: the
next drain finds a reachable leaf and sends them in order at the new epoch.
Commits are never held, and a conversation everybody else has LEFT is not
held either; sending there is pointless but allowed, as before.

**Reacting to `instance_revoked`.** The server appends this control event when
an instance is revoked (section 6). The elector among the revoked account's
remaining leaves, or among all remaining leaves when that account has none
left, commits a Remove of the revoked leaf. Until that commit lands the
revoked instance holds the current epoch's secrets, which is the window the
threat model names.

**Reacting to `member_left`.** A server-side leave produces this control
event; the elector among the remaining leaves removes every leaf of the
account that left. The leaving client itself only calls the leave route and
marks the conversation `removed` locally.

**Membership follows the tree.** After any commit, every account with a leaf
is `joined` in the local conversation record; the server's member rows are
reconciled separately from `GET /v1/conversations`.

## 6. The instance model

Every installation is an instance with its own Ed25519 key, generated on first
run by `instance/manager.ts` and kept in the host's `SecretStore` under
`allo.instance-key.<accountId>.<appId>`. The private key never leaves the
device; the public key is what `POST /v1/instances` registers.

**Bootstrap, and its weakness.** An account with zero active instances gets
an `active` instance at once (`instanceService.registerInstance`). That is
trust on first use: whoever holds a valid Oxy token at a moment when no active
instance exists becomes the root of the account's approval chain, and the
window includes a user who revoked or lost every device. Nothing in the tree
closes it; the threat model (section 4) records it. The recovery phrase of
section 15 unlocks history and approves nothing: a mechanism that could
approve an instance instead of trusting the first one remains in the roadmap.

**Enrollment challenge.** Any later registration is `pending` and receives a
challenge of 32 random bytes in base64url. The pending instance polls its own
status every five seconds and also listens for `instance.approved` on its
socket room.

**Approval.** An active instance of the same account fetches the pending list,
shows the operator the challenge's fingerprint (`challengeFingerprint`: the
first 16 hex characters of the challenge's SHA-256, grouped in fours), and on
a yes signs, with its own key, the UTF-8 bytes of

```
"allo-enroll-v1\n" + accountId + "\n" + newInstanceId + "\n" + newSigningPublicKey + "\n" + challenge
```

(`enrollmentApprovalMessage` in `@allo/shared-types`, one definition used by
both sides). `approve` refuses to sign if the challenge the UI showed is not
the one on record. The server verifies the signature against the approver's
stored key, stores the approver id and the signature on the new instance,
marks it `active`, and from then on publishes the challenge with the
instance: the challenge is secret only until it has been signed, and a
verifier needs it. The first line of the message differs from the request
signing context, so neither signature can be replayed as the other.

**Chain verification, by any client.** `crypto/signing.ts`
(`verifyInstanceChain`) decides which of an account's instances may be given
a leaf, from the listing alone and never from the server's word:

- only `active` instances are candidates;
- the root is the first active instance (by `createdAt` when the listing
  carries it) with no approver; a second unapproved active instance is refused
  as either a server fault or an injected key;
- every other instance must name an approver of the same account, not itself,
  and carry a signature that verifies over the approval message with the
  published challenge under the approver's key; the approver must itself be
  verified, recursively to the root;
- a revoked approver invalidates nothing it approved while its key is in the
  listing: trust flows from the approval event, not from the approver's
  current status.

For this to hold from another account's point of view, the public listing
(`GET /v1/accounts/:accountId/instances`) carries active AND revoked
instances, never pending ones: a revoked approver stays visible with its key
and its status, so what it approved still chains, and an approver missing from
the listing makes the whole chain refuse. Both the conversation creator and
the elector run this check before claiming key packages; a refused instance is
logged and never added. The e2e suite plants instances with forged and absent
signatures and checks they are skipped, and accepts a valid chain of depth
three.

**Revocation.** Any active instance of the account, or the instance itself,
can revoke. The server marks it `revoked`, marks each of its live leaves
`removed` with no epoch (no commit has removed it from the group yet), appends
`{ t: "instance_revoked", instanceId, accountId }` to every such conversation
for every other active leaf, emits `instance.revoked` on the account room, and
disconnects the instance's sockets; its next signed request is refused with
`instance_revoked`. On the SDK side a revoked instance stops its socket, sync
and outbox and leaves the state for the UI to show; `client.reset()` revokes
itself before wiping. The Remove commit is section 5.

**Registration recovery.** If the store was wiped but the secret store kept
the key, registering again fails with `idempotency_conflict` (the key is
unique per account); the manager then lists its own instances, adopts the one
carrying that key, and continues. If the adopted record's `transferPublicKey`
is not the one this device holds, the manager republishes its own (section 12).

## 7. Request signing and the socket handshake

Every route that touches a conversation, a key package, sync or a blob is
instance-signed. The SDK's HTTP client (`transport/http.ts`) hashes the exact
bytes it hands to `fetch` (the serialised JSON, or the blob) and signs, with
the instance key, the UTF-8 bytes of

```
"allo-v1\n" + METHOD + "\n" + pathWithQuery + "\n" + timestampMs + "\n" + bodySha256Hex
```

sending `X-Allo-Instance`, `X-Allo-Timestamp` and `X-Allo-Signature`. The
backend (`middleware/instanceAuth.ts`) captures the raw body ahead of JSON
parsing, rebuilds the same string from the method, `req.originalUrl`, the
header timestamp and the body digest, and checks, in this order: headers well
formed and the timestamp within five minutes of its clock; the instance
exists, belongs to the token's account, and is neither `pending` nor
`revoked`; and last, because it is the expensive step, the Ed25519 signature
against the stored raw public key (wrapped in the SPKI prefix for
`node:crypto`). A stolen Oxy token without the instance's key can call only
the three Oxy-only routes.

The Socket.IO handshake on namespace `/v1` runs the same function with the
path fixed to `/socket` and the empty-body digest, after `oxy.authSocket()`.
The SDK recomputes the handshake on every reconnect because the signature
carries a timestamp. A connected socket joins `instance:<id>` and
`account:<accountId>`, rooms derived from the verified instance and never from
client input.

## 8. Storage at rest

Everything the SDK persists goes through `storage/store.ts`, which encrypts
each value with `crypto/atRest.ts` before it reaches the host's
`StorageAdapter`: AES-256-GCM with a random 32-byte storage key held in the
`SecretStore` under `allo.storage-key.<accountId>.<appId>`, a fresh 12-byte
nonce per write, a leading version byte, and the record's own storage key path
as additional data so a row cannot be moved under another key. The adapter
never sees plaintext; the in-memory `MemoryStorage` used by tests exposes its
raw bytes precisely so a test can assert what never reaches disk.

Keys are `allo/<appId>/<accountId>/<instanceId>/<kind>/<id>`, with one key
outside the instance segment, `allo/<appId>/<accountId>/self`, holding the
instance record. Two accounts on one device never see each other's rows, and
`reset()` wipes an account by prefix. The record kinds are `conversation`,
`groupState` (the raw `ts-mls` encoding of the state, private keys included),
`pendingCommit`, `event`, `outbox`, `cursor`, `keyPackage` (the private
halves), `mediaKey`, `queued`, `historyOffered` (which own instances this
one has offered history to, section 14) and `backupState` (whether backup is
on, when it last ran and how many events it covered, section 15).

The secret store holds up to four values per account and app: the instance
signing key, the storage key, the transfer key (section 12) and, once backup
is enabled or restored, the backup key (section 15). `reset()` deletes all
four.

Ciphertext is not kept after decryption: an `event` record holds the decoded
app message (or the reason it could not be decoded), because MLS consumes the
key that would decrypt it again. History therefore lives only in this store,
and it is this store that the archive of section 13 is exported from and
imported into.

## 9. What the server sees

Membership, roles, leaves and epochs; event kinds, sequence numbers,
timestamps and ciphertext sizes; per-instance delivery and ack times; blob
sizes and which events reference which blobs; presence and the timing of
typing traffic; push tokens; the DM pairing key. Of history offers and
backups it sees the manifest in the clear (kind, conversation and event
counts, chunk blob ids, the plaintext digest, creation time), the chunk
sizes, which instance offered to which and when it was consumed, when the
account's backup was last written and by which instance, and the sealed key
and `keyCheck`, which are opaque without the key (sections 14 and 15). It
holds no key to any ciphertext, and a group name, a read receipt, a delivery
receipt, a reaction and a typing frame are all inside the ciphertext. The
full list, and what is deliberately not defended, is `threat-model.md`
sections 5 and 6.

## 10. What is deliberately not built

Each of these has a place in `roadmap.md`; this list says what the tree does
instead.

- **Recovery-material approval of a new device.** The recovery phrase
  (section 15) unlocks the backup and nothing else: it cannot approve an
  instance, so the trust-on-first-use window of section 6 is unchanged, and a
  second device still waits for an active one to approve it.
- **Restore from a pending-approval instance.** `backup.restore` and
  `history.accept` both require an active instance. A new device on an
  account that still has an active instance is approved first and restores
  after; only the bootstrap instance (no active instance left) can restore at
  once.
- **A second automatic offer.** The elector offers each newly added own
  instance history once, ever (`historyOffered`). An offer that expired
  unconsumed after its seven days, or that the recipient refused, is not
  repeated on its own; `client.history.offerTo` from any active instance
  makes a new one.
- **Push previews.** The notification body is still "New message"; nothing
  decrypts on the push path.
- **Per-account typing attribution.** The SDK reports that somebody is typing,
  not who (section 3).
- **Key package pruning.** Packages carry the library's default lifetime and
  nothing on either side expires or replaces an unconsumed old package; the
  server deletes them only with the instance.
- **Presence in the SDK.** The server emits `presence`; core does not listen
  for it and exposes nothing.
- **A people resolver.** `createAlloClient` accepts `people` and never reads
  it; every view model carries account ids only.
- **An audit of `ts-mls`.** Its README says it has had none; the spike checked
  protocol behaviour, not side channels. Phase 1 remains and Phase 6 names the
  security audit. The HPKE suite the transfer key uses (section 12) is the
  same unaudited stack.
- **OpenMLS or mls-rs on device.** No Rust toolchain was available for the
  spike; the `CryptoEngine` boundary exists so that either can replace
  `ts-mls` later. Nothing has been measured on a phone, the archive export and
  import included.
- **Fingerprint comparison between accounts**, CSP and Trusted Types on web,
  resumable uploads, quotas, an S3 blob store: see the threat model and the
  roadmap.

## 11. How to reason about a change here

`ts-mls` enforces the protocol. It does not enforce the following, and a
change to sync, the outbox, the dispatcher or the conversations service is
correct only if each still holds. The engine's header comment lists them and
the spike's section 3 is where they were found.

1. **Epoch gating.** A message may reach the library only when the state is at
   its epoch. A future-epoch message is queued, persisted, and replayed after
   the next commit or join; it is never dropped and never handed to the
   library early, because the library's failure for a wrong epoch is an AEAD
   error indistinguishable from corruption. Commits are processed in exact
   epoch order.

2. **Pending commit, and Welcome only after acknowledgement.** The state after
   a commit is kept aside, persisted with the exact request, and becomes the
   live state only when the server accepted the commit; on rejection it is
   discarded and the intent rebuilt. A Welcome leaves the device only in the
   same request as its commit, so nobody joins an epoch the group never
   reached. A key package spent in a lost commit was never applied to the tree
   and may be reused.

3. **One live copy of every state.** Exactly one `GroupState` per conversation
   is in memory, every advance of it (encrypting, decrypting, committing,
   joining) is staged into the same batch as its consequences and committed as
   one write, and all of it runs under the mutex. Two copies of one state that
   both send would reuse a sender ratchet generation; two that both receive
   would each consume keys the other still needs.

4. **History never carries group state.** The archive (section 13) holds
   decrypted application messages, conversation metadata and media keys, and
   nothing from `groupState`, `keyPackage` or `pendingCommit`. Importing one
   writes `event` records at epoch 0 and touches no group; a new leaf still
   joins from its Welcome. A donor's live secrets leaving the device inside an
   archive would make two instances share one leaf.

A change that adds a path which encrypts, decrypts or commits outside
`GroupRegistry` and the mutex, or which delivers a Welcome by another route,
or which lets a message skip the epoch check, or which puts MLS state into an
archive, has broken one of these even if every test passes.

## 12. The transfer key

Every instance has a second long-lived key beside its signing key: an X25519
keypair (`crypto/transfer.ts`), generated on first run by
`instance/manager.ts` and kept as 32 raw bytes in the `SecretStore` under
`allo.transfer-key.<accountId>.<appId>`, the write verified by reading it
back. Its only use is to receive an archive key: a donor seals to it and
nothing else is ever encrypted to it.

The public half is `transferPublicKey`, required by `POST /v1/instances` and
published on both `ClientInstance` and `PublicInstance`. An instance
registered before the field existed has `null` on the server; on start, an
active instance whose server record does not carry its own key calls
`PUT /v1/instances/me/transfer-key` once (`ensureTransferKey`), and the same
happens after registration recovery adopts a record minted under another
key. Until then an offer to it is refused: by the donor's SDK with
`InvalidStateError` before anything is exported, and by the server with
`409 transfer_key_missing`.

Sealing is HPKE in base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and
AES-128-GCM, through the same noble-backed `@hpke/core` suite MLS runs on
(`createNobleHpkeSuite`), so no second primitive enters the tree. `sealTo`
returns `enc || ct`: the 32-byte KEM encapsulation followed by the AEAD
ciphertext (plaintext plus a 16-byte tag), with the caller's `info` as the
domain separator, `"allo-history-key-v1"` for a history offer. `openWith` is
its inverse and throws `DecryptError` on anything the key does not open; a
sealed value shorter than 48 bytes is refused before the suite sees it.

## 13. The encrypted archive

The archive (`@allo/shared-types` `archive.ts`, `history/archive.ts`) is
what one instance knows, packed for another instance of the same account or
for a later installation. It is plaintext that exists only on a device.

**Contents.** `Archive` v1 carries the account and app ids, a creation time,
and three lists: `conversations` (id, kind, app, the E2EE title or `null`,
the joined members' account ids, creation time), `events` (every stored
`app_message` with its decoded `AppMessage`, keyed by server event id with
its seq, sender account and instance, and time; `typing` is never stored and
so never exported) and `mediaKeys` (blob id, key, nonce, ciphertext digest,
and the same for a thumbnail when there is one). Nothing about MLS is in it:
no group state, no epoch secret, no key package (section 11, invariant 4).

**Encoding and chunking.** `encodeArchive` validates with the zod schema and
emits UTF-8 JSON; `plaintextSha256` is the digest of those bytes. The bytes
are split into pieces of at most 4 MiB (`ARCHIVE_CHUNK_MAX_BYTES`), at most
512 of them (`ARCHIVE_MAX_CHUNKS`, so 2 GiB of history); an empty archive is
still one chunk. Each piece is AES-256-GCM under the 32-byte archive key with
a fresh random 12-byte nonce prefixed to the ciphertext and the additional
data `"allo-archive-v1:" + index + "/" + total`, so a chunk cannot be
dropped, duplicated or reordered without the decryption failing. Each chunk
is uploaded as one ordinary blob (`POST /v1/blobs`, digest header, request
signature over the bytes) and is subject to every blob rule of section 4.

**The manifest.** `ArchiveManifest` is `{ v, kind: transfer | backup,
createdAt, conversationCount, eventCount, chunkBlobIds (in order),
plaintextSha256 }`. The producing instance signs, with its Ed25519 key, the
UTF-8 bytes of `"allo-archive-manifest-v1\n"` followed by the manifest as
canonical JSON (keys sorted recursively, no whitespace, `undefined` members
omitted; `canonicalJson`). The kind is inside the signed bytes and each route
refuses the other kind, so a backup manifest cannot be replayed as an offer
or an offer's as a backup. The server verifies the signature against the
producer's stored key when the manifest is written; every consumer verifies
it again against the producer's published key, because the server's word is
what the chain of section 6 exists to make unnecessary.

**Decryption and import.** `decryptArchive` needs all the chunks, in order;
each authenticates under its own index and the total. The plaintext digest is
then compared with the signed manifest, and only then is it decoded
(`ArchiveDecodeError` otherwise). `importArchive` refuses an archive for
another account or app and merges: a conversation already present keeps its
record (a missing title is filled in), events are keyed by server event id so
duplicates are skipped and local echoes are untouched, media keys are added.
A conversation this instance has no record of is fetched from the server for
its membership and group id when it can be and built from the archive when it
cannot; the Welcome, when it comes, fills in the rest. The account's own
`read` receipts in the archive set the conversation's read position, so what
was read stays read. Imported events carry epoch 0 and no group state.
Everything lands in one store batch under the mutex.

## 14. History transfer

`history/service.ts`. A donor instance hands another instance of the SAME
account its archive; the server relays a manifest, a sealed key and a
signature and can open none of them. Live group state is never part of it: a
new instance is a new leaf, and this is how its timeline catches up.

**Donor side, `offerTo(instanceId)`.** The donor must be active and may not
offer to itself. The recipient must be listed as an instance of this account
(the listing is refreshed if it is not cached), be `active`, pass the
approval chain of section 6 (`trustedOwnInstances`), and carry a transfer
key; a recipient that fails any of these is refused with
`UntrustedInstanceError` or `InvalidStateError` before anything is exported.
Then, under the jobs mutex that serialises every archive job: export, encode,
generate a fresh random archive key, encrypt and upload the chunks
(`progress` reports `exporting` then `uploading`), build a `transfer`
manifest, seal the archive key to the recipient's transfer key with HPKE
(section 12), sign the manifest, and `POST /v1/instances/:id/history-offers`.

**What the server checks** (`services/platform/historyService.ts`): the
donor is active; the recipient exists and belongs to the donor's account
(otherwise `not_found`, the same answer for a stranger's id as for none, so
an offer cannot probe another account's ids); the recipient is not the donor,
is active and has a transfer key; every chunk blob exists, was uploaded by
the donor's account and appears once; the manifest signature verifies
against the donor's stored key. Then in one transaction: the offer is
inserted, any older pending offer from this donor to this recipient is marked
`expired` and its chunks released, and the new chunks are retained
(`expires_at = null`). After commit `history.offer { offerId }` goes to the
recipient's socket room. An offer lives seven days unconsumed.

**Automatic offer.** The elector of section 5, right after it has added a
newly approved own instance to a group, calls `autoOffer` for it without
holding the sync loop. Each own instance gets one offer ever, recorded as a
`historyOffered` record once the offer is posted; a failed attempt is
retried on a later reconcile after five minutes. There is no re-offer after
an offer expires or is refused (section 10).

**Recipient side, automatic.** On a `history.offer` nudge and after each sync
the recipient re-lists its pending offers (when the list is stale or older
than the sync interval) and accepts, on its own, an offer whose donor passes
`donorVerdict`: the offer names this account and this instance, is not from
this instance, carries a `transfer` manifest, and its donor is listed as an
instance of this account, is `active`, passes the approval chain, and its
published key verifies the manifest signature. The listing is refreshed once
when the donor is unknown, in case it is newer than the cache. Anything else
is logged with the reason, left alone and not retried automatically; the
nudge itself proves nothing. `HistoryOfferView.trusted` is the same verdict
for a screen.

**`accept(offerId)`.** The same verdict is enforced (`UntrustedInstanceError`
otherwise) and the sealed key is opened with this instance's transfer secret
(`DecryptError` otherwise, and the result must be 32 bytes) before a single
byte of the archive is fetched. Then, under the jobs mutex: download the
chunks (`downloading`), decrypt them, compare the plaintext digest with the
signed manifest, decode, import (`importing`, counting events), and finally
`POST .../consume`, best effort. `progress()` on topic `history` is
`{ phase, done, total, fromInstanceId?, toInstanceId? }`; `done` and `total`
count chunks while uploading or downloading and events while importing.

**After consume.** The server moves the offer `pending` to `consumed`, dates
its chunks a day out (the recipient's window to finish a download it started
before it called consume) unless another pending offer, the backup or an
event still names them, and answers `idempotency_conflict` to a second
consume or to one past the deadline. Only the recipient may consume. Listing
marks past-due offers `expired` and releases their chunks first, so what is
returned is what can still be consumed. The minute sweep (`db/expiry.ts`)
releases due offers before it deletes their rows, and the hourly collector's
orphan pass dates any undated chunk blob older than the offer lifetime that
nothing names, so a chunk cannot outlive every reference to it by more than
a day plus the sweep's cadence.

## 15. Backup and recovery

`backup/service.ts`, `crypto/backupKey.ts`. One encrypted archive per
account on the server, under a key derived from a recovery phrase the user
holds and the server never sees.

**The key.** `enable()` generates a 12-word English BIP39 phrase (128 bits of
entropy, `@scure/bip39`) and derives the backup key as
`HKDF-SHA256(ikm = entropy, salt = "allo-backup-v1", info = accountId)`, 32
bytes; the `info` binds the key to one account, so the same phrase on another
account derives another key. The phrase is normalised (trimmed, lower-cased,
whitespace collapsed) before it is validated or used, and a malformed one is
`RecoveryPhraseError`. The derived key is kept in the `SecretStore` under
`allo.backup-key.<accountId>.<appId>`; the phrase is returned to the caller
once and is never persisted or logged by the SDK. The backup key IS the
archive key: the chunks are encrypted under it exactly as in section 13.

**`enable()`** refuses when backup is already on (disable first to get a new
phrase), stores the key, runs the first `refresh()`, and returns the phrase.
If that first upload fails the key is deleted and the state rolled back, so
no phrase is handed out for a backup that does not exist.

**`refresh()`** exports, encodes, encrypts under the backup key, uploads the
chunks, builds a `backup` manifest and calls `PUT /v1/accounts/me/backup`
with the manifest, `keyCheck` and the manifest signature. `keyCheck` is the
base64 HMAC-SHA256 of the UTF-8 string `"allo-backup-key-check-v1"` under the
backup key. The server checks that the writer is active, that the chunks are
its account's, and that the signature verifies against the writing instance;
it stores one row per account, replaced whole, retains the new chunks and
dates the previous ones a day out. It stores and returns `keyCheck` as given
and learns nothing from it. The refresh runs on its own after a sync when
backup is on and either no backup has been written yet, at least 20 events
have landed since the last one, or the last one is more than 24 hours old
(`backupDue`), debounced ten seconds and skipped while a job is running.

**`disable()`** deletes the server copy (a 404 is not an error), forgets the
key and resets the state.

**`restore(phrase)`**, in this order, on an active instance only: derive the
key; `GET /v1/accounts/me/backup` (`NotFoundError` when the account has
none); compare, in constant time, the HMAC this key produces with the stored
`keyCheck`, and refuse with `RecoveryPhraseError` before any chunk is
downloaded when they differ; check the backup names this account and carries
a `backup` manifest; look the writing instance up in this account's listing
(refreshing it if needed) and verify the manifest signature under its
published key, refusing with `UntrustedInstanceError` when it is not an
instance of this account or the signature does not verify; then download,
decrypt, compare the digest, decode and import. On success the key is stored
and the state set to enabled with the backup's time, so refreshes continue
from this instance. The `busy` flag of `BackupStatus` is set across the job;
`status().remote` says whether the server has a backup and is `null` until
`refreshStatus()` has asked.

**What is lost with everything.** If every device and the phrase are lost,
history is gone: the server holds chunks encrypted under a key it never had,
and there is no reset that produces plaintext. The phrase alone is not enough
either. Restore needs an active instance of the account, which means an Oxy
session plus either the approval of an instance that still exists or the
trust-on-first-use bootstrap of section 6 when none does.

## 16. Delivery receipts

`{ v: 1, t: "delivered", upTo }` is an application message like `read`,
encrypted to the group, so the server sees one more ciphertext event and
nothing about what it acknowledges.

**Sending.** When the dispatcher imports a `text` or `media` message from
another account, it asks `messages/service.ts` (`noteDelivered`) for a
receipt naming the newest other-account `text` or `media` event in that
conversation. At most one is sent every five seconds per conversation: a
burst of deliveries becomes one trailing receipt. Messages from the account's
own instances get none, and a pending or revoked instance sends none. The
receipt goes through the outbox like any message.

**Applying.** The timeline projection (`messages/projection.ts`) takes the
highest `upTo` seq any OTHER account has declared delivered and, for every
own item the server has accepted, marks it `delivered` when its seq is at or
below that, unless a `read` receipt already covers it: `read` wins and is
never downgraded. A receipt from one of the account's own instances moves
nothing. In a DM the other party's instance is the sender; in a group any
other account's is, so `delivered` means at least one other account's device
has the message, not all of them.
