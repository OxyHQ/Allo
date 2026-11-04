# Allo SDK

Two entries, each importable on its own:

- `@oxy.so/allo-sdk/links` — links into Allo (start a direct conversation,
  hand Allo something to send) for any Oxy app. No dependencies.
- `@oxy.so/allo-sdk/server` — the managed-team snapshot read, for backends.
  Requires `@oxy.so/core >=7 <8` (an optional peer: the root and `/links`
  entries never load it).

The root entry re-exports `/links` and the `TeamSnapshot` type.

## Reading a team snapshot

```ts
import { alloTeamForOxyService } from '@oxy.so/allo-sdk/server';

const team = alloTeamForOxyService(oxy); // the process's one OxyServer
const snapshot = await team.snapshot(capability); // TeamSnapshot | null
```

Every request carries two things, and neither replaces the other:

- **The caller's Oxy service token** — transport identity. It is minted by
  `OxyServer.createServiceClient` for Allo's audience (`SERVICE_AUDIENCE`,
  `oxy-service:<Allo's application id>`) from the process's attested workload
  identity (Oxy ADR 0026/0049). No API key, internal scope or app consent is
  involved.
- **The team's capability** (`x-allo-team-capability`) — the resource grant.
  Membership and operation checks are Allo's, whoever the caller is.

`snapshot` answers `null` when the capability names no team, and throws for
any other refusal (a missing or inactive service identity, an outage), so an
authentication failure is never read as "no team".

`createServiceClient` mints from workload identity only, so the read is open to
Oxy-attested workloads. An `OxyServer` configured only with `serviceAuth` (an
external application's API key pair) has no workload identity to mint from, so
its snapshot reads fail; there is no second, key-based path.

## 1.0.0 — the snapshot read always authenticates

0.x exported `AlloTeamAccessClient`, whose default constructor called the
snapshot route with bare `fetch` and no token. That client is gone, so Allo can
require a service token on the route.

- Removed: the `AlloTeamAccessClient` class and its root export. Its shape
  survives as the `AlloTeamAccessClient` interface in `/server`.
- Unchanged: `alloTeamForOxyService(oxy)`, `SERVICE_AUDIENCE`, the
  `TeamSnapshot` type and everything in `/links`.

A backend that already used `alloTeamForOxyService` only bumps the version.
