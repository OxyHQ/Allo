# Allo Platform threat model

Scope: native Allo conversations on the v1 platform (MLS groups relayed by
the Allo backend). External-network connectors are out of scope here; their
trust boundary is stated in `concepts.md`. Everything marked "not built" is
a design commitment for a later phase, not a property of the current tree.

Related: `docs/adr/0001-clean-break-platform.md`, `concepts.md`, `api-v1.md`,
`crypto.md` (MLS details, written after the spike), `roadmap.md`.

## 1. Assets

| Asset | Where it lives | Who may see it |
|---|---|---|
| Message plaintext (text, edits, deletions, reactions, read receipts, group names) | Only inside client instances, decrypted from MLS application messages | Members' active instances |
| Media plaintext | Only inside client instances; a per-file random key and nonce travel inside the E2EE `media` message | Members' active instances |
| MLS group state and epoch secrets | Each instance's local encrypted storage | The instance that holds it |
| Instance signing key (Ed25519) | The platform secret store of one instance (SecureStore on native, IndexedDB-wrapped on web) | That instance only |
| Local storage key (AES-256-GCM at rest) | Same secret store | That instance only |
| Key package private parts | Instance local storage | That instance only |
| Transfer private key (X25519) | The same secret store; the public half is registered with the instance and published | That instance only; a donor seals an archive key to the public half |
| Archive key (a fresh random 32-byte key per history offer) | The donor's memory for the length of the offer; on the server only HPKE-sealed to the recipient's transfer key | The donor and the one recipient |
| Backup key (derived from the recovery phrase) | The secret store of every instance that enabled or restored the backup; on the server only as a key check (an HMAC of a fixed string) | Those instances, and whoever holds the phrase |
| Recovery phrase (12 BIP39 words) | The user, and nowhere else: returned once by `enable()`, never persisted or logged by the SDK, and specified never to be persisted by the app | The user |
| History archive plaintext (decrypted timelines, conversation metadata, media keys) | Only on a device, before encryption and after decryption; on the server as chunked AES-256-GCM ciphertext under the archive or backup key | The account's own instances that produced or opened it |
| Membership metadata (which accounts and instances are in which conversation, roles, epochs) | Backend Postgres, in the clear | Backend, and members through the API |
| Delivery and presence metadata (who sent an event, when, to which instances, online state, typing activity) | Backend Postgres and Socket.IO rooms | Backend; presence and typing are relayed to members |
| Push tokens | `client_instances` row | Backend |

The backend holds ciphertext, sizes, timestamps, identifiers and public keys.
It holds no key that opens any ciphertext: the sealed archive key opens only
with a recipient's transfer private key, and the backup key check is an HMAC
that verifies a key without containing it.

## 2. Actors

| Actor | Capability assumed |
|---|---|
| Curious or compromised Allo backend | Reads every table and blob; can drop, delay, reorder or replay events; can forge control events and API responses. |
| Attacker with a stolen Oxy token | Can call the Oxy-only routes as the account: list instances, register a new (pending) instance. Cannot sign as an existing instance, and so cannot read the backup record or a history offer, both instance-signed routes. |
| Attacker with the recovery phrase | Holds what derives the backup key. Alone it opens nothing: the backup is fetched by an instance-signed route, so the attacker also needs an active instance of the account (an Oxy session and either an approval or the bootstrap window). With both, reads the whole archived history. |
| Attacker with a stolen device or a copy of its storage | Has whatever the OS credential and secret store released. |
| Malicious other member | Is a legitimate MLS member: reads everything sent to the group, can add or remove per the server's authorization rules, can leak content. |
| Our own delivery service acting as a malicious homeserver equivalent | Same as the compromised backend, specifically: tries to insert a member or an instance into a group. |
| Network attacker | Sees and alters traffic between client and backend outside TLS, or terminates TLS at a compromised edge. |
| Malicious JavaScript on the web origin | Runs with the page's authority on `allo.you`: reads IndexedDB, calls WebCrypto with the page's keys, reads decrypted DOM. |

## 3. What MLS gives

- Confidentiality of application messages to the group's members at the
  sending epoch. The server relays opaque `PrivateMessage` bytes.
- Forward secrecy and post-compromise security at the granularity of epochs:
  a commit rotates the group secret, and every add, remove and update is a
  commit. An attacker who obtains an instance's state at epoch N cannot read
  earlier epochs it never held, and loses access after the next commit that
  removes the instance or updates its leaf.
- Member authentication: every leaf carries a credential. In this design the
  credential is a basic credential naming `${accountId}:${instanceId}`, and
  the leaf's signature key is checked by MLS on every handshake message.
  Binding that credential to a real Allo instance is the job of the instance
  model below, not of MLS alone.
- Group membership is agreed by the members, in the group. The server cannot
  add a leaf: an add is a commit plus a welcome authored by an existing
  member's instance, and a leaf that was never welcomed holds no secrets.

MLS does not give: history for instances that joined later, backup, push
content, identity binding to Oxy accounts, sync, or media.

## 4. What the instance model gives

- **Request signing bound to instance keys.** Every route that touches a
  conversation, a key package, sync or a blob carries `X-Allo-Instance`,
  `X-Allo-Timestamp` and an Ed25519 `X-Allo-Signature` over the method, path,
  timestamp and body hash. The server verifies against the instance's stored
  public key, rejects clock skew over five minutes, revoked or unknown
  instances, and instances not owned by the token's account. The Socket.IO
  handshake carries the same three fields. An Oxy token without the
  instance's private key can do nothing inside a conversation.
- **Enrollment approval by an existing instance.** A second and later
  installation registers as `pending` with a one-time challenge and becomes
  `active` only when an already active instance signs
  `accountId, newInstanceId, newSigningPublicKey, challenge`. The approving
  instance's id and signature are stored on the new instance and returned to
  other accounts by `GET /v1/accounts/:accountId/instances`, so a member
  adding somebody's instances can check the chain rather than trust the
  server's list.
- **TOFU bootstrap of the first instance, and its weakness.** When an account
  has zero active instances, registration is `active` immediately. That is
  trust on first use: whoever holds a valid Oxy token at that moment and has
  no competing active instance becomes the root of the account's approval
  chain. The window is exactly "no active instance exists", which includes a
  user who revoked or lost every device. The mitigation in this design is
  visibility (other members see an unapproved root instance in the chain and
  the account owner sees it in the devices screen); a self-custodied recovery
  mechanism that can approve instead is designed and not built. The Phase 3
  recovery phrase unlocks the backup and approves nothing.
- **Revocation.** Any active instance of the account, or the instance itself,
  can revoke an instance. The server marks it revoked, refuses its signature
  from then on, disconnects its sockets, marks its leaves removed pending, and
  appends an `instance_revoked` control event. An active leaf commits a
  Remove, after which the revoked instance holds no secret for the next epoch.
  Between revocation and that commit the revoked instance can still decrypt
  events of the current epoch it receives by other means; it no longer
  receives them from the server.
- **History only from a verified instance of the same account.** A new
  instance receives an offer's archive key sealed to its own transfer key,
  and its SDK accepts an offer only after it has verified, from the listing
  and never from the server's word, that the donor is an active instance of
  this account whose approval chain checks out and whose published key signed
  the manifest; the server checks the signature too, so a forged offer never
  reaches an inbox. A backup is restored only after the phrase's derived key
  passes the key check and the writing instance's signature verifies the same
  way. Neither path carries MLS state: the archive holds decrypted messages
  and media keys, and a new leaf still joins from its Welcome
  (`crypto.md` sections 12 to 15).

## 5. What the server can still see

- Who talks to whom: conversation membership, roles, and which accounts share
  which conversations.
- When and how much: event timestamps, sequence numbers, ciphertext sizes,
  epochs, per-instance delivery and ack times.
- The membership graph across all users and its evolution over time.
- Blob sizes, upload times, uploader instance, and which events reference
  which blobs (declared by the sender for garbage collection).
- Presence: which accounts have a device beating right now, when each was last
  connected (to the minute, in `account_presence`), and which accounts each
  socket asked to WATCH — that last one is a screen's contents, and is new with
  ADR 0002. The rules in `presence.ts` bound what other USERS see; they bound
  nothing about the operator, who computes all of it.
- Status updates: that one exists, who wrote it, WHICH DEVICES it was sealed
  to — the audience, which the server necessarily learns in order to deliver,
  as WhatsApp's and Signal's do — its size, its deadline, which blobs it names,
  and who viewed it. Not the words, the picture, or the key: the body is
  AES-256-GCM under a key that reaches each device HPKE-sealed to its transfer
  key. A viewer whose receipts are off is counted and not named, and the author
  cannot tell a missing name from somebody who did not look.
- The existence and timing of typing traffic; typing payloads themselves are
  MLS application messages the server cannot read and does not store.
- Push tokens and which instance is on which platform and app.
- DM pairing: `dm_key` is `${appId}:${accountA}:${accountB}` in the clear so
  DMs are idempotent.
- History offers: that one exists, which instance offered to which and when,
  when it was consumed or expired, the manifest in the clear (its kind, the
  number of conversations and events, the chunk blob ids, the plaintext
  digest and creation time), the chunk sizes (so the approximate size of the
  account's history) and the sealed key, which is opaque. Not the
  conversation ids, members or content, nor any media key.
- Backups: that the account has one, which instance wrote it and when, how
  often it is refreshed (the refresh policy leaks roughly how much the account
  talks: a refresh after every 20 events or 24 hours), the same manifest
  fields and chunk sizes, and the key check, which reveals nothing without
  the key. Whether the phrase was ever typed anywhere, and a wrong phrase
  being refused, are decided on the device and never reach the server.

This metadata is the price of a server-relayed design and is not hidden from
the operator. Group names are not in this list: they are E2EE messages.

## 6. What is NOT defended

- **A compromised endpoint.** Root, malware, a screen reader or a screenshot
  on a member's device reads plaintext after decryption. Encryption is end to
  end, not end to eye.
- **Malicious JavaScript on the web origin.** A script served by `allo.you`
  (supply chain, XSS, a compromised deploy) runs with the page's authority
  and can use the instance key and the storage key. Non-extractable WebCrypto
  keys do not prevent this; they only stop export. CSP and Trusted Types
  narrow the surface (designed, not built).
- **Metadata.** Section 5 in full.
- **Traffic analysis.** Sizes and timing of ciphertext and of socket nudges.
  No padding or cover traffic is planned.
- **Losing every instance and the recovery phrase.** History is
  irrecoverable by design. The server holds chunks encrypted under a key
  derived from the phrase and never had the key; there is no reset that can
  produce plaintext. A backup that was never enabled is the same loss.
- **A stolen recovery phrase together with an active instance.** The phrase
  is the whole secret of the backup; nothing on the server rate-limits or
  notices its use, because the key check is verified on the device. The
  attacker still needs an active instance of the account to fetch the backup,
  which is the enrollment approval or the trust-on-first-use window above.
  The phrase approves nothing and cannot revoke, and `disable()` from any
  active instance deletes the server copy.
- **A compromised donor instance.** The elector offers a new own instance its
  history automatically once it has added it. A malicious own instance (one
  that was approved) can therefore hand a new one a doctored archive; the
  signature proves who wrote it, not that it is true. The reverse, a
  stranger's instance offering, is refused before download.
- **A malicious member.** MLS authenticates members; it does not stop one from
  leaking, screenshotting or running a modified client.
- **Denial of service by the backend.** It can refuse to relay, drop
  deliveries or lie about membership state. Clients detect gaps and epoch
  mismatches and refuse to send in a state they cannot account for; they
  cannot force delivery.
- **Identity at the human level.** The platform proves an instance belongs to
  an Oxy account id. That the account is the person the user thinks it is
  remains Oxy's and the user's problem. Out-of-band fingerprint comparison for
  instances is designed for the devices screen and not built beyond showing
  the challenge fingerprint at approval.

## 7. Residual risks and acceptance tests

Statuses: `met by design` (the design specifies the mechanism; the lead
verifies it in the tree), `open` (not built in this change).

### E2EE (issue section 23)

| Acceptance test | How the design meets it | Status |
|---|---|---|
| Backend DB contains no plaintext for new chats | `conversation_events.payload` is MLS ciphertext or server-authored control JSON that carries ids only; no `text` or preview column exists in the new schema. Names, receipts, reactions are application messages. | met by design |
| Blobs contain no plaintext media | Files are encrypted client-side with a random per-file key before `POST /v1/blobs`; the key travels inside the E2EE `media` message; thumbnails likewise. | met by design |
| Logs and push contain no content | Logger sanitiser redacts ids, tokens, urls; push body is the literal "New message" with `{ conversationId, eventId }`. | met by design |
| A stolen Oxy token cannot decrypt history | Instance-signed routes refuse a token alone; a new instance registered with the token is `pending` until an active instance approves it, and even when active it receives only events from the epoch it is welcomed at. The TOFU window (no active instance) remains the exception and is documented in section 4. | met by design, TOFU exception open |
| Server cannot silently add a reader | Adds are commits plus welcomes signed by a member instance; the server has no key package private part and cannot author a welcome. It can fabricate membership rows and control events, which clients treat as metadata, never as keys. | met by design |
| Key substitution is detectable or rejected | Instance public keys are stored once; `(account_id, signing_public_key)` is unique; approvals are signed by an existing instance over the new key and the challenge, and the challenge is published once the instance is approved. `@allo/core` verifies the whole chain up to the bootstrap root before it claims a key package, and the approving device and the pending device both display the same challenge fingerprint for an out-of-band comparison. | met by design and by test (core `signing.test.ts`, e2e (i)); the bootstrap instance itself is trust-on-first-use |

### Multi-device (issue section 23)

| Acceptance test | How the design meets it | Status |
|---|---|---|
| Three installations send and receive with the first switched off | Every active instance is its own MLS leaf; the sender's device is not needed for anybody else's delivery. Core test scenario "3 instances / 2 accounts exchange". | met by design |
| Messages sent from one device appear on the user's other devices | The sender's other instances are leaves of the same group and receive the same fan-out. | met by design |
| Revoking an installation cuts future access | Section 4, revocation: signature refused, sockets dropped, Remove commit at the next epoch. | met by design |
| A new installation recovers only the permitted history | It decrypts live traffic from its welcome epoch onward. Old messages reach it only through an offer whose donor it verified as an active, chain-verified instance of the same account with a valid manifest signature, opened with its own transfer key, or through the account's backup with the recovery phrase, refused before download on a wrong phrase or a foreign writer. A pending-approval instance recovers nothing until approved. | met by design and by test (core `phase3.test.ts` t1, t2, b1; backend `history.realdb.test.ts`, `backups.realdb.test.ts`; integration `phase3.realdb.test.ts` in this change) |
| Desktop is first class without a primary phone | Approval can be given by any active instance; `platform` admits `desktop` and `node`; nothing in the API distinguishes a phone. | met by design |
