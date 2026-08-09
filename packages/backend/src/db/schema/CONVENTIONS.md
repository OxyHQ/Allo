# Schema conventions

The binding ledger for Allo's Mongo → Postgres port. Read this before touching
`src/db/schema/`. Decisions here are load-bearing; where one differs from a
sibling Oxy service, the difference is stated with its reason rather than left to
look like drift.

## The database is `allo-production`, and the URI does not say so

`utils/database.ts` overrides the connection string's database with
`allo-${NODE_ENV}`. The production `MONGODB_URI` ends in `/allo`, so **anything
that trusts the URI connects to a database that does not exist** — the live
server has `allo-production` and no `allo` at all. A probe written the obvious
way reports zero collections and reads as "nothing to migrate".

Every probe, backfill and verification pass must pass the database name
explicitly. This cost nothing to discover only because the census was checked
against the live server rather than the URI.

## Ids

`text` primary keys, supplied by the application. A row that existed before the
cutover keeps its 24-character Mongo ObjectId hex verbatim, which is what lets
every existing reference survive the copy; a row created after it gets a uuid v7
from `generatedId()`. There is no surrogate integer key anywhere.

Every `oxyUserId`, `senderId`, `reporter`, `createdBy` and `userId` is a foreign
SERVICE's primary key — Oxy owns identity — so none of them carries a foreign
key. A FK there would claim this database can answer whether a person exists.

## Closed value sets are `text` + an explicit CHECK

`text({ enum })` emits **no DDL**. It narrows the TypeScript type and accepts
anything at all in the database. Every closed set therefore carries
`checkOneOf(...)` beside it, rendered from the SAME `as const` tuple that types
the column, so the two cannot drift. A pg `enum` is not used: adding a value to
one is a migration, and these sets change.

`BRIDGE_NETWORK_IDS` is **imported from `config/bridges.ts`**, not redeclared. It
is the same tuple the routes, the services and the Mongoose models validate
against, and a second copy is the one way a network becomes addable in one layer
and rejected in another.

`bridge_accounts.raw_state_event` deliberately has **no** CHECK. Mongoose typed
it `String` with no enum on purpose — it echoes the bridge's own vocabulary, and
refusing an unrecognised value would drop the status update that tells an
operator something changed.

## The two Mongoose hooks

Both were validation, and both are now the database's job. The rule applied:
*if the database can express it, delete the hook and let the constraint carry it
— re-expressing it in application code restores the race the hook never closed.*

### `Message.pre('save')` → a CHECK (`messages_content_present_check`)

"A message must carry encrypted content OR legacy plaintext" is a single-row
claim, so it is a plain CHECK. **This is why `encrypted_media` and `media` stay
`jsonb` columns on `messages` rather than becoming child tables**: the moment
either becomes a child table, the invariant is cross-row and can no longer be a
CHECK. That trade was made deliberately and in this direction, because the
constraint we most want to be structural is only structural if the media stays
on the row. Neither column is ever queried inside, and both are opaque envelopes
around ciphertext this service cannot read, so nothing is lost by keeping them
whole. A companion CHECK pins both to `jsonb` arrays so `jsonb_array_length`
cannot error.

The hook also `console.warn`ed when a message had ciphertext AND plaintext. That
enforced nothing, so it is **dropped, not translated** — and the CHECK
deliberately permits the combination. Refusing it would be a new restriction,
discovered in production by whatever legacy row already has both.

### `Conversation.pre('save')` → a deferred constraint trigger

"A `direct` conversation has exactly 2 participants", and the schema-level "at
least 2" validator beside it, are **cross-row** once participants are their own
table — and participants must be their own table: they carry per-person state
(`role`, `last_read_at`, `unread_count`, `archived_at`) and are the thing the
conversation list is queried by.

So the database still expresses it, just not as a CHECK:
`conversations_participant_count_check` and
`conversation_participants_count_check` are `CONSTRAINT TRIGGER`s declared
`DEFERRABLE INITIALLY DEFERRED`. Deferral is not a detail — an IMMEDIATE trigger
rejects every conversation ever created, because the conversation row
necessarily exists for a moment before its participants do. That claim is
mutation-tested: flipping the migration to `INITIALLY IMMEDIATE` turns 10 tests
red, including the one that creates an ordinary two-person conversation.

This **closes a race the hook never did**. `pre('save')` ran in the application
against the document in memory, so two concurrent writes could each remove a
different participant from a two-person conversation and both pass. The trigger
counts under the transaction's own visibility at commit, and refuses one of them.

Deletion is deliberately silent: `ON DELETE CASCADE` fires the participant
trigger with the conversation already gone, and a check that raised then would
make deleting a conversation impossible.

## Embedded documents: flattened, jsonb, or a child table

Three outcomes, chosen per case rather than by habit:

- **Flattened into prefixed columns** when the shape is fixed and the fields are
  read individually: `user_settings` (four settings documents → columns, so their
  defaults live in the schema instead of only in application code, and the two
  closed sets get CHECKs), `bridge_accounts.remote_profile`/`raw_state`,
  `devices.signed_pre_key`, `conversations.last_message`.
- **`jsonb`** when the format genuinely belongs to someone else and nothing
  queries inside it: `user_behaviors.preferences` (declared `Mixed`, no reader
  projects a field out of it), `moderation_events.payload` and
  `moderation_outbox.payload_decision` (a loose third-party contract, validated
  on READ so an event is never lost to a schema this deployment has not caught up
  with), and the two message media arrays (see above).
- **A child table** when entries have identity, state or history:
  `conversation_participants`, `message_reads`, `message_deliveries`,
  `message_reactions`, `device_pre_keys`, `bridge_proxy_lease_rotations`.

Three Mongo `Map`s collapse into child rows or onto an existing one, because all
three were keyed by a participant who is already in the conversation:
`unreadCounts` and `archivedBy` become columns on `conversation_participants`
(making "a user who archived a conversation they are not in" unrepresentable),
and `readBy`/`reactions` become their own tables with the unique index the Map
got for free from its key.

`bridge_proxy_leases.rotations` is the clearest child-table case: it is
append-only evidence of when an exit identity changed and why, which is what an
embedded array is worst at — nothing stops a write replacing the whole array and
erasing the history it exists to keep.

## Foreign keys, and the two places there deliberately is none

`ON DELETE CASCADE` from `conversations` → `messages` → the three per-recipient
tables. **Mongo could not express this**: deleting a conversation orphaned its
messages and nothing ever collected them. Cascading is right for an encrypted
messenger — ciphertext without its conversation's session state is unreadable, so
keeping it is retention without a purpose.

`bridge_link_sessions.result_account_id` → `bridge_accounts` is
`ON DELETE SET NULL`: the session is the record of an ATTEMPT and must outlive
the account it produced, but must not point at one that no longer exists. In
Mongo it was a bare `ObjectId` with no `ref` — a pointer nothing checked.

- `messages.reply_to` is **not** a FK. It points at a message that may already be
  deleted, and Mongo's `ref` never enforced it, so a FK here would be a new
  restriction introduced by the port.
- `conversations.last_message_*` is **not** a FK. It is a denormalised preview
  that must survive its message being deleted — exactly when a FK would either
  block the delete or null the preview out.

## Timestamps

`timestamptz` everywhere, asserted by a test that fails on any
`timestamp without time zone` in the schema: a zone-less timestamp is
reinterpreted in the session's `TimeZone` on every read, which silently changes
what the stored value means. `created_at` is a database default; `updated_at` is
maintained by the application, deliberately not a trigger, so a backfill or
repair write does not overwrite the historical value it exists to preserve.

## The three TTL indexes

`moderation_events`, `moderation_outbox` and `bridge_link_sessions` each carried
`{ expiresAt: 1 }, { expireAfterSeconds: 0 }` in Mongo. **All three were
confirmed present on the live server**, so Mongo really was reaping — a declared
index only exists if `autoIndex` ran, and `utils/database.ts` sets it.

Postgres has no TTL. The replacement is `src/db/expiry.ts`
(`EXPIRY_SWEEP_TARGETS` + `runExpirySweep`), and it needs BOTH the registry and a
caller — a registry with no caller reaps nothing and looks finished. Each entry
states what deleting the row costs; the `moderation_outbox` entry says outright
that it destroys UNPROCESSED work, so a dispatcher stalled for 90 days silently
loses undelivered reports. Alerting on outbox age has to fire long before that
deadline and is not the sweep's job.

Every swept column carries a leading btree index, checked against the real
catalogue by `findUnsupportedExpiryColumns`: without one the sweep is a full
table scan on every run — the cost Mongo's TTL index hid.

## Protected columns

`protectedColumns.ts` replaces Mongoose `select: false` and
`routes/devices.ts`'s `.select("-preKeys")`, neither of which survives the port:
`db.select().from(t)` returns every column. Read through
`publicColumns(table, PROTECTED_COLUMNS)`; the exclusion is at the TYPE level, so
a serializer that touches one fails `tsc` — **provided the registry stays
`as const`** and is never re-annotated with its own type, which would widen the
literals away and delete the compile-time half.

## Migrations

`drizzle-kit generate` writes the SQL; `src/db/migrate.ts` is the only thing that
applies it. Every file carries exactly one `-- oxy:deploy-phase=pre` or
`post` marker, with no default. `--phase=all` is for a from-zero genesis run
only.

The two constraint triggers are **hand-written at the end of the genesis
migration**, because drizzle-kit cannot express a trigger. drizzle-kit does not
manage them either, so it will not propose dropping them — but a future
migration that recreates `conversations` or `conversation_participants` must
recreate them too, and nothing in the tooling will say so. The real-database
suite is what would notice.

## The Mongo → Postgres table map

| Mongoose model | Table(s) |
|---|---|
| `Block` | `blocks` |
| `Restrict` | `restricts` |
| `UserBehavior` | `user_behaviors` |
| `UserSettings` | `user_settings` |
| `Device` | `devices`, `device_pre_keys` |
| `Conversation` | `conversations`, `conversation_participants` |
| `Message` | `messages`, `message_reads`, `message_deliveries`, `message_reactions` |
| `Report` | `reports` |
| `ModerationEvent` | `moderation_events` |
| `ModerationOutbox` | `moderation_outbox` |
| `BridgeAccount` | `bridge_accounts` |
| `BridgeLinkSession` | `bridge_link_sessions` |
| `BridgeProxyLease` | `bridge_proxy_leases`, `bridge_proxy_lease_rotations` |

Thirteen models, nineteen tables. The live database also holds a `pushtokens`
collection with **no model and no table here**: `models/PushToken.ts` was
deliberately deleted when push moved to Matrix's pusher registry (see
`config/push.ts`), and the empty collection is what it left behind. It is not an
omission, and it must not be ported.
