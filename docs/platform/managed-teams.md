# Homiio managed teams

A Homiio case owns the collaboration policy; Allo owns the encrypted conversation, its membership and delivery. `homiio-team` is an Allo-hosted workflow so the creator's existing Allo instance performs every MLS operation. Homiio never holds an MLS key, forwards a human bearer, stores message content, or trusts a client receipt as proof of removal.

The creator authorizes a narrow read grant when opening the team flow. Homiio stores the opaque reference encrypted at rest; Allo stores its SHA-256 hash, its own conversation id and the opaque Homiio case reference. The capability is sent in `x-allo-team-capability`, never in a URL, and permits only `@allo/sdk`'s coherent membership snapshot. The source operation's distinct capability is sent in `x-homiio-team-operation` and is read through `@homiio/sdk`. Both SDKs fix the remote origin and refuse redirects. Neither grant can sign an Allo mutation or decrypt a message. Headers are excluded from request logs and explicitly redacted by the logger.

## Commit protocol

Homiio reserves a durable operation under the case lock. Its pending target is immutable. Allo verifies that operation and its creator through Homiio's SDK, then freezes the managed conversation under the conversation lock. Creation inserts the binding and the initial MLS state in the same transaction; a unique capability hash converges concurrent creators onto one group.

While frozen, the event repository refuses application events, including edits, receipts and media. MLS maintenance continues, constrained to the source's target accounts. The SDK prioritizes commits ahead of held application messages, and a freeze does not exhaust their normal transport retry budget. Owner-driven membership operations include explicit account changes, so someone without a device can be invited or removed. A removal recomputes all that account's current leaves after an epoch conflict and the backend refuses a partial account removal. Every accepted removal advances the MLS epoch.

Homiio finalizes its local membership only after the SDK snapshot reports the correct frozen operation, owner and exact target set. Allo then reads the immutable finalized source operation before releasing the freeze. A failed dependency or lost response leaves the same operation recoverable. A previous finalized operation cannot overwrite a newer operation. Ordinary group-add and leave paths cannot change a managed team's policy outside this workflow.

Historical messages already decrypted on a removed account's devices remain there. The server excludes the removed account from future delivery and self-join. No content synchronization worker is involved. Pending operations have no timeout that silently restores sending: the creator resumes the workflow. Source case deletion during an unfinished operation leaves the group frozen because source authorization is gone.

## Evidence and rollout

`integration/managedTeam.realdb.test.ts` runs real instance signatures, the core SDK, MLS, HTTP, sockets and Postgres. Only the remote Homiio authority is replaced by an HTTP-response fixture, still parsed by its real SDK. It exercises lost create/add/remove responses, frozen sends, failed source reads, repeated release, unauthorized actors, stale operations, unknown capabilities, off-source additions, no-device removal and preserved history. Homiio separately tests its actual repository transactions against real Postgres and the real Allo read SDK with injected remote responses. Core tests also restart the client after an ambiguous creation.

Migration `0011_managed_teams` is additive and runs in the pre phase. Deploy the corresponding Homiio operation API and provision its documented reference-encryption key before enabling the flow. The frontend uses only Oxy's linked client for authenticated Homiio calls. Browser/device account switching and native universal links remain device rollout checks; the automated fixtures do not claim to exercise an installed iOS or Android app.

The generated team API is served at `/v1/openapi.json`; `bun run check:team-openapi` checks [the committed schema](./team-openapi.json).
