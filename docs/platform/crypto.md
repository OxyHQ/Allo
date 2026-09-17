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
| `media` | blob id, content key, nonce, ciphertext digest, mime, filename, plaintext size, kind, optional dimensions, duration, caption, thumbnail | a media message (section 4) |
| `conversation` | optional `name` | the group's name, stored locally; the server never learns it |
| `typing` | `on` | never stored; only ever travels over the socket |

`EventRef` names another message by the server's event id once it has one, or
by the sender's idempotency key while the message is still a local echo. The
outbox rewrites a `local` reference into an `event` reference at send time
when the target has since been accepted.

Read receipts and typing are ordinary MLS application messages, so the server
sees neither. A receipt is sent at most once every five seconds per
conversation (`messages/service.ts`); typing is encrypted with the live group
state, emitted over the socket, relayed by the server to the conversation's
other active leaves, and decrypted on arrival. The relay does not name the
sender and the engine does not surface the sending leaf, so the SDK reports
only that someone in the conversation is typing (`isTyping`), not who. The
design brief promised typing user ids; that attribution is not built.

The `delivered` value of `SendState` is declared and never produced: nothing
in the protocol is a delivery receipt, so an own message goes from `pending`
to `accepted` (the server took it) to `read` (a `read` receipt covered it).

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
expiry. The hourly collector also deletes unreferenced blobs whose uploader was
revoked.

The `media` envelope and the receiving side handle an encrypted thumbnail
(the dispatcher stores its key when one arrives), but `MediaService.upload`
never produces one. Thumbnail upload is not built; the roadmap's "encrypted
thumbnails" describes the envelope, not a sender.

## 5. Membership rules the SDK runs on its own

These run without a user action; they are what makes multi-device work.

**Adding the account's own instances.** After every sync
(`ConversationsService.reconcile`), in each conversation where this instance
is the lowest instance id among its account's leaves, it claims a key package
for every trusted, active own instance that has no leaf and no pending add,
and commits the Add. The lowest-id rule is the elector: with several devices
online, one of them commits and the others do nothing; if two race anyway the
server's epoch check makes one lose and rebuild (section 2).

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
closes it; the threat model (section 4) records it, and a self-custodied
recovery mechanism that could approve instead is Phase 3 in the roadmap.

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

One gap follows from the contract: another account's listing carries active
instances only, so from outside, an instance whose approver has since been
revoked cannot be verified and is refused. Both the conversation creator and
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
carrying that key, and continues.

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
halves), `mediaKey` and `queued`.

Ciphertext is not kept after decryption: an `event` record holds the decoded
app message (or the reason it could not be decoded), because MLS consumes the
key that would decrypt it again. History therefore lives only in this store.

## 9. What the server sees

Membership, roles, leaves and epochs; event kinds, sequence numbers,
timestamps and ciphertext sizes; per-instance delivery and ack times; blob
sizes and which events reference which blobs; presence and the timing of
typing traffic; push tokens; the DM pairing key. It holds no key to any
ciphertext, and a group name, a read receipt, a reaction and a typing frame
are all inside the ciphertext. The full list, and what is deliberately not
defended, is `threat-model.md` sections 5 and 6.

## 10. What is deliberately not built

Each of these has a place in `roadmap.md`; this list says what the tree does
instead.

- **History transfer and backup.** `client.history.requestFrom` and
  `enableBackup` throw `NotImplementedError`. A new instance decrypts from the
  epoch it was welcomed at and nothing before; losing every instance loses
  history. Phase 3.
- **Delivery receipts.** No message says "delivered"; the `delivered` send
  state is never set. A read receipt is the first acknowledgement a sender
  sees.
- **Per-account typing attribution.** The SDK reports that somebody is typing,
  not who (section 3).
- **Thumbnail upload.** The envelope and the receiver handle one; no sender
  produces one (section 4).
- **Key package pruning.** Packages carry the library's default lifetime and
  nothing on either side expires or replaces an unconsumed old package; the
  server deletes them only with the instance.
- **Presence in the SDK.** The server emits `presence`; core does not listen
  for it and exposes nothing.
- **A people resolver.** `createAlloClient` accepts `people` and never reads
  it; every view model carries account ids only.
- **An audit of `ts-mls`.** Its README says it has had none; the spike checked
  protocol behaviour, not side channels. Phase 1 remains and Phase 6 names the
  security audit.
- **OpenMLS or mls-rs on device.** No Rust toolchain was available for the
  spike; the `CryptoEngine` boundary exists so that either can replace
  `ts-mls` later. Nothing has been measured on a phone.
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

A change that adds a path which encrypts, decrypts or commits outside
`GroupRegistry` and the mutex, or which delivers a Welcome by another route,
or which lets a message skip the epoch check, has broken one of these even if
every test passes.
