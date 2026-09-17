# Allo Platform concepts

The conceptual contract from issue #139 sections 5, 6, 8, 9 and 15 to 20. Each
section states the rule and its status: `built in this change` means the
lead's design for branch `feat/allo-platform-clean-break` specifies it and the
lead verifies it in the tree before merge; `designed, not built` means it is a
commitment for a later phase. Routes and payloads are in `api-v1.md`; this
document does not restate them.

## 1. Conversation

The canonical stream of encrypted events with a set of participants, a
membership, and a policy. One Conversation is one MLS group. Kinds: `dm` and
`group`. A DM is idempotent per app and account pair. The server knows the
members, the epoch, and the sequence of events; it does not know the name,
which is an encrypted application message.

Status: built in this change.

## 2. AppSpace

The context an experience exists in: Allo, Mention, another Oxy app. Every
conversation and every client instance carries an `appId`. Two conversations
between the same two people in different app spaces are different
conversations with different groups and different keys.

Status: the `appId` field exists on conversations and instances (built in
this change); an AppSpace registry, app grants and per-app authorization
(Phase 4) are designed, not built.

## 3. ConversationBinding

The authorization for a specific application to show and use a specific
conversation. Adding an app as an endpoint changes who can decrypt: it means
that app's instances become leaves of the group. Therefore a binding is an
explicit, user-understood action, never an inference.

Status: designed, not built (Phase 4).

## 4. UnifiedThreadView

A user preference that presents several conversations together in the UI. It
is presentation only. It never merges groups, shares keys, or moves members.

Status: designed, not built (Phase 4).

## 5. ClientInstance

Every authorised installation is an independent cryptographic instance. There
is no primary phone. Fields:

| Field | Meaning |
|---|---|
| `id` | Installation id, assigned by the server on registration |
| `accountId` | The Oxy account it belongs to |
| `appId` | The AppSpace it was installed for (`allo`, `mention`, ...) |
| `platform` | `ios`, `android`, `web`, `desktop` or `node` |
| `displayName` | Human label for the devices screen |
| `signingPublicKey` | Raw Ed25519 public key; the private half never leaves the instance |
| `status` | `pending`, `active` or `revoked` |
| `enrollmentChallenge` | One-time challenge while pending; cleared on resolution |
| `approvedByInstanceId`, `approvalSignature` | The credential: which active instance approved this one and its signature; null for the bootstrap instance |
| `enrolledAt`, `revokedAt`, `lastSeenAt` | Lifecycle timestamps |
| `pushProvider`, `pushToken` | Optional push registration for this instance |

Conversation scope per instance is expressed by leaves: an instance is in a
conversation when it has an active leaf in that group.

Status: built in this change.

## 6. Enrollment

Issue section 8 steps, mapped to the API (details in `api-v1.md`):

| Step | Mechanism |
|---|---|
| 1. User signs in with Oxy | Oxy session; the SDK takes an Oxy session adapter |
| 2. The installation generates keys locally | `@allo/core` creates an Ed25519 signing key and MLS key packages; private parts stay in the instance's secret store |
| 3. It requests authorisation with a one-time challenge | `POST /v1/instances` returns `pending` and a random challenge when the account already has an active instance |
| 4. Another authorised instance approves | An active instance signs the challenge, new id and new public key and calls `POST /v1/instances/:id/approve`; any active instance may approve, no specific device is required |
| 5. Allo records the public credential | The approver id and approval signature are stored on the instance and served to other accounts |
| 6. Authorised conversations incorporate the new instance | The account's lowest-id active leaf in each conversation claims a key package and commits an Add; the new instance joins from the welcome |
| 7. What history it can recover is decided separately | See section 7; not built |

Bootstrap: an account with zero active instances gets an active instance on
registration (trust on first use). Its weakness is in
`threat-model.md` section 4. The self-custodied recovery mechanism that could
approve instead is designed, not built.

A valid login by itself does not let the server create an endpoint that can
decrypt: the server never holds key package private parts and cannot author a
welcome.

Status: built in this change (steps 1 to 6); step 7 designed, not built.

## 7. History versus live state

Three separate concerns (issue section 9):

1. **Receiving future messages.** Being an active leaf. Built in this change.
2. **Joining the current state of the conversation.** The MLS welcome at the
   epoch of the add. Built in this change.
3. **Recovering old messages.** An encrypted history archive independent of
   the live group state: the server stores encrypted events, authenticated
   manifests and encrypted blobs and holds no key to them; a new instance gets
   history by an E2EE transfer from another active instance or from a backup
   unlocked by user-held recovery material. Designed, not built (Phase 3).
   `@allo/core` exposes the history module as a stub that throws
   `NotImplemented`.

Live cryptographic state is never cloned from one installation to another. A
new installation is a new instance. If every instance and all recovery
material is lost, part of the history is irrecoverable, and the product says
so.

## 8. Unified view rules

Issue section 15. The UI may show one person's Allo, Mention and (later)
external-network conversations as separate rows or as one grouped card.
Internally they remain distinct conversations unless a real shared thread
exists. Rules:

- Always show the destination before sending.
- Reply by default to the origin of the message being replied to.
- Preserve remote and canonical ids.
- Never invent receipts or deletions a network does not support.
- Never mix members of different groups.
- Never share keys because two threads are grouped visually.

Status: designed, not built (Phase 4). Nothing in this change draws a grouped
view.

## 9. Media rules

Issue section 16. Every native attachment is encrypted before upload with a
random per-file key and authenticated integrity; thumbnails are encrypted the
same way; filenames, sizes, mime types and captions travel inside the E2EE
message; object storage sees ciphertext only; URLs carry no key; orphaned
blobs are garbage collected; sizes are capped.

Status: built in this change for upload, download, per-file keys, encrypted
thumbnails, GC and size limits. Resumable uploads and downloads and quotas are
designed, not built. A private Oxy Cloud URL is not E2EE on its own and is not
used for chat media.

## 10. Push rules

Issue section 17. Push carries the minimum: a conversation and event
reference and no content. The notification body is "New message". Push does
not replace durable delivery and sync; the sync cursor is the truth.

Status: built in this change for FCM and APNs. Client-generated safe previews
(iOS Notification Service Extension, Android background service) are
designed, not built. There is no web push.

## 11. Search rule

Issue section 18. Search runs locally over decrypted content inside the
protected local store. Conversation plaintext is never sent to Mention
search, Oxy search, analytics, remote embeddings or automated moderation.
Remote private search, if ever wanted, is a separate design.

Status: the rule is binding on every consumer of `@allo/core` from this
change on. Local search itself is designed, not built.

## 12. Client storage rules

Issue section 19.

- Native: a transactional local database, encrypted, with the storage key in
  the OS secret store; behaviour under backup, reinstall and biometrics
  documented; no large history in AsyncStorage.
- Web: IndexedDB for state and ciphertext, key wrapping through a validated
  mechanism, isolation per account, app and installation, CSP and Trusted
  Types with minimal third-party JS, and no claim that non-extractable keys
  protect against malicious JS served by the origin.
- Account switching: everything namespaced by account and installation;
  closing or switching an account exposes no cache, preview or key of the
  previous one.

Status: built in this change for the encrypted store (AES-256-GCM at rest
with a random storage key in the platform secret store), the SQLite and
IndexedDB adapters, and namespacing by account, app and instance. CSP and
Trusted Types hardening and the documented backup and reinstall behaviour are
designed, not built.

## 13. Connector boundary

Issue section 20. Connectors to external networks are a layer separate from
the Allo protocol. Per network, the order of preference is a direct library
or protocol, then adapting an existing bridge where it makes sense, and an
isolated Matrix island only with a concrete reason, never as a second backend
for native chat.

The connector contract covers login and logout, status, capabilities,
incoming and outgoing messages, media, edits, reactions, receipts, history
cursor, identity mapping, idempotency and error states.

Trust boundary: a bridge that speaks to WhatsApp or Telegram must see content
to translate it. A local runner gives the best privacy; a user-operated node
runs under the user's trust; a cloud runner operated by Oxy is an endpoint
Oxy can read. A cloud bridge is never described with the words "Oxy cannot
technically read this". Native Allo chat keeps that property; bridged rooms
show the network's mark and never a padlock.

Status: designed, not built (Phase 5). The Matrix-bound bridge code is
removed in this change and nothing replaces it yet.
