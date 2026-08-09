# Mongo claims ledger — what the messaging switch has to correct

Every statement below is **true today** and becomes **false** the moment the
messaging domain moves to Postgres and Mongo comes out. They are listed here so
the messaging PR carries a checklist instead of a discovery task, and so each
claim is corrected in the same change that falsifies it rather than months later.

This exists because of what the already-migrated Oxy repos looked like
afterwards. In oxy-api a comment describing a Mongo recompute had flowed into
the published `openapi.json`; in Syra an always-loaded `AGENTS.md` was still
instructing agents to use a helper deleted three domains earlier; in Homiio the
onboarding guide had new contributors install MongoDB and start `mongod` against
a backend that exits without `DATABASE_URL`, while CI downloaded 200 MB of
`mongod` for an uninstalled package. None of that was caught by a source-level
guard, because comments and markdown are exempt from those — deliberately and
correctly. A ledger is the thing that catches it.

**How to use this:** work top to bottom in the messaging PR. Anything you cannot
correct in that PR belongs in a follow-up issue, not left silent. Delete a row
once it is done, and delete this file when the last row goes.

---

## 1. Code — the five files that still reach Mongo

`mongoose` is imported by exactly these, and this set IS the messaging switch's
surface. Verified by `grep -l mongoose` over `packages/backend/src/`; note both
quote styles, since a single-quote-only grep misses `models/Message.ts`.

| File | What it is |
|---|---|
| `models/Conversation.ts` | messaging model |
| `models/Device.ts` | messaging model |
| `models/Message.ts` | messaging model |
| `routes/messages.ts` | imports the models AND a `mongoose` type (`QueryFilter`) |
| `utils/database.ts` | the Mongo connection, and `isDatabaseConnected()` |

Their Postgres counterparts already exist and are deliberately **unused**:
`db/messaging/{conversationRepository,deviceRepository,messageRepository}.ts`
and `db/schema/{conversations,devices,messages}.ts`.

**All three messaging routes import the Mongoose models DIRECTLY, not through a
repository** — `routes/conversations.ts` (`Conversation`, `Message`),
`routes/devices.ts` (`Device`) and `routes/messages.ts` (both, plus the
`mongoose` type). So the switch is a route-by-route rewrite onto the existing
repositories, not a swap behind an interface that is already in place. Only
`routes/messages.ts` shows up in a `grep mongoose`, which understates the work by
two files — count the model imports, not the driver imports.

**`isDatabaseConnected()` has no callers.** It is the vestige of a
database-availability guard the docs described and the code does not have (see
row 4.2). Delete it with the connection, or wire it — but do not leave it.

## 2. Always-loaded instruction files — correct these FIRST

An `AGENTS.md` is loaded into every agent's context by construction, so a stale
claim there is acted on rather than merely read.

| Location | Claim, true today | After the switch |
|---|---|---|
| `AGENTS.md` §Architecture | `Express / drizzle + Mongoose / Socket.io` | drop Mongoose |
| `AGENTS.md` §"Data storage" table | messaging row says **Mongo** | move it to Postgres, then delete the table's split framing and the "three done, one left" heading |
| `AGENTS.md` §"Data storage" | "Mongoose survives in exactly five files" | delete the paragraph |
| `AGENTS.md` §Commands | CI runs "against BOTH stores … a Mongo alone leaves the schema suite dead" | one store |

## 3. Onboarding — the Homiio failure mode

A contributor follows these literally. If they still say Mongo after it is gone,
the first-day experience is an install that does nothing and a failure that
looks like their own mistake.

| Location | Claim, true today |
|---|---|
| `README.md` §intro | "an Express backend on PostgreSQL and MongoDB" |
| `README.md` package table | "PostgreSQL via drizzle … and MongoDB via Mongoose (messaging)" |
| `README.md` §prerequisites | "a PostgreSQL instance AND a MongoDB instance" |
| `README.md` §scripts | backend `test` "starts a real MongoDB replica set" |
| `packages/backend/README.md` §Tech Stack | the two storage bullets |
| `packages/backend/README.md` §Prerequisites | the two instance bullets |
| `packages/backend/README.md` §Environment | the `MONGODB_URI` block and its "BOTH are required" note |
| `packages/backend/README.md` §Database Setup | "BOTH stores while the Mongo→Postgres port finishes" |
| `packages/backend/.env.example` | `MONGODB_URI` and its comment about the database name |

## 4. Published API surface — the rows that reach other people's code

| Location | Claim | Note |
|---|---|---|
| `docs/api.mdx` §Schemas | "The messaging models are still Mongoose" | becomes a drizzle reference |
| `docs/api.mdx` error table | the `503` row | already corrected — it used to promise a Mongo 503 that is never returned (4.2) |
| `docs/architecture.mdx` §layout | `Express + Socket.IO + PostgreSQL/MongoDB` | |
| `docs/architecture.mdx` §tree | `models/  Mongoose schemas (messaging only…)` | delete the directory line with the directory |
| `docs/architecture.mdx` §Matrix | "the Mongoose models now back only the messaging domain" | |

**4.2 — a documented behaviour that is real, and narrower than either claim.**
Both docs originally described a guard answering `503 Database temporarily
unavailable` when Mongo was disconnected; the correction then over-shot and said
no such guard existed. Both were half right. `server.ts` DOES mount a connect
middleware that answers exactly that 503 — but only when the initial connection
cannot be ESTABLISHED, because `connectToDatabase()` returns early on
`readyState === 1` and caches its promise, so it never throws once connected. A
store that dies mid-life is the case that produces a 500.

`isDatabaseConnected()` genuinely has no callers; it is the vestige of a
state-based check the middleware does not use. **The reliable question was never
"does it exist" but "what exactly does it cover"** — the same shape as an expiry
registry documenting a caller that was absent, and a wait loop believed unable to
distinguish two cases whose discriminating data it was already fetching. If a readiness guard is added, it must cover
**both** stores while both exist — a Mongo-only check would 503 the
Postgres-backed social, moderation and bridge routes during a Mongo outage, and
stay silent during a Postgres one.

## 5. CI and deploy config — no source-level guard scans these

| Location | What it does |
|---|---|
| `.github/workflows/ci.yml` | `MONGOMS_VERSION`, the `Cache MongoDB binaries` step, `~/.cache/mongodb-binaries`, and the "needs BOTH" comment |
| `.github/workflows/deploy-aws.yml` | `APP_MONGODB_URI` and its `sync_secret MONGODB_URI … /oxy/$APP/MONGODB_URI` |
| `packages/backend/Dockerfile` | the Node-22 rationale, which is written entirely in terms of the MongoDB driver's SCRAM auth — re-justify or delete it, do not leave a pin whose stated reason is gone |
| ECS task definition `oxy-allo` | carries `MONGODB_URI` beside `DATABASE_URL`; the secret comes off the definition and out of SSM `/oxy/allo/MONGODB_URI` |

Homiio shipped a ~200 MB `Cache mongod binary` step for months after deleting
the package. The cache step and the env vars go in the same PR as the
dependency.

## 6. Two facts that are not about Mongo but bite the same way

- **The deploy does not apply migrations.** `deploy-aws.yml` invokes
  `.github/scripts/deploy-ecs-image.sh` with no `RUN_MIGRATIONS`, which defaults
  to `false` (line 17), and no workflow sets it. Merging a schema change does not
  ship it. `README.md` asserted the opposite of this until now — it said "There
  are no database migrations", which is two false claims at once given
  `drizzle/` holds four. If the deploy learns to run migrations, that README
  paragraph and the `AGENTS.md` §Deployment note both change.
- **`DATABASE_URL` is live on the task definition and declared in no terraform.**
  Anything describing the secret's provenance is describing something that is not
  reproducible from `oxy-infra`. Being fixed separately; the docs asserting a
  provenance are this ledger's problem.
