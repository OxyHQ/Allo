# Allo SDK

The public resource capability API remains compatible. Own Oxy backends can
use the `/server` export with their process's shared `OxyServer`:

```ts
import { alloTeamForOxyService } from '@oxy.so/allo-sdk/server';

const team = alloTeamForOxyService(oxy);
```

The factory uses Oxy's shared workload transport and the registered Allo
audience. It adds no API key, internal scopes or app consent. Team capabilities,
membership and operation checks remain the resource authorization contract.
The root SDK import does not load Oxy; only the optional server entry requires
`@oxy.so/core >=7 <8`.

SDK0.4 was published before the backend migrations in Allo and Homiio, so
neither backend needed an unpublished sibling SDK. During that release the SDK
and application majors were isolated instead of applying a global override.

The runtime now uses core7.3/contracts6/protocol1.5.1 with services13.6, and the
SDK's integration test uses the same core major. Provider and linked clients
must continue resolving the same major; global overrides must not force a
future independently released SDK into an incompatible application runtime.
