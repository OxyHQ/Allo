# The Allo SDK: `@allo/core` and `@allo/react`

Two packages, one rule: **Allo App uses exactly this SDK, and so will
Mention.** There is no second engine inside the app, no chat code in
`packages/frontend` that talks to `/v1` directly, and no hook that reaches
past `@allo/core`. Anything a screen needs that the SDK does not expose is
added to the SDK, where the next app gets it too.

This page is the human index of `packages/core/src` and `packages/react/src`
as they stand. The wire contract those packages speak is `api-v1.md`; the
cryptography they run is `crypto.md`.

```
@allo/shared-types   zod schemas and types of API v1; no React
      ^
@allo/core           headless SDK; Node, browsers and Hermes; no React, Expo or RN imports
      ^
@allo/react          AlloProvider and hooks over the client; plain React, no React Native
      ^
@allo/frontend       the Expo app; consumes @allo/react for everything chat
```

## `@allo/core`

### Construction

```ts
import { createAlloClient } from "@allo/core";

const client = createAlloClient({
  baseUrl: "https://api.allo.you",
  appId: "allo",
  platform: "web",                // ios | android | web | desktop | node
  displayName: "Nate's laptop",   // what the devices list shows
  session,                        // OxySessionAdapter
  storage,                        // StorageAdapter
  secrets,                        // SecretStore
});
await client.start();
```

The client does nothing until `start()`. `start()` opens the account's
encrypted store, registers the instance on first run (or loads it), connects
the socket and, once the instance is `active`, tops up key packages, pulls
the server's conversation list and syncs. `stop()` disconnects and stops
every loop and timer. `reset()` is sign-out: it revokes this instance (best
effort), wipes the account's namespace in storage and deletes every secret
the account had (signing key, storage key, transfer key, backup key).

Optional options: `crypto` (a `ts-mls` `CryptoProvider`; the default is the
SDK's noble-only provider on every platform, see `crypto.md`), `transport`
(`{ fetch, socketFactory }`, which is how tests inject the fake server),
`logger`, `now`, `keyPackageTarget` (default 20), `syncIntervalMs` (default
30 000) and `backupDebounceMs` (default 10 000, the wait before an automatic
backup refresh). `people` is accepted by the type and never read: no module resolves a
display name, and every view model carries account ids only. The design brief
listed it as the resolver the SDK would call; the app resolves names itself
for now.

### The three adapters a host must provide

| adapter | shape | what is to back it in Allo App |
| --- | --- | --- |
| `OxySessionAdapter` | `getAccessToken(): Promise<string \| null>`, `getAccountId(): string \| null`, `subscribe(cb): unsubscribe` | the Oxy session from `@oxy.so/services` |
| `StorageAdapter` | a byte key-value store: `get`, `set`, `delete`, `list(prefix)`, `batch(ops)` atomic | expo-sqlite on native, IndexedDB on web |
| `SecretStore` | `get`, `set`, `delete` of named byte values | expo-secure-store on native, IndexedDB on web |

The third column is what `packages/frontend/lib/allo/` implements: it is the
only place the app constructs the client (`client.ts`), and it holds every
platform adapter (`storage.native.ts`, `storage.web.ts`, `secrets.native.ts`,
`secrets.web.ts`, `session.ts`, `people.ts`, `push.ts`). The SDK's own tests
run on the in-memory adapters described under "The fake server".

The storage adapter never sees plaintext: every value is encrypted by the
SDK before it reaches `set` (`crypto.md` section 8). The secret store holds
up to four values per account and app: the instance signing key, the storage
key, the X25519 transfer key (`crypto.md` section 12) and, once backup is
enabled or restored, the backup key derived from the recovery phrase
(section 15 there). The recovery phrase itself is never stored. The SDK
verifies a write by reading it back, so a secret store that silently drops
writes fails loudly at start rather than at the first decrypt.
`batch` must be atomic: the SDK commits a delivery, its group-state change and
the sync cursor as one batch and relies on all or nothing.

### The public API, by module

`client.instance` (`instance/manager.ts`): `state()` returns
`unregistered | pending-approval | active | revoked`; `current()`, `list()`,
`pending()` are the views; `refresh()` and `refreshPending()` re-read the
server; `approve(instanceId, expectedChallenge?)`, `reject`, `revoke`;
`setPushToken(provider, token)` and `clearPushToken()`. `approve` refuses to
sign when the challenge the UI showed is not the one on record, so a screen
should pass the challenge whose fingerprint the user checked.

`client.conversations` (`conversations/service.ts`): `list()` (most recent
activity first) and `get(id)`; `createDirect(accountId)` and
`createGroup(accountIds)`, both of which claim key packages for every trusted
instance of every member and post the group's first commit with the create;
`addMember`, `removeMember`, `leave`, `rename` (an encrypted `conversation`
message), `refresh()`.

`client.messages` (`messages/service.ts`): `timeline(id)`; `send(id, text,
{ replyTo })`, `edit`, `remove`, `react` (a toggle), `markRead` (local at
once, a `read` receipt at most every five seconds), `setTyping(id, on)`,
`isTyping(id)`, `loadOlder(id, before?)`, `unreadCount(id)`. `send` resolves
to the local key of the echo, which is also the idempotency key the server
sees; the item is `pending` until the server accepts it.

`client.media` (`media/service.ts`): `upload(conversationId, bytes, meta)`
encrypts, uploads and sends the `media` message, resolving to the local key;
when `meta.thumbnail` (`{ bytes, mime, width, height }`) is given, the
preview is encrypted under its own key, uploaded as a second blob and named
inside the same message, and the receiver's `MediaView.thumbnail.ref` fetches
it alone. `download(ref)` fetches, verifies and decrypts.

`client.sync` (`sync/engine.ts`): `state()` returns
`idle | syncing | live | offline | error`; `now()` runs a sync to
completion; `flush()` resolves once the outbox has drained.

`client.history` (`history/service.ts`): E2EE history transfer between
instances of one account (`crypto.md` section 14). `progress()` is the
`HistoryProgress` snapshot on topic `history`; `pendingOffers()` the offers
made to this instance as last listed, each a `HistoryOfferView` with the
SDK's `trusted` verdict on the donor; `refreshOffers()` re-lists;
`accept(offerId)` verifies the donor (an active, chain-verified instance of
this account whose key signed the manifest), opens the sealed key, and only
then downloads, decrypts and imports; `offerTo(instanceId)` exports this
instance's history to another active, verified instance. Nothing here is
needed in the ordinary case: the elector offers once it has added a newly
approved own instance to a group, and that instance accepts on its own; an
offer from anything but a verified same-account donor is left alone and
`accept` refuses it with `UntrustedInstanceError`.

`client.backup` (`backup/service.ts`): the encrypted account backup
(`crypto.md` section 15). `status()` is the `BackupStatus` snapshot on topic
`backup`; `refreshStatus()` asks the server whether a backup exists
(`status().remote`); `enable()` resolves to the 12-word recovery phrase ONCE
and stores only the key derived from it, after the first upload succeeded;
`refresh()` exports, encrypts and uploads now, replacing the previous backup
(the SDK also does this on its own after a sync once 20 events have landed or
24 hours have passed); `disable()` deletes the server copy and forgets the
key; `restore(phrase)` refuses a wrong phrase with `RecoveryPhraseError`
before downloading anything, refuses a backup not signed by an instance of
this account with `UntrustedInstanceError`, and otherwise imports and keeps
the key so refreshes continue from here. Every call requires an active
instance.

`client.subscribe(topic, listener)` and `client.onError(listener)` are the
event surface, below. `client.accountId` and `client.instanceId` are
properties.

### Event topics

The client is shaped for `useSyncExternalStore`: a topic emits a signal, the
getter returns a snapshot, and snapshots are cached by their owners and
replaced only on change, so React sees stable references between emissions.

| topic | emitted when | read with |
| --- | --- | --- |
| `instance` | this instance's state or record changed | `instance.state()`, `instance.current()` |
| `instances` | the account's instance list or pending list changed | `instance.list()`, `instance.pending()` |
| `conversations` | any conversation view changed (membership, name, last message, unread) | `conversations.list()`, `conversations.get(id)` |
| `timeline:<id>` | that conversation's timeline changed | `messages.timeline(id)` |
| `typing:<id>` | someone started or stopped typing there | `messages.isTyping(id)` |
| `sync` | the sync state changed | `sync.state()` |
| `history` | a history job changed phase or made progress, or the pending offers list changed | `history.progress()`, `history.pendingOffers()` |
| `backup` | the backup state, its remote status or its `busy` flag changed | `backup.status()` |
| `error` | an error was reported; `onError` receives it | |

### View models (`types.ts`)

`InstanceView` (id, account, app, platform, display name, public key,
status, `isThis`, approver, timestamps), `PendingEnrollmentView` (the
instance, the challenge, and its `fingerprint`), `ConversationView` (kind,
app, `title` from the encrypted name or `null`, member account ids, own
role, epoch, `joined`, `lastMessage`, `unreadCount`, activity time),
`TimelineItemView` (server id or local key, seq or `null`, sender account and
instance, `isOwn`, `sendState`, `content`, `reactions`, `replyTo`),
`TimelineContent` (`text`, `media`, `deleted`, `undecryptable` with a reason,
`system`), `MediaView` (with an optional `thumbnail: { ref, width, height }`)
and `MediaRef`, `UploadMediaMeta` (with an optional `thumbnail`),
`SendOptions`, `LoadOlderResult`.

`HistoryProgress` is `{ phase: idle | exporting | uploading | downloading |
importing, done, total, fromInstanceId?, toInstanceId? }`; `done` and `total`
count chunks while uploading or downloading and events while importing, and
`fromInstanceId` names the donor while receiving so a banner can say whose
history is arriving. `HistoryOfferView` is `{ id, donorInstanceId,
donorDisplayName (null when the donor is not in the listing),
conversationCount, eventCount, createdAt, expiresAt, trusted }`.
`BackupStatus` is `{ enabled, lastBackupAt, eventCount (events covered by the
last refresh), remote: { exists, updatedAt } | null (null until
`refreshStatus()`), busy }`.

`SendState` is `pending | accepted | delivered | read | failed`. `delivered`
is set when another account's encrypted `delivered` receipt covers the item
and `read` when its `read` receipt does; `read` is never downgraded, and a
receipt from one of the account's own instances moves nothing.

### Error classes (`errors.ts`)

Every error extends `AlloError` and carries a stable `code`, so a caller
branches on it rather than on a message, and none carries plaintext.

| class | code | meaning |
| --- | --- | --- |
| `EpochConflictError` | `epoch_conflict` | the server is at a newer epoch; the outbox re-syncs and retries on its own |
| `InstanceNotActiveError` | `instance_not_active` | a call that needs an active instance while this one is pending, revoked or unregistered |
| `NotImplementedError` | `not_implemented` | a documented later-phase API |
| `DecryptError` | `decrypt_failed` | the library or a digest refused the bytes |
| `FutureEpochError` | `future_epoch` | internal to sync: the message is ahead of the state and was queued |
| `TransportError` | `transport` | a non-2xx or a network failure; `status`, `serverCode`, `isNetwork`, `isRetryable` |
| `StorageError` | `storage` | the adapter failed, or a stored value did not authenticate or parse |
| `InvalidStateError` | `invalid_state` | a call the client's state does not allow |
| `NotFoundError` | `not_found` | no such conversation, message, media key, history offer, backup, or account with an instance |
| `UntrustedInstanceError` | `untrusted_instance` | a history donor or backup writer that is not an active, chain-verified instance of this account, or whose manifest signature does not verify; nothing from it is opened, downloaded or imported. Carries `instanceId` |
| `RecoveryPhraseError` | `invalid_recovery_phrase` | not a valid 12-word BIP39 phrase, or one whose derived key fails the backup's `keyCheck`; raised before any download and never carrying the phrase |

### The fake server, for tests

`import { testing } from "@allo/core"` exposes `createFakeAlloServer()`, an
in-memory implementation of the v1 contract (`testing/fakeServer.ts`) that
enforces the same rules the backend does: bootstrap enrollment, approval
signatures, key package claims, DM idempotency, per-conversation seq, epoch
compare-and-set, fan-out to leaves except the sender, welcome to recipients
only, per-instance delivery stream with cursors, blobs, socket nudges, the
transfer key route, history offers (same account, transfer key present, valid
manifest signature, one pending offer per donor and recipient, the
`history.offer` nudge) and the account backup. Every request body is validated with the shared-types zod schemas, so a drift
between SDK and contract fails a test here. It can inject faults per route
and take instances offline. Beside it are `MemoryStorage` (whose `dump()`
returns every stored byte, for "this must never be on disk" assertions),
`MemorySecrets`, `FakeSession`, `FakeSocket`, and `until` and `sleep`.

The package's own e2e suite runs multi-instance scenarios on it without
Postgres: a DM with edits, deletes, reactions, receipts and a rename; a
second device enrolled, approved and added by the elector; offline catch-up;
revocation; two concurrent adds resolving through one 409; restart from
persisted storage; a media round trip; a DM created twice; planted instances
with forged or absent signatures; registration recovery; push token
registration. `phase3.test.ts` adds, on the same server: a newly approved
device receiving the whole timeline from the elector and opening a media file
and its thumbnail while the server saw ciphertext only (t1); a forged manifest
signature and a donor that is not a verified same-account instance refused
before any download (t2); the fake server's offer rules (t3); a Phase 2
instance uploading its transfer key on start (t4); enable, refresh, every
device lost, a fresh install restoring with the phrase, and a wrong phrase
refused before any download (b1); a backup from a foreign or badly signed
writer refused, and the refresh policy (b2, b3); delivery receipts moving
`sendState` and `read` winning over `delivered` (d1, d2); and a thumbnail
round trip (m1). A consumer of `@allo/core` can run the same server in its
own tests.

## `@allo/react`

Plain React, no React Native and no DOM, so Expo consumes it on web and
native alike. `packages/react/src` as it stands:

**`AlloProvider({ client, mediaCacheSize? })`** puts one `AlloClient` in
context and owns two per-tree caches: an LRU of decrypted media bytes
(default capacity 50, with in-flight de-duplication so two components asking
for the same blob cause one download) and a tracker that remembers the last
`AlloError` reported while the instance was not active. It does not start the
client; the app calls `client.start()` once the Oxy session is known.
`useAlloClient()` returns the client and throws with a clear message outside
a provider.

Every hook is built on one primitive, `useSyncExternalStore` over a client
topic and the matching getter (`internal/useClientSnapshot.ts`).

| hook | returns | subscribes to |
| --- | --- | --- |
| `useInstanceState()` | `{ state, instance, error? }`; `error` is why the device is stuck while not active, cleared once it is | `instance`, the error tracker |
| `useOwnInstances()` | `{ instances, revoke, refresh }` | `instances` |
| `usePendingEnrollments()` | `{ pending, approve(id, expectedChallenge?), reject, refresh }` | `instances` |
| `useConversations()` | `ConversationView[]`, most recent first, each with its locally decrypted last message and locally computed unread count | `conversations` |
| `useConversation(id)` | one view or `undefined` | `conversations` |
| `useUnreadCount(id)` | a number | `conversations` and `timeline:<id>` |
| `useTotalUnread()` | the sum over every conversation | `conversations` |
| `useConversationActions()` | stable `createDirect`, `createGroup`, `addMember`, `removeMember`, `leave`, `rename`, `refresh` | nothing |
| `useTimeline(id, { pageSize? })` | `{ items, reachedStart, loadOlder, send, sendMedia, edit, remove, react, markRead, setTyping, typing }` | `timeline:<id>`, `typing:<id>` |
| `useMediaFile(ref)` | `{ status: idle \| loading \| ready \| error, bytes?, error? }` | the provider's media cache |
| `useSyncState()` | `idle \| syncing \| live \| offline \| error` | `sync` |
| `useHistoryTransfer()` | `{ progress, pendingOffers, accept(offerId), refresh }`; a screen normally only watches `progress` (the transfer banner), because the SDK offers and accepts on its own | `history` |
| `useBackup()` | `{ status, enable(): Promise<phrase>, refresh, disable, restore(phrase), refreshStatus }` | `backup` |
| `useAlloErrors(onError)` | nothing; calls back for every error the client reports | `onError` |

`useTimeline` shows the newest `pageSize` items (default 50) and anchors the
window at its oldest shown item, so new messages extend it at the new end
rather than pushing older ones out; `loadOlder()` moves the anchor back a
page, and `reachedStart` is true when nothing older can be shown, because
history before this device joined is not decryptable. `typing` is a boolean:
the protocol does not tell the SDK who is typing (`crypto.md` section 3).

Differences from the design brief's hook list (section 5 there): `approve`
lives on `usePendingEnrollments`, not `useOwnInstances`; `useMediaFile`
returns decrypted bytes rather than a platform file URI, so there is no
`MediaSink` adapter and the screen turns bytes into whatever its platform
draws; `useTimeline` exposes `typing: boolean`, not typing user ids;
`useUnreadCount`, `useTotalUnread`, `useConversationActions` and
`useAlloErrors` were added.

## How an app integrates

1. Provide the three adapters for its platform and construct one client with
   its own `appId`, `platform` and `displayName`.
2. Wrap the chat tree in `AlloProvider` and call `client.start()` when the Oxy
   session is known; call `client.reset()` on sign-out.
3. Gate the chat UI on `useInstanceState()`: `pending-approval` needs a screen
   that says which existing device can approve and shows nothing else;
   `revoked` needs a screen that says so. Both are states the client stays in
   without help.
4. Build a devices screen from `useOwnInstances()` and
   `usePendingEnrollments()`, showing the challenge fingerprint before
   `approve`.
5. Register the push token with `client.instance.setPushToken` once the
   platform issues one.
6. Resolve account ids to names outside the SDK.
7. Show a transfer banner in the conversation list while
   `useHistoryTransfer().progress.phase` is not `idle` ("Receiving history
   from <device>", the device named by `fromInstanceId`), and pass the
   rendered preview as `thumbnail` to `sendMedia`.
8. Build a backup screen from `useBackup()`: `enable()` shows the twelve
   words once with an explicit "I wrote them down" confirmation and the app
   never persists them; status, refresh now, and disable with a confirmation.
   Offer "Restore from recovery phrase" to a fresh active instance whose
   account has a remote backup (`status.remote.exists` after
   `refreshStatus()`), before the empty conversation list. A pending-approval
   instance cannot restore (`restore` requires an active instance), so that
   screen can only say a backup exists and that approval comes first. In Allo
   App these are specified (`app/(chat)/settings/backup.tsx`, the restore
   screen and the banner) and are being built alongside this change.

Allo App is the first consumer and is being cut over to this list; the ADR's
cutover checklist is where the lead records whether that is complete.

## Mention (Phase 4)

Mention integrates the same way: the same `@allo/core` and `@allo/react`, its
own `appId` (`mention`), and its own instance per installation, which is a
separate Ed25519 key, a separate approval chain entry and a separate MLS leaf
from any Allo instance on the same device. Two people who talk in both apps
have two conversations, two groups and two sets of keys (`concepts.md`,
AppSpace), because the DM key is per app.

Nothing beyond the `appId` field is built for this. App grants (which app
may show which conversation), the AppSpace registry, ConversationBinding and
unified thread views are designed in `concepts.md` and listed under Phase 4
in `roadmap.md`; the backend does not yet check that an instance's `appId`
matches a conversation's, and there is no route by which Mention could be
granted a view of an Allo conversation. Until those exist, Mention's chat is
an independent app space that happens to share the server and the SDK.
