# Allo API v1

The wire contract between `@allo/backend` and `@allo/core`. Every shape named
here is a zod schema in `packages/shared-types/src/`, exported from
`@allo/shared-types` together with its inferred type (`fooSchema` ↔ `Foo`).
The backend validates request bodies and query strings with them; the SDK
types its calls with them and parses every answer through them. This page is
the human index of that package; the schema is the source of truth where the
two disagree.

Everything is JSON except blob bodies. Bytes travel as standard, padded
base64 in JSON and as unpadded base64url in URLs and headers. Timestamps are
ISO-8601 strings. Ids are opaque text (`idSchema`): a uuid v7, a 24-hex
ObjectId or a 64-hex blob id all pass, and nothing may assume one of them.

## Errors

Every non-2xx answer is `ErrorResponse`:

```json
{ "error": { "code": "epoch_conflict", "message": "…", "details": { "currentEpoch": 7 } } }
```

`code` is one of `AlloErrorCode` (`ALLO_ERROR_CODES` in `common.ts`):

| code | HTTP | when |
| --- | --- | --- |
| `unauthorized` | 401 | no or invalid Oxy session; instance signature missing, stale or wrong |
| `forbidden` | 403 | authenticated, but not allowed: not a member, not the owner, another account's instance |
| `not_found` | 404 | the conversation, instance, event or blob does not exist for this caller |
| `validation_failed` | 400 | the body or query did not satisfy its schema; `details` carries the zod issues |
| `epoch_conflict` | 409 | an event at a stale epoch, or a `PUT group-info` for an epoch that is not the current one; `details: EpochConflictDetails` `{ currentEpoch }` |
| `group_info_missing` | 409 | an `external` or `resync` commit, but the server holds no `GroupInfo` for the conversation's current epoch (its last commit predates the field); wait for an elector |
| `instance_not_active` | 403 | the signing instance is still `pending` |
| `instance_revoked` | 403 | the signing instance is `revoked` |
| `key_packages_exhausted` | 409 | a claim found nothing for a required instance |
| `idempotency_conflict` | 409 | the idempotency key was used before with a different body |
| `payload_too_large` | 413 | event payload, blob or body over its bound |
| `transfer_key_missing` | 409 | a history offer names a recipient that has no `transferPublicKey` yet |
| `backup_not_found` | 404 | `DELETE /v1/accounts/me/backup` when the account has no backup |
| `rate_limited` | 429 | slow down |
| `unavailable` | 503 | a dependency is down; retry, do not sign out |
| `internal` | 500 | a bug |

A client parses `code` as a string and treats one it does not know as
`internal`, so a newer server can add a code without breaking an older client.

## Authentication

Two kinds, and every route says which.

**oxy** — `Authorization: Bearer <Oxy access token>`. The Oxy session names
the account. That is all these routes need, because they are the ones that
create or list the instances themselves.

**instance-signed** — the Oxy bearer as above AND three headers proving the
request comes from one specific enrolled installation of that account:

| header | value |
| --- | --- |
| `X-Allo-Instance` | the instance id |
| `X-Allo-Timestamp` | unix time in milliseconds, decimal |
| `X-Allo-Signature` | base64 Ed25519 signature (88 chars) by the instance's signing key |

Constants: `INSTANCE_HEADER`, `TIMESTAMP_HEADER`, `SIGNATURE_HEADER`,
`REQUEST_SIGNING_CONTEXT`, `MAX_CLOCK_SKEW_MS`, `SOCKET_SIGNING_PATH`,
`EMPTY_BODY_SHA256_HEX` in `requestSigning.ts` / `common.ts`.

### Request signing algorithm

The signed message is produced by `signedRequestMessage()` on both sides and
is, byte for byte:

```
"allo-v1\n" + METHOD.toUpperCase() + "\n" + pathWithQuery + "\n" + String(timestampMs) + "\n" + bodySha256Hex
```

- `METHOD` is the HTTP method, upper-cased.
- `pathWithQuery` is the request target exactly as sent: the path, plus `?`
  and the query string when there is one, starting with `/` and with no
  scheme or host (`/v1/sync?cursor=MA&limit=50`).
- `timestampMs` is the same integer sent in `X-Allo-Timestamp`.
- `bodySha256Hex` is the lowercase hex SHA-256 of the RAW body bytes as
  transmitted — the serialised JSON, or the blob bytes — or of the empty
  string (`e3b0c442…b855`, `EMPTY_BODY_SHA256_HEX`) when the request has no
  body.

The signature is Ed25519 over the UTF-8 bytes of that string, base64 in the
header. The server:

1. rejects a timestamp more than `MAX_CLOCK_SKEW_MS` (5 minutes) from its own
   clock (`unauthorized`);
2. loads the instance; rejects an unknown one (`unauthorized`), a `pending`
   one (`instance_not_active`), a `revoked` one (`instance_revoked`), and one
   whose `accountId` is not the Oxy session's (`forbidden`);
3. recomputes the message from the method, target, header timestamp and the
   SHA-256 of the raw body it received, and verifies the signature against the
   stored public key (`unauthorized` on mismatch).

Because the digest covers the raw body, the backend captures it before JSON
parsing (`express.json({ verify })`), and the SDK hashes the exact bytes it
hands to `fetch`.

### Socket.IO

Namespace `SOCKET_NAMESPACE` = `/v1`. The handshake carries the Oxy bearer
and `handshake.auth` = `SocketAuth` `{ instanceId, timestamp, signature }`,
where `signature` is over
`signedRequestMessage({ method: "GET", pathWithQuery: "/socket", timestampMs: timestamp, bodySha256Hex: EMPTY_BODY_SHA256_HEX })`.
A connected socket joins the rooms `instance:<id>` and `account:<accountId>`.

## Routes

### Instances (`instances.ts`)

| method | path | auth | request | response | errors |
| --- | --- | --- | --- | --- | --- |
| POST | `/v1/instances` | oxy | `RegisterInstanceRequest` | `RegisterInstanceResponse` | `validation_failed` |
| GET | `/v1/instances` | oxy | — | `ListInstancesResponse` | — |
| GET | `/v1/accounts/:accountId/instances` | oxy | — | `ListAccountInstancesResponse` (`PublicInstance[]`, active and revoked, never pending: a chain whose approver was revoked later must still verify; an account with no instance answers `[]`, never 404) | — |
| DELETE | `/v1/instances/:id` | oxy | — | `InstanceResponse` | `not_found` |
| GET | `/v1/instances/pending` | instance-signed | — | `ListPendingEnrollmentsResponse` | — |
| POST | `/v1/instances/:id/approve` | instance-signed | `ApproveInstanceRequest` | `InstanceResponse` | `not_found`, `forbidden`, `unauthorized` (bad approval signature), `validation_failed` |
| POST | `/v1/instances/:id/reject` | instance-signed | — | `InstanceResponse` | `not_found`, `forbidden` |
| POST | `/v1/instances/:id/revoke` | instance-signed | — | `InstanceResponse` | `not_found`, `forbidden` |
| PUT | `/v1/instances/me/push` | instance-signed | `SetPushTokenRequest` | `204` | `validation_failed` |
| DELETE | `/v1/instances/me/push` | instance-signed | — | `204` | — |
| PUT | `/v1/instances/me/transfer-key` | instance-signed | `SetTransferKeyRequest` `{ transferPublicKey }` | `InstanceResponse` | `validation_failed` |

`DELETE /v1/instances/:id` is the ONE instance route the Oxy session alone can
call, and it is there for the state the signed one cannot reach: an account
whose last active instance is gone — cleared site data, a lost phone, a key
that did not survive — has no signing key left, so a newly enrolled device
waits on an approval nothing can give. Every major messenger has the same door
(an account credential re-registers a device and signs the others out); the
trade is written down in `threat-model.md`. Another account's instance answers
`not_found`, the same as one that does not exist. `client.reclaimAccount()` is
the SDK's whole move: revoke each active instance, wipe, register again — into
an account with no active instance, so the bootstrap rule makes it active.

Registration is the bootstrap rule: an account with zero active instances
gets `enrollment: "active"` at once; otherwise the answer is `"pending"` with
a `challenge` (32 random bytes, base64url) and the instance waits for an
approval. `RegisterInstanceResponse` refuses a pending answer without a
challenge and an active one with one.

`RegisterInstanceRequest` is `{ appId, platform, displayName, signingPublicKey, transferPublicKey }`.
`transferPublicKey` is the instance's raw 32-byte X25519 public key, base64
(`x25519PublicKeySchema`, 44 chars), the key a donor seals an archive key to
when it offers this instance its history (see "History" below). It is
REQUIRED at registration.

`ClientInstance` (own account's view) carries `enrolledAt`, `revokedAt`,
`lastSeenAt`, `approvedByInstanceId`, `approvalSignature`, `enrollmentChallenge` (published once approved, `null` before and for the bootstrap instance) and `transferPublicKey` as
always-present, nullable fields, mirroring the columns behind them.
`transferPublicKey` is `null` only on an instance registered before the field
existed; such an instance sets it with `PUT /v1/instances/me/transfer-key`
(`SetTransferKeyRequest`, answered with the instance after), and until it does
an offer to it is refused with `transfer_key_missing`.
`PublicInstance` (another account's view) is the subset needed to verify an
enrollment chain and address an MLS leaf: id, accountId, appId, platform,
signingPublicKey, transferPublicKey, approvedByInstanceId, approvalSignature, enrollmentChallenge, status.

`revoke` may be called by any active instance of the account, or by the
instance on itself. It marks every active leaf of the instance for removal and
appends a `control` event `{ t: "instance_revoked", instanceId, accountId }` to
each of those conversations, delivered to every other active leaf; the
revoked instance's sockets are disconnected and it receives `instance.revoked`
first.

### Enrollment approval message

The approving instance (active, itself instance-signed on the request) signs,
with its own Ed25519 key, the UTF-8 bytes of the string
`enrollmentApprovalMessage()` produces — byte for byte:

```
"allo-enroll-v1\n" + accountId + "\n" + newInstanceId + "\n" + newSigningPublicKey + "\n" + challenge
```

- `accountId` is the account both instances belong to;
- `newInstanceId` is the id of the pending instance being approved;
- `newSigningPublicKey` is the pending instance's raw 32-byte Ed25519 public
  key in base64, exactly as it was registered;
- `challenge` is the base64url challenge the server issued to the pending
  instance, exactly as issued.

The server verifies the signature against the APPROVER's stored key, then
stores `approvedByInstanceId` and `approvalSignature` on the new instance, sets
it `active`, clears the challenge, and emits `instance.approved` to
`instance:<newId>`. The first line differs from the request-signing context
(`allo-v1`), so neither signature can be replayed as the other.

### Key packages (`keyPackages.ts`)

| method | path | auth | request | response | errors |
| --- | --- | --- | --- | --- | --- |
| GET | `/v1/key-packages` | instance-signed | — | `KeyPackageStockResponse` `{ available }` | — |
| PUT | `/v1/key-packages` | instance-signed | `UploadKeyPackagesRequest` (1..50 `KeyPackageUpload`) | `UploadKeyPackagesResponse` `{ available }` | `validation_failed`, `idempotency_conflict` (duplicate `ref`) |
| POST | `/v1/key-packages/claim` | instance-signed | `ClaimKeyPackagesRequest` (1..100 instance ids) | `ClaimKeyPackagesResponse` `{ keyPackages, missing }` | `validation_failed` |

`KeyPackageUpload` is `{ ciphersuite: 1..65535, ref: base64 ≤128, data: base64 ≤8192 }`.
A claim consumes at most one package per instance, atomically; an instance
with none left appears in `missing` rather than failing the call. An instance
whose stock drops below the low-water mark is sent `keypackages.low`.

**Read the stock before topping it up.** Nothing expires a key package and no
sweep collects one, so whatever is uploaded stays — on the server, and with its
private half on the device. `GET /v1/key-packages` exists so a client starting
up can learn the count instead of assuming zero and uploading a full target's
worth every time; `topUpKeyPackages()` reads it whenever the server has not
just volunteered the number (the upload's answer, or the `keypackages.low`
nudge). Measured in a browser before the route existed: five reloads turned 21
local rows into 125, and the server's stock grew by the target on each one.

### Conversations (`conversations.ts`)

| method | path | auth | request | response | errors |
| --- | --- | --- | --- | --- | --- |
| POST | `/v1/conversations` | instance-signed | `CreateConversationRequest` | `CreateConversationResponse` `{ conversation, created }` | `validation_failed`, `key_packages_exhausted`, `idempotency_conflict` |
| GET | `/v1/conversations` | instance-signed | — | `ListConversationsResponse` | — |
| GET | `/v1/conversations/:id` | instance-signed | — | `ConversationResponse` | `not_found` |
| POST | `/v1/conversations/:id/leave` | instance-signed | — | `204` | `not_found` |

`CreateConversationRequest` is `{ kind, mlsGroupId, memberAccountIds, idempotencyKey, initialCommit? }`.
`memberAccountIds` names the OTHER members: exactly one for a `dm`, 0..255 for
a `group`, no duplicates; the creator is implied. `initialCommit` is a
`SubmitEventRequest` that must be an `mls_commit` at epoch 0 (its `commit`
adds the other leaves, its `welcome` lets them in, and its `groupInfo` is the
GroupInfo of epoch 1, like every commit's) and is appended in the same
transaction. A DM is unique per pair on `dmKeyFor(appId, a, b)` =
`${appId}:${sorted a}:${sorted b}`; a second creation returns the existing one
with `created: false` and HTTP 200, and the caller joins it by adding leaves.

`ConversationSummary` is `{ id, kind, appId, mlsGroupId, epoch, lastSeq, members: ConversationMember[], leaves: ConversationLeaf[], myLeafState: LeafState | null, createdByAccountId, createdAt }`
with `ConversationMember` `{ accountId, role: owner|admin|member, state: joined|left|removed, joinedAt }`
and `ConversationLeaf` `{ instanceId, accountId, state: pending_welcome|active|removed, addedEpoch }`.
The server never knows a conversation's name; that is a `conversation` app
message.

### Events (`events.ts`)

| method | path | auth | request | response | errors |
| --- | --- | --- | --- | --- | --- |
| POST | `/v1/conversations/:id/events` | instance-signed | `SubmitEventRequest` | `SubmitEventResponse` `{ event: { id, seq, createdAt } }` | `validation_failed`, `not_found`, `forbidden`, `epoch_conflict`, `idempotency_conflict`, `payload_too_large` |
| GET | `/v1/conversations/:id/events?after=&limit=` | instance-signed | query `ListEventsQuery` | `ListEventsResponse` `{ events, hasMore }` | `not_found`, `validation_failed` |

`SubmitEventRequest` is `{ idempotencyKey, kind: mls_commit|mls_proposal|app_message, epoch, payload: base64 ≤1 MiB, commit?: CommitInfo, blobIds?: 0..16 }`.
The schema enforces that `commit` is present exactly when `kind` is
`mls_commit`, and that `commit.newEpoch === epoch + 1`. `CommitInfo` is
`{ newEpoch, kind?: member|external|resync, addedLeaves: [{ instanceId, accountId }], removedLeaves: [instanceId], welcome?: { payload, recipients: [instanceId] (1..) }, groupInfo: base64 }`.

`groupInfo` is REQUIRED on every commit: the serialized MLS `GroupInfo` of
`newEpoch`, with the `external_pub` and `ratchet_tree` extensions, at most
`GROUP_INFO_MAX_BYTES` (256 KiB) of bytes, `GROUP_INFO_MAX_BASE64` encoded.
The server stores it for the conversation (see [Group info](#group-info-groupinfots))
in the same transaction as the commit, so "commit accepted but no GroupInfo for
the new epoch" cannot happen. Both a member committer and an external joiner
hold the new state at the moment they post.

`commit.kind` (`CommitKind`, default `member`) says how the commit was
authored, and the schema enforces its shape:

| kind | `addedLeaves` | `removedLeaves` | `welcome` | who may send it |
| --- | --- | --- | --- | --- |
| `member` | any | any | optional | a member holding an active leaf (or the creator's first commit) |
| `external` | exactly one | none | forbidden | an account with a `joined` member row and NO active leaf on this instance |
| `resync` | exactly one | exactly one | forbidden | an instance that already holds a leaf and lost its group state |

For `external` and `resync` the server further checks what only it can: the one
added leaf is `{ accountId: sender.accountId, instanceId: sender.instanceId }`
and, for `resync`, the one removed leaf is the sender's own instance. Anything
else is `403 forbidden`. `SubmitEventRequestInput` and `CommitInfoInput` are
the pre-default types a client builds (where `kind` may be omitted).

Server rules, one transaction under `FOR UPDATE` on the conversation:

- the sender holds an active leaf (or is the creator making the first commit),
  except for an `external` commit, whose sender needs only a `joined` member
  row for its account, and a `resync` commit, whose sender needs a leaf that is
  `active` or `removed` without a `removedEpoch`;
- `epoch` must equal the current epoch, else `409 epoch_conflict` with
  `details.currentEpoch`; an external joiner that loses the race refetches the
  GroupInfo and tries again;
- an `app_message` or `mls_proposal` is delivered to every active leaf but the
  sender;
- an `mls_commit` advances the epoch, is delivered to every leaf active at the
  old epoch (removed ones included, so they learn it), moves added leaves to
  `pending_welcome` and removed ones to `removed`, turns `welcome` into a
  separate `mls_welcome` event delivered only to its recipients, and stores
  `groupInfo` as the conversation's GroupInfo for `newEpoch`;
- an `external` commit makes the sender's leaf `active` at `newEpoch`
  immediately (there is no Welcome to wait for) and is delivered to every other
  active leaf, never to the sender; the DM rule ("a dm cannot gain a third
  account") is unchanged, since the joiner's account is already `joined`;
- a `resync` commit REPLACES the sender's leaf row (`active` at `newEpoch`,
  `addedEpoch = newEpoch`) rather than being refused for an instance that
  already holds an active leaf; membership is unchanged;
- an `external` or `resync` commit when the server holds no GroupInfo for the
  current epoch is `409 group_info_missing`; the joiner waits for an elector
  (the old path) instead;
- a replay of `(senderInstanceId, idempotencyKey)` with the same body returns
  the original `{ event }` and 200; a different body is `idempotency_conflict`;
- `seq` is dense per conversation; deliveries are written in the same
  transaction and recipients are nudged after it commits.

`ConversationEvent` is `{ id, conversationId, seq, kind, epoch, senderAccountId, senderInstanceId | null, payload: base64, blobIds, createdAt }`.
A `control` event has `senderAccountId` = `SERVER_SENDER_ID` (`allo:server`),
`senderInstanceId: null`, and a payload that is the base64 of a `ControlEvent`
JSON: `{ t: "instance_revoked", instanceId, accountId }`,
`{ t: "member_left", accountId }` or `{ t: "conversation_created" }`.

### Group info (`groupInfo.ts`)

| method | path | auth | request | response | errors |
| --- | --- | --- | --- | --- | --- |
| GET | `/v1/conversations/:id/group-info` | instance-signed | — | `GroupInfoResponse` `{ groupInfo: StoredGroupInfo \| null }` | `not_found`, `forbidden` |
| PUT | `/v1/conversations/:id/group-info` | instance-signed | `PutGroupInfoRequest` `{ epoch, data }` | `204` | `not_found`, `forbidden`, `validation_failed`, `epoch_conflict`, `payload_too_large` |

The stored `GroupInfo` is what a device that is a member with no active leaf
joins from, by MLS external commit, with nobody else online: the elector rules
("This device is being added…") become the fallback for a conversation that
has none. One row per conversation, for the CURRENT epoch only, replaced by
every `mls_commit` (`CommitInfo.groupInfo`). The server never reads its bytes.

`StoredGroupInfo` is `{ epoch, signerInstanceId, data: base64, createdAt }`:
the epoch it describes, the instance whose commit (or re-publish) produced it,
and the serialized GroupInfo (`external_pub` + `ratchet_tree`, ≤ 256 KiB of
bytes).

- `GET` is gated by a `joined` member row for the caller's account, like every
  read; holding a leaf is NOT required, because the caller is precisely a
  device that holds none yet. `groupInfo: null` means the server holds nothing
  for the current epoch — a conversation whose last commit predates the field —
  and the caller waits for an elector as before. It is never a 404 for a
  conversation the caller is a member of.
- `PUT` re-publishes for the current epoch only. The caller must hold an
  `active` leaf (it is the one with the state to publish from), and `epoch`
  must equal the conversation's current epoch, else `409 epoch_conflict` with
  `details.currentEpoch`. It exists for conversations whose last commit
  predates the field: a member that finds `groupInfo: null` publishes once, and
  the leafless device can join on its next sync.
- No socket event announces a new GroupInfo; the joiner fetches on demand.

Admission is not the GroupInfo: anybody with a member row can read it. Every
member's engine validates the joiner of an external commit before processing
it — the leaf's credential is `accountId:instanceId`, that instance must be in
the account's verified chain with that signing key, and no active leaf may
already carry the key or the id unless the same commit removes it (`resync`).
A commit that fails is dropped and the member's state untouched.

### Sync (`sync.ts`)

| method | path | auth | request | response | errors |
| --- | --- | --- | --- | --- | --- |
| GET | `/v1/sync?cursor=&limit=` | instance-signed | query `SyncQuery` | `SyncResponse` `{ deliveries: SyncDelivery[], nextCursor, hasMore }` | `validation_failed` |
| POST | `/v1/sync/ack` | instance-signed | `AckSyncRequest` `{ cursor }` | `204` | `validation_failed` |

The stream is this instance's deliveries in order. A cursor is
`encodeCursor(n)`: base64url of the decimal form of the delivery's integer
position; `decodeCursor` is its inverse and throws on anything else, and
`INITIAL_CURSOR` (`MA`, zero) names the start. A client stores the cursor and
hands it back; it never compares two as text. `SyncDelivery` is
`{ cursor, conversationId, event: ConversationEvent }`; acking a cursor acks
everything up to it. `nextCursor` equals the request cursor when nothing came
back.

### Blobs (`blobs.ts`)

| method | path | auth | request | response | errors |
| --- | --- | --- | --- | --- | --- |
| POST | `/v1/blobs` | instance-signed | raw `application/octet-stream` body, `Content-Length`, header `X-Allo-Blob-Sha256` (lowercase hex) | `UploadBlobResponse` `{ blobId, size }` | `validation_failed` (digest mismatch or missing), `payload_too_large` |
| GET | `/v1/blobs/:id` | instance-signed | — | the bytes, `application/octet-stream` | `not_found` |

The signature of a blob upload covers the blob bytes (`bodySha256Hex` is their
digest, the same value as `X-Allo-Blob-Sha256`). Any authenticated instance may
read a blob by id: ids are unguessable and the content is ciphertext whose key
travels only inside a `media` app message. A blob nobody references expires
seven days after upload; one referenced from an event's `blobIds` is kept.
Bound: `DEFAULT_MAX_BLOB_BYTES` (25 MiB) unless the deployment says otherwise.

### History (`archive.ts`, `historyOffers.ts`)

How a new instance gets its timeline. A new instance is a new MLS leaf and
live group state is NEVER copied between instances; history reaches it by an
end-to-end-encrypted transfer from another instance of the same account (an
offer), or by an encrypted backup (next section). The server stores ciphertext
chunks, a signed manifest and a sealed key, and can open none of them.

| method | path | auth | request | response | errors |
| --- | --- | --- | --- | --- | --- |
| POST | `/v1/instances/:id/history-offers` | instance-signed | `CreateHistoryOfferRequest` (`:id` is the recipient and must equal `recipientInstanceId`) | `HistoryOfferResponse` `{ offer }` | `validation_failed` (a non-`transfer` manifest included), `not_found` (recipient, or a chunk blob), `forbidden` (recipient is another account's, or a chunk blob is), `instance_not_active` (recipient), `transfer_key_missing`, `unauthorized` (bad manifest signature) |
| GET | `/v1/instances/me/history-offers` | instance-signed | — | `ListHistoryOffersResponse` `{ offers }` — the caller's `pending` offers | — |
| POST | `/v1/instances/me/history-offers/:id/consume` | instance-signed | — | `HistoryOfferResponse` `{ offer }` with `status: "consumed"` | `not_found` (not the caller's, or not pending) |

`HistoryOffer` is `{ id, accountId, donorInstanceId, recipientInstanceId, manifest: ArchiveManifest, sealedKey, manifestSignature, status: pending|consumed|expired, createdAt, expiresAt }`.
`CreateHistoryOfferRequest` is `{ recipientInstanceId, manifest, sealedKey, manifestSignature }`.

Server rules for creating an offer: the donor (the signing instance) is
active; the recipient is an active instance of the SAME account and has a
`transferPublicKey` (else `409 transfer_key_missing`); every
`manifest.chunkBlobIds` entry exists and belongs to the donor's account;
`manifestSignature` verifies against the DONOR's signing key over
`archiveManifestMessage(manifest)`; one pending offer per (donor, recipient) —
a newer one marks the older `expired`. The offer expires `HISTORY_OFFER_TTL_MS`
(7 days) after creation. On creation the server emits `history.offer
{ offerId }` to `instance:<recipient>`. Blobs referenced by an offer are kept
while it is pending and released for collection a day after it is consumed,
expired or replaced.

The recipient trusts nothing the server says about the donor. Before
downloading a chunk it verifies the donor's enrollment chain, verifies
`manifestSignature` against the donor's signing key, and opens `sealedKey`
with its own transfer key; it imports only from a VERIFIED same-account
instance.

#### The archive

`Archive` (`archiveV1Schema`) is the plaintext an instance exports. It exists
only on devices:

```ts
type ArchiveV1 = {
  v: 1; createdAt: iso; accountId; appId;
  conversations: Array<{ id; kind; appId; title: string | null; memberAccountIds: string[]; createdAt }>;
  events: Array<{ conversationId; eventId; seq; senderAccountId; senderInstanceId: string | null; sentAt; message: AppMessage }>;
  mediaKeys: Array<{ conversationId; blobId; key: base64; nonce: base64; sha256: hex; thumbnail?: { blobId; key; nonce; sha256 } }>;
};
```

Every event carries its DECRYPTED `AppMessage`, never MLS ciphertext.
`encodeArchive` produces UTF-8 JSON (validating first, so a malformed archive
is never encrypted); `decodeArchive` parses and validates, throwing
`ArchiveDecodeError` on anything else — including an event whose `message` is
not an `AppMessage`.

The archive is encrypted client-side as CHUNKS: the `encodeArchive` bytes are
split into pieces of at most `ARCHIVE_CHUNK_MAX_BYTES` (4 MiB); each piece is
AES-256-GCM under the 32-byte archive key with a random 12-byte nonce PREFIXED
to the ciphertext and the AAD `archiveChunkAad(i, n)` =
`"allo-archive-v1:" + i + "/" + n` (`ARCHIVE_CHUNK_AAD_PREFIX`, index and
total, so a chunk cannot be dropped, duplicated or reordered without the
decryption failing); each chunk is uploaded as one blob through `POST /v1/blobs`.

#### The manifest

`ArchiveManifest` (`archiveManifestSchema`) is what the server stores about an
archive:

```ts
type ArchiveManifest = {
  v: 1; kind: "transfer" | "backup"; createdAt: iso;
  conversationCount: number; eventCount: number;
  chunkBlobIds: string[];   // 1..512, in order
  plaintextSha256: hex;     // of the whole encodeArchive output, checked after decryption
};
```

The producer signs it with its instance Ed25519 key over the UTF-8 bytes of
`archiveManifestMessage(manifest)`, byte for byte:

```
"allo-archive-manifest-v1\n" + canonicalJson(manifest)
```

`canonicalJson` is JSON with object keys sorted recursively, no whitespace and
`undefined` members omitted, so two producers serialising the same manifest
sign the same bytes. `kind` is inside the signed bytes:
`createHistoryOfferRequestSchema` refuses a manifest whose kind is not
`transfer` and `putBackupRequestSchema` one whose kind is not `backup`, so a
signature made for one cannot be replayed as the other.

#### Sealing the archive key

For a transfer, `sealedKey` is the 32-byte archive key sealed to the
recipient's `transferPublicKey` with HPKE base mode, X25519-HKDF-SHA256 /
AES-128-GCM, info `HISTORY_KEY_SEAL_INFO` = `"allo-history-key-v1"`; the wire
value is `enc || ct`, base64 (`sealedKeySchema`, at most 4096 chars).

### Backups (`backups.ts`)

One encrypted archive per account, unlocked by a recovery phrase the user
holds and the server never sees. If every device and the phrase are lost,
history is gone.

| method | path | auth | request | response | errors |
| --- | --- | --- | --- | --- | --- |
| PUT | `/v1/accounts/me/backup` | instance-signed | `PutBackupRequest` | `BackupResponse` `{ backup }` — replaces the previous backup | `validation_failed` (a non-`backup` manifest included), `not_found` / `forbidden` (a chunk blob), `unauthorized` (bad manifest signature) |
| GET | `/v1/accounts/me/backup` | instance-signed | — | `BackupResponse` `{ backup: AccountBackup \| null }` — `null` when the account has none | — |
| DELETE | `/v1/accounts/me/backup` | instance-signed | — | `204` | `backup_not_found` |

`PutBackupRequest` is `{ manifest (kind "backup"), keyCheck, manifestSignature }`;
`AccountBackup` is `{ accountId, instanceId, manifest, keyCheck, manifestSignature, updatedAt }`,
where `instanceId` is the instance that wrote it and whose key verifies
`manifestSignature` (checked at `PUT` time against the writing instance). The
chunk blobs are kept while the backup exists and released a day after it is
replaced or deleted.

#### The backup key

Derivation is a client concern, but the contract fixes it so every client
derives the same key:

- 12-word BIP39 (English) phrase → 128-bit entropy;
- `HKDF-SHA256(ikm = entropy, salt = BACKUP_KDF_SALT, info = accountId)` →
  32-byte backup key, with `BACKUP_KDF_SALT` = `"allo-backup-v1"`;
- the backup key IS the archive key: the chunks are encrypted under it exactly
  as described above.

`keyCheck` is `HMAC-SHA256(key = backup key, message = BACKUP_KEY_CHECK_MESSAGE)`
with `BACKUP_KEY_CHECK_MESSAGE` = `"allo-backup-key-check-v1"`, base64 of the
32-byte output (`backupKeyCheckSchema`, 44 chars). A client that derives a key
from a typed phrase compares its own HMAC to the stored `keyCheck` and refuses
a wrong phrase before downloading a single chunk. The server stores and
returns `keyCheck` and learns nothing from it.

### Directory (unchanged)

`GET /api/directory/*` keeps its existing contract (`DirectoryUser`,
`DirectoryUserListResponse`, `DirectorySearchResponse`,
`DirectoryAssetUrlResponse`, and the `ApiErrorResponse` / `ApiSuccessResponse`
envelope in `api.ts`). It is Oxy-authenticated and not part of `/v1`.

## Calls (`calls.ts`)

| route | auth | body | answer |
| --- | --- | --- | --- |
| `POST /v1/calls` | instance | `CreateCallRequest` | 201 `{ call }` — rings every active device of every other member |
| `GET /v1/calls/:id` | instance | — | `{ call }`; the caller and the rung devices only |
| `GET /v1/calls/:id/ice` | instance | — | `IceServersResponse` `{ iceServers, expiresAt, relayOnly }` |
| `GET /v1/calls/:id/token` | instance | — | `CallTokenResponse` `{ url, token, room, expiresAt }` — the SFU ticket, group calls only |
| `POST /v1/calls/:id/answer` | instance | — | `{ call }`; 403 when another device won the race |
| `POST /v1/calls/:id/decline` | instance | — | `{ call }` |
| `POST /v1/calls/:id/end` | instance | `EndCallRequest` | `{ call }` |

**Nothing about the media is here.** The offer, the answer, the ICE candidates
and the frame keys are encrypted `call` application messages in the
conversation — a control kind, so a client that does not know them ignores
them. The server relays that ciphertext and holds only the state machine it
cannot do without: a `calls` row, and a `call_participants` row per RUNG
DEVICE.

The rules:

- **A ring is forked to every active device** of every other joined member,
  and never across a block in either direction.
- **Exactly one device wins.** `answer` is an UPDATE guarded on the state, so a
  second device answering a moment later is told who won instead of joining a
  call nobody else is on. Its own account's other phones stop ringing; in a
  group everybody else's keep going.
- **`relayed` is a property of the CALL.** True for a group, and for a 1:1
  where either side has `privacy_relay_calls` on — a connection cannot be half
  relayed. Everybody is told the call is relayed; nobody is told who asked.
- **The SFU ticket refuses three things, and each is a rule.** A 1:1 call has
  no ticket — its media is peer to peer, or through the TURN relay `/ice` hands
  out, and the SFU is not in that path at all. An ended call has none, so a
  token cannot outlive the call it was minted for. And only a device that has
  ANSWERED gets one: a rung device has not agreed to be in the room, and the
  ticket is how you get in. `identity` is the INSTANCE rather than the account,
  because two of somebody's devices in one call are two participants and the
  per-sender frame key of ADR 0002 is per device; the grant sets
  `canPublishData: false`, because signalling and the frame keys travel as
  encrypted messages in the conversation and nothing rides LiveKit's data
  channel. With no SFU configured the route answers `unavailable` rather than
  inventing a room.
- **`relayOnly` in the ICE answer is what a client sets `iceTransportPolicy`
  from.** The credential is the 2013 REST scheme every TURN server implements
  (`username = "<expiry>:<account>"`, `credential = base64(HMAC-SHA1(secret,
  username))`), valid for an hour, with the account in the username so the
  relay's own quotas and logs are per account. With no relay configured the
  answer is STUN alone.
- **The ring gives up after `CALL_RING_TIMEOUT_MS`** (45 s), which only the
  server can notice; `workers/callRingWorker.ts` claims and settles each
  expired ring in one statement, so two tasks sweeping at the same second ring
  off each call exactly once.

**The call LOG is not these rows.** What a person sees is an encrypted
`call_log` message written into the conversation when the call ends, so it
reaches every device of both accounts the way any other message does. These
rows are operational and the sweep takes them a day later.

## Status updates (`statuses.ts`)

| route | auth | body | answer |
| --- | --- | --- | --- |
| `POST /v1/statuses` | instance | `CreateStatusRequest` | 201 `CreateStatusResponse` `{ status, refused }` |
| `GET /v1/statuses` | instance | — | `ListStatusesResponse` — everything sealed to THIS instance, plus what its own account posted |
| `DELETE /v1/statuses/:id` | instance | — | 204; author only, and a status that is not yours answers `not_found` |
| `POST /v1/statuses/:id/views` | instance | — | 204; only from a device the status was sealed to |
| `GET /v1/statuses/:id/views` | instance | — | `ListStatusViewsResponse` `{ views, total }`; author only |

One ciphertext, a key sealed per recipient DEVICE. The poster encrypts the
whole update (its kind, its words, and the key and digest of any media blob)
under a random per-status key, and HPKE-seals that key to each recipient
instance's `transferPublicKey` with `info = STATUS_KEY_SEAL_INFO` — the same
primitive a history offer uses, with its own domain separator. The server
stores a body it cannot open and `N` sealed keys it cannot use.

The audience is resolved on the DEVICE; the server is never asked who your
contacts are. What it decides is delivery, and it refuses three kinds of
recipient, naming each in `refused` so the app can be honest about who did not
get it:

1. a device that is not there (unknown, pending or revoked),
2. an account that shares no conversation with the author,
3. either direction of a block.

The author's own other devices are always allowed, which is how a status shows
on the phone that did not post it.

`id` and `expiresAt` are the client's and are covered by `signature`
(`statusSignatureMessage`) — a server-assigned id could not be signed, and an
unsigned deadline could be moved. The server refuses a deadline beyond
`STATUS_LIFETIME_MS` (24 hours) or already past. A recipient verifies that
signature against the author instance's published key, and the digest of the
ciphertext, BEFORE decrypting; it also keeps the deadline it verified rather
than a later claim.

Expiry is the ordinary sweep: `statuses`, `status_keys` and `status_views` all
carry the deadline, and the blobs the envelope named are dated a day out ahead
of the delete, exactly as a history offer's chunks are.

## Presence (`presence.ts`)

| route | auth | body | answer |
| --- | --- | --- | --- |
| `GET /v1/presence?accountIds=a,b,c` | instance | — | `PresenceResponse` `{ presence: PresenceState[], publishing }` |

The socket carries the changes; this is how a screen starts, before anything
has changed. Four rules decide what comes back, and they are enforced here
rather than asked of the client:

1. **Reciprocity.** An account whose `privacy_show_online_status` is off
   publishes nothing and receives nothing — `publishing: false`, and every
   state hidden.
2. **A shared conversation.** Only accounts the asker shares one with are
   answered honestly. Presence is not a directory lookup.
3. **Blocks, both directions.** Either side of a block hides both.
4. **One answer for all of it.** Hidden, blocked, unknown and plainly offline
   are all `{ online: false, lastSeenAt: null }`. A client that could tell
   them apart could tell it had been blocked.

`lastSeenAt` is truncated to the minute and is `null` while the account is
online, so the two facts are never read as one.

## Socket events (`sync.ts`)

Namespace `/v1`, authenticated as above. Payload schemas are the values of
`SERVER_TO_CLIENT_EVENTS` and `CLIENT_TO_SERVER_EVENTS`; `ServerToClientEvents`
and `ClientToServerEvents` are the handler maps for Socket.IO's generics.

| event | direction | payload | meaning |
| --- | --- | --- | --- |
| `sync.nudge` | server → client | `SyncNudgeEvent` `{ conversationId? }` | something is waiting in the stream; pull `/v1/sync`. Also sent, with the `conversationId`, to every active leaf of a conversation whose `joined` member had no active leaf when one of its instances becomes `active` (bootstrap registration or approval), so an elector adds it without waiting for its sync interval |
| `instance.approved` | server → client (`instance:<id>`) | `InstanceApprovedEvent` `{ instanceId }` | this instance is now active |
| `instance.revoked` | server → client (`account:<id>`) | `InstanceRevokedEvent` `{ instanceId }` | an instance of the account was revoked |
| `keypackages.low` | server → client | `KeyPackagesLowEvent` `{ available }` | upload more key packages |
| `typing` | client → server, server → client | `TypingEvent` `{ conversationId, ciphertext }` | an MLS application message carrying a `typing` app message; relayed to the conversation's other leaves, never stored |
| `presence` | server → client | `PresenceState` `{ accountId, online, lastSeenAt }` | one account of THIS socket's watch set changed. Never a broadcast: a socket hears only about what it asked for |
| `presence.watch` | client → server | `PresenceWatchEvent` `{ accountIds }` | the accounts this client is SHOWING, at most 200. Replaces the previous set; an empty list stops the updates |
| `presence.heartbeat` | client → server | `{}` | this instance is still here. Presence is a heartbeat with a 75 s deadline, not an open socket — a socket survives a sleeping phone |
| `call.incoming` | server → client (`instance:<rung device>`) | `CallIncomingEvent` `{ callId, conversationId, initiatorAccountId, mode, group }` | somebody is calling this device; the offer itself arrives encrypted, in the conversation |
| `call.updated` | server → client | `CallUpdatedEvent` `{ callId, state, answeredByInstanceId, endReason }` | the call moved: answered elsewhere, declined, ended, or the ring gave up |
| `status.posted` | server → client (`instance:<recipient>`) | `StatusPostedEvent` `{ statusId, authorAccountId }` | somebody this device holds a key for posted a status; re-read `GET /v1/statuses` |
| `history.offer` | server → client (`instance:<recipient>`) | `HistoryOfferEvent` `{ offerId }` | another instance of the account offered this one its history; pull `GET /v1/instances/me/history-offers` and verify the donor before accepting |

## The application message (`appMessage.ts`)

Not a route. `AppMessage` is the plaintext a client hands to MLS; the server
never sees it. `encodeAppMessage` produces UTF-8 JSON (validating first, so a
malformed envelope is never encrypted) and `decodeAppMessage` parses and
validates, throwing `AppMessageDecodeError` on anything else. `v` is `1`;
`t` is one of `text`, `edit`, `delete`, `reaction`, `read`, `delivered`,
`media`, `conversation`, `poll`, `poll_vote`, `location`, `contact`, `pin`,
`typing`. A control kind carries `ctl: true`, and a receiver decodes with
`decodeAppMessageOrIgnore`, which answers `null` for a marked kind it does not
know rather than reporting a message it cannot read — so a kind added in a
later release is ignored in silence by the releases before it. `EventRef` names another message as
`{ kind: "event", conversationId, eventId }` once the server has assigned an
id, or `{ kind: "local", conversationId, idempotencyKey }` while it is still
the sender's local echo. A `media` message carries the blob id, the 32-byte
content key, the nonce, the ciphertext digest, mime, filename, plaintext size,
`kind: image|video|audio|voice|file`, optional dimensions, duration, caption
and an encrypted thumbnail of the same shape.

`{ v: 1, t: "delivered", upTo: EventRef }` is a delivery receipt: a RECEIVING
instance sends it once it has imported everything up to `upTo`, encrypted like
`read`, so the server learns nothing. A receiver acts on it only when it comes
from another ACCOUNT (a DM's other party, or any other member of a group) and
marks its own items with `seq ≤ upTo` as delivered unless they are already
read; one from its own account's other instances is ignored.
