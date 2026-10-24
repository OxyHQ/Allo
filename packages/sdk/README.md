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

This SDK release precedes the backend migrations in Allo and Homiio, so neither
backend depends on an unpublished sibling SDK. The SDK's development core7 and
contracts6 dependencies are isolated from the applications' existing major
versions. The applications adopt the new majors in their separate migration.

The release removes global core/contracts/protocol overrides. Existing app
core6.14/contracts5.7 remain pinned with compatible protocol1.5.0; the SDK
selects protocol1.5.1 alongside core7/contracts6. This avoids shipping both
contracts majors in the existing application bundle. The measured web export
is 3,290,339 gzip bytes, within the unchanged 3,300,000-byte budget.
