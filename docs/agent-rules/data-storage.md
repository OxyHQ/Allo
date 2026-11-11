# Data storage

Moved verbatim from the root `AGENTS.md`; the rules below are unchanged and binding.

`DATABASE_URL` is REQUIRED to boot (`server.ts`) and every route, worker and
sweep reads Postgres. There is no second store to choose between.

Schema is `db/schema/` (one file per domain) and the binding decisions — naming,
primary keys, closed value sets, the `jsonb` register, the hook →
constraint map — are in `db/schema/CONVENTIONS.md`. Read it before touching a
table. Repositories are `db/<domain>/`; routes go through them and never build
SQL themselves. The migrator and the test setup are in
`packages/backend/README.md`.

**Row ids are `text` and come in TWO shapes.** New rows carry a uuid v7; older
rows carry a 24-character hex id, verbatim. So nothing may assume a format — a
hex-shaped validator would reject every new row, and a uuid-shaped one every
older row.

**Sub-millisecond creation order is not a property this schema has.**
`@oxy.so/db`'s `createdAt` is `date_trunc('milliseconds', now())`, and the uuid v7
tiebreak below it does not encode order within a millisecond. A test asserting an
exact sequence for rows written in a tight loop is asserting the generator's
luck; space the writes across milliseconds or assert only at the resolution the
schema guarantees. Measured: one such assertion in `social.realdb.test.ts` failed
4 runs in 8 before it was spaced.

