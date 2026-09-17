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
| `epoch_conflict` | 409 | an event at a stale epoch; `details: EpochConflictDetails` `{ currentEpoch }` |
| `instance_not_active` | 403 | the signing instance is still `pending` |
| `instance_revoked` | 403 | the signing instance is `revoked` |
| `key_packages_exhausted` | 409 | a claim found nothing for a required instance |
| `idempotency_conflict` | 409 | the idempotency key was used before with a different body |
| `payload_too_large` | 413 | event payload, blob or body over its bound |
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
| GET | `/v1/accounts/:accountId/instances` | oxy | — | `ListAccountInstancesResponse` (`PublicInstance[]`, active only) | `not_found` |
| GET | `/v1/instances/pending` | instance-signed | — | `ListPendingEnrollmentsResponse` | — |
| POST | `/v1/instances/:id/approve` | instance-signed | `ApproveInstanceRequest` | `InstanceResponse` | `not_found`, `forbidden`, `unauthorized` (bad approval signature), `validation_failed` |
| POST | `/v1/instances/:id/reject` | instance-signed | — | `InstanceResponse` | `not_found`, `forbidden` |
| POST | `/v1/instances/:id/revoke` | instance-signed | — | `InstanceResponse` | `not_found`, `forbidden` |
| PUT | `/v1/instances/me/push` | instance-signed | `SetPushTokenRequest` | `204` | `validation_failed` |
| DELETE | `/v1/instances/me/push` | instance-signed | — | `204` | — |

Registration is the bootstrap rule: an account with zero active instances
gets `enrollment: "active"` at once; otherwise the answer is `"pending"` with
a `challenge` (32 random bytes, base64url) and the instance waits for an
approval. `RegisterInstanceResponse` refuses a pending answer without a
challenge and an active one with one.

`ClientInstance` (own account's view) carries `enrolledAt`, `revokedAt`,
`lastSeenAt`, `approvedByInstanceId`, `approvalSignature` and `enrollmentChallenge` (published once approved, `null` before and for the bootstrap instance) as
always-present, nullable fields, mirroring the columns behind them.
`PublicInstance` (another account's view) is the subset needed to verify an
enrollment chain and address an MLS leaf: id, accountId, appId, platform,
signingPublicKey, approvedByInstanceId, approvalSignature, enrollmentChallenge, status.

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
| PUT | `/v1/key-packages` | instance-signed | `UploadKeyPackagesRequest` (1..50 `KeyPackageUpload`) | `UploadKeyPackagesResponse` `{ available }` | `validation_failed`, `idempotency_conflict` (duplicate `ref`) |
| POST | `/v1/key-packages/claim` | instance-signed | `ClaimKeyPackagesRequest` (1..100 instance ids) | `ClaimKeyPackagesResponse` `{ keyPackages, missing }` | `validation_failed` |

`KeyPackageUpload` is `{ ciphersuite: 1..65535, ref: base64 ≤128, data: base64 ≤8192 }`.
A claim consumes at most one package per instance, atomically; an instance
with none left appears in `missing` rather than failing the call. An instance
whose stock drops below the low-water mark is sent `keypackages.low`.

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
adds the other leaves, its `welcome` lets them in) and is appended in the same
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
`{ newEpoch, addedLeaves: [{ instanceId, accountId }], removedLeaves: [instanceId], welcome?: { payload, recipients: [instanceId] (1..) } }`.

Server rules, one transaction under `FOR UPDATE` on the conversation:

- the sender holds an active leaf (or is the creator making the first commit);
- `epoch` must equal the current epoch, else `409 epoch_conflict` with
  `details.currentEpoch`;
- an `app_message` or `mls_proposal` is delivered to every active leaf but the
  sender;
- an `mls_commit` advances the epoch, is delivered to every leaf active at the
  old epoch (removed ones included, so they learn it), moves added leaves to
  `pending_welcome` and removed ones to `removed`, and turns `welcome` into a
  separate `mls_welcome` event delivered only to its recipients;
- a replay of `(senderInstanceId, idempotencyKey)` with the same body returns
  the original `{ event }` and 200; a different body is `idempotency_conflict`;
- `seq` is dense per conversation; deliveries are written in the same
  transaction and recipients are nudged after it commits.

`ConversationEvent` is `{ id, conversationId, seq, kind, epoch, senderAccountId, senderInstanceId | null, payload: base64, blobIds, createdAt }`.
A `control` event has `senderAccountId` = `SERVER_SENDER_ID` (`allo:server`),
`senderInstanceId: null`, and a payload that is the base64 of a `ControlEvent`
JSON: `{ t: "instance_revoked", instanceId, accountId }`,
`{ t: "member_left", accountId }` or `{ t: "conversation_created" }`.

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

### Directory (unchanged)

`GET /api/directory/*` keeps its existing contract (`DirectoryUser`,
`DirectoryUserListResponse`, `DirectorySearchResponse`,
`DirectoryAssetUrlResponse`, and the `ApiErrorResponse` / `ApiSuccessResponse`
envelope in `api.ts`). It is Oxy-authenticated and not part of `/v1`.

## Socket events (`sync.ts`)

Namespace `/v1`, authenticated as above. Payload schemas are the values of
`SERVER_TO_CLIENT_EVENTS` and `CLIENT_TO_SERVER_EVENTS`; `ServerToClientEvents`
and `ClientToServerEvents` are the handler maps for Socket.IO's generics.

| event | direction | payload | meaning |
| --- | --- | --- | --- |
| `sync.nudge` | server → client | `SyncNudgeEvent` `{ conversationId? }` | something is waiting in the stream; pull `/v1/sync` |
| `instance.approved` | server → client (`instance:<id>`) | `InstanceApprovedEvent` `{ instanceId }` | this instance is now active |
| `instance.revoked` | server → client (`account:<id>`) | `InstanceRevokedEvent` `{ instanceId }` | an instance of the account was revoked |
| `keypackages.low` | server → client | `KeyPackagesLowEvent` `{ available }` | upload more key packages |
| `typing` | client → server, server → client | `TypingEvent` `{ conversationId, ciphertext }` | an MLS application message carrying a `typing` app message; relayed to the conversation's other leaves, never stored |
| `presence` | server → client | `PresenceEvent` `{ accountId, online }` | best effort, for accounts sharing a conversation |

## The application message (`appMessage.ts`)

Not a route. `AppMessage` is the plaintext a client hands to MLS; the server
never sees it. `encodeAppMessage` produces UTF-8 JSON (validating first, so a
malformed envelope is never encrypted) and `decodeAppMessage` parses and
validates, throwing `AppMessageDecodeError` on anything else. `v` is `1`;
`t` is one of `text`, `edit`, `delete`, `reaction`, `read`, `media`,
`conversation`, `typing`. `EventRef` names another message as
`{ kind: "event", conversationId, eventId }` once the server has assigned an
id, or `{ kind: "local", conversationId, idempotencyKey }` while it is still
the sender's local echo. A `media` message carries the blob id, the 32-byte
content key, the nonce, the ciphertext digest, mime, filename, plaintext size,
`kind: image|video|audio|voice|file`, optional dimensions, duration, caption
and an encrypted thumbnail of the same shape.
