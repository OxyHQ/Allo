# spike: matrix-js-sdk + crypto wasm under Expo web

Standalone Expo app (outside the workspaces) that mirrors `packages/frontend`'s
web setup — Expo SDK 57, React 19.2.3, expo-router, `web.output: "static"`,
`babel-preset-expo` with `unstable_transformImportMeta` — and runs
`matrix-js-sdk@42` + `@matrix-org/matrix-sdk-crypto-wasm@18` in it.

## Run it

```bash
bun install

# 1. copy the .wasm into public/ and produce a production export
bun run export

# 2. serve the export statically (application/wasm MIME, SPA fallback)
bun run serve            # http://localhost:8142
```

Then either open the page and click the step buttons, or drive it headlessly:

```bash
# individual steps: 1 (wasm) 2 (login+crypto) 3 (round trip) 4a/4b (4S + backup)
SPIKE_PASSWORD=... bun run scripts/drive.ts 1 2 3 4a 4b

# OIDC / MSC2965 discovery (read-only; no dynamic client registration)
SPIKE_OIDC_HOMESERVER=https://matrix.org bun run scripts/drive.ts oidc

# multi-tab modes
SPIKE_PASSWORD=... bun run scripts/drive.ts shared-session
SPIKE_PASSWORD=... bun run scripts/drive.ts shared-session-stress
SPIKE_PASSWORD=... bun run scripts/drive.ts multitab-collision
```

Credentials come from the environment, never from a file:
`SPIKE_HOMESERVER`, `SPIKE_USER`, `SPIKE_PASSWORD`, `SPIKE_PASSPHRASE`.
`SPIKE_CHROME` overrides the browser binary (default `/usr/bin/chromium`).
`SPIKE_OIDC_HOMESERVER` targets the OIDC step at a different server.

## Local homeserver

matrix.org delegates authentication to Matrix Authentication Service, so it has
no legacy password registration. The runs used a local Synapse with open
registration and legacy password login — production will use MAS instead:

```bash
python3 -m venv synapse-venv && ./synapse-venv/bin/pip install matrix-synapse
./synapse-venv/bin/python -m synapse.app.homeserver \
    --server-name localhost --config-path homeserver.yaml \
    --generate-config --report-stats=no
# then set enable_registration / enable_registration_without_verification: true
./synapse-venv/bin/register_new_matrix_user -u spike -p ... -c homeserver.yaml \
    http://localhost:8008
```
