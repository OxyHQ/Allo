# Schema conventions

The binding ledger for Allo's Postgres schema. Read this before touching
`src/db/schema/`. Decisions here are load-bearing; where one differs from a
sibling Oxy service, the difference is stated with its reason rather than left to
look like drift.

## Where the messaging schema is

The messaging tables that came through the Mongo → Postgres port
(`conversations`, `conversation_participants`, `messages` and its per-recipient
tables, `devices`, `device_pre_keys`, and every `bridge_*` table) were replaced
on 2026-09-17 (issue #139) as part of the clean break to the new messaging
engine. Their design, and the tables that took their place, are in
`docs/platform/`. The rules below survive the replacement and bind the new
tables too.

## Ids

`text` primary keys, supplied by the application. A row that predates the
cutover keeps its 24-character Mongo ObjectId hex verbatim; a row created after
it gets a uuid v7. There is no surrogate integer key except where a table's
design names one on purpose and documents why (a dense-ordered sync cursor is
the one legitimate case).

**Every table declares a bare `text().primaryKey()` with NO database default, so
every repository must generate the id itself** — call `uuidv7()` from
`@oxy.so/db` at the insert. `@oxy.so/db` also exports a `generatedId()` column
builder that attaches that generator as a runtime default; this schema
deliberately does not use it, because a backfill supplies the ORIGINAL id
verbatim and a column-level default is one more thing that has to be overridden
correctly on every one of those inserts.

An earlier revision of this sentence said a post-cutover row "gets a uuid v7 from
`generatedId()`", which no table does. Two agents independently hit it on their
first insert, which is the good case — the bad case is a reader who believes it
and never inserts anything. Recorded here rather than quietly fixed: `docs/` and
this ledger are the one place a wrong statement survives indefinitely, because
nothing executes them.

Every `oxyUserId`, `accountId`, `reporter`, `createdBy` and `userId` is a foreign
SERVICE's primary key — Oxy owns identity — so none of them carries a foreign
key. A FK there would claim this database can answer whether a person exists.

## Closed value sets are `text` + an explicit CHECK

`text({ enum })` emits **no DDL**. It narrows the TypeScript type and accepts
anything at all in the database. Every closed set therefore carries
`checkOneOf(...)` beside it, rendered from the SAME `as const` tuple that types
the column, so the two cannot drift. A pg `enum` is not used: adding a value to
one is a migration, and these sets change.

A tuple that another layer validates against is **imported**, never redeclared.
A second copy is the one way a value becomes addable in one layer and rejected
in another.

## Embedded documents: flattened, jsonb, or a child table

Three outcomes, chosen per case rather than by habit:

- **Flattened into prefixed columns** when the shape is fixed and the fields are
  read individually: `user_settings` (four settings documents → columns, so their
  defaults live in the schema instead of only in application code, and the two
  closed sets get CHECKs).
- **`jsonb`** when the format genuinely belongs to someone else and nothing
  queries inside it: `user_behaviors.preferences` (declared `Mixed`, no reader
  projects a field out of it), `moderation_events.payload` and
  `moderation_outbox.payload_decision` (a loose third-party contract, validated
  on READ so an event is never lost to a schema this deployment has not caught up
  with).
- **A child table** when entries have identity, state or history.

## Timestamps

`timestamptz` everywhere, asserted by a test that fails on any
`timestamp without time zone` in the schema: a zone-less timestamp is
reinterpreted in the session's `TimeZone` on every read, which silently changes
what the stored value means. `created_at` is a database default; `updated_at` is
maintained by the application, deliberately not a trigger, so a backfill or
repair write does not overwrite the historical value it exists to preserve.

## Rows with a deadline

Postgres has no TTL. A table whose rows carry an `expires_at` is reaped by
`src/db/expiry.ts` (`EXPIRY_SWEEP_TARGETS` + `runExpirySweep`), and it needs
BOTH the registry entry and a caller — a registry with no caller reaps nothing
and looks finished. Each entry states what deleting the row costs; the
`moderation_outbox` entry says outright that it destroys UNPROCESSED work, so a
dispatcher stalled for 90 days silently loses undelivered reports. Alerting on
outbox age has to fire long before that deadline and is not the sweep's job.

Every swept column carries a leading btree index, checked against the real
catalogue by `findUnsupportedExpiryColumns`: without one the sweep is a full
table scan on every run.

## Concurrency tests here are prone to passing vacuously

Two domains hit this independently while building their repositories, with
different mechanisms and the same symptom — a test that looks like the
concurrency test, and does not discriminate:

- **postgres.js opens connections on demand**, so the FIRST concurrent burst
  after a run of sequential queries queues onto the single open connection and
  executes strictly in order. That is exactly where a racing case sits in a test
  file. Measured: warm-pool first burst caught a read-then-write race 0/1,
  subsequent bursts 4/4, cold pool 4/5. Prime the pool before the burst, and
  prefer a deterministic detector (count statements through postgres.js's `debug`
  hook) over a race you have to win.
- **Dropping `SKIP LOCKED` leaves an N-way claim race GREEN.** Under READ
  COMMITTED a plain `FOR UPDATE` serialises concurrent claimers and each re-reads
  onto a different row, so every claimer still gets distinct work. Only a case
  that holds a lock while another claimer runs tells the two apart.

Keep the discriminating case AND say why, so it does not get deleted later as
redundant. Before trusting a concurrency assertion, break the thing it guards
and confirm it goes red.

## Protected columns

`protectedColumns.ts` names the columns that must never leave the process in a
response: `db.select().from(t)` returns every column. Read through
`publicColumns(table, PROTECTED_COLUMNS)`; the exclusion is at the TYPE level, so
a serializer that touches one fails `tsc` — **provided the registry stays
`as const`** and is never re-annotated with its own type, which would widen the
literals away and delete the compile-time half. A new table that stores
ciphertext, a credential or a third party's case material registers its columns
in the same change that creates it.

## Migrations

`drizzle-kit generate` writes the SQL; `src/db/migrate.ts` is the only thing that
applies it. Every file carries exactly one `-- oxy:deploy-phase=pre` or
`post` marker, with no default. `--phase=all` is for a from-zero genesis run
only. `pre` is additive and lands while the OLD image is still serving; `post`
drops and narrows and lands only once the new one has rolled — so a table
retired by a schema change is dropped by a `post` migration, and between the
schema change and that drop the database holds tables the barrel no longer
declares. The schema suite asserts only on the declared ones for that reason.

Anything drizzle-kit cannot express (a trigger, a partial index it did not
generate) is hand-written at the end of a migration, and drizzle-kit will
neither manage nor propose dropping it. A later migration that recreates the
table must recreate it too, and nothing in the tooling will say so. The
real-database suite is what would notice.
