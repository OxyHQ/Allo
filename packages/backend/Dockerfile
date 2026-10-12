# Backend Dockerfile (Express API).
#
# Runs on AWS Graviton (linux/arm64) as well as x86_64; base oven/bun alpine.
#
# Bun is the runtime, not only the installer: `start` is `bun server.ts` and
# `db:migrate` (the deploy's pre/post one-shot tasks, which run in this image)
# is `bun src/db/migrate.ts`. Nothing in this image runs Node, so it does not
# ship one. The package scripts that call a Node-shebang binary at install time
# (the root postinstall's `tsc` builds of the SDK packages) still work: when no
# `node` is on PATH, `bun run` puts a `node` that is bun in front of the script.
#
# The hazard the old Node 22 floor guarded against does not apply: Bun exposes
# `globalThis.crypto` everywhere, so @oxy.so/core's RN-only getRandomValues
# polyfill is never installed.
#
# The repo is a Bun workspaces monorepo with a committed bun.lock, so we use
# Bun for a deterministic install instead of npm. npm's strict ERESOLVE
# resolver fails here because @oxy.so/services declares OPTIONAL peer deps
# (expo-font ~55, expo >=55, ...) that conflict with the expo 56 tree pulled
# in by the frontend workspace; Bun honours peerDependenciesMeta.optional and
# resolves the workspace cleanly. The backend itself only needs @oxy.so/core
# (a shared root dependency) and never imports any expo/frontend package.

# The bun that wrote bun.lock: the tag must equal the root package.json
# `packageManager`, which CI's setup-bun reads. `bun run check:bun-pin` (CI lint
# job) fails if not.
FROM oven/bun:1.4.3-alpine

WORKDIR /app

# Copy the workspace manifests + lockfile. All workspace package.json files
# must be present for `bun install --frozen-lockfile` to validate the committed
# lockfile, but only the backend + shared-types workspaces are actually
# installed below (via --filter), so the heavy expo/react-native frontend tree
# is never downloaded into this image.
# bunfig.toml selects the HOISTED linker. Without it bun >= 1.3 defaults to the
# isolated linker inside the image, which materialises the `file:` workspace
# dependencies as nested per-package copies under packages/backend/node_modules
# instead of the root symlinks the host has, and the copy of @allo/shared-types
# it produces has no package.json, so the very first `require` at boot fails
# with MODULE_NOT_FOUND. Measured on 2026-09-17: image built, boot died.
COPY package.json bun.lock bunfig.toml ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/core/package.json ./packages/core/
COPY packages/react/package.json ./packages/react/
COPY packages/frontend/package.json ./packages/frontend/

# The root manifest's `patchedDependencies` is read and RESOLVED before --filter
# narrows anything, so every patch file it names must exist even when the patched
# package belongs to a workspace this image never installs. `expo` is exactly
# that: a frontend dependency, filtered out below, whose patch file bun still
# insists on finding — without this line the install dies with
# "Couldn't find patch file: 'patches/expo@57.0.6.patch'".
COPY patches ./patches/

# The SDK workspaces' sources must exist before install: the root "postinstall"
# script builds shared-types, core and react (in that order) as part of
# `bun install`. The backend imports only shared-types at runtime; core is a
# devDependency of the backend (its integration suite drives the real SDK
# against the real app) and react is built only because the root postinstall
# builds every SDK package the same way everywhere.
COPY packages/shared-types ./packages/shared-types/
COPY packages/core ./packages/core/
COPY packages/react ./packages/react/

# Install only the backend + SDK workspaces (and shared root deps such as
# @oxy.so/core); the heavy expo/react-native frontend tree is never downloaded
# into this image. --frozen-lockfile guarantees the committed bun.lock is used
# verbatim, so the build is fully deterministic.
RUN bun install --frozen-lockfile \
        --filter '@allo/backend' \
        --filter '@allo/shared-types' \
        --filter '@allo/core' \
        --filter '@allo/react'

# Copy backend source.
COPY packages/backend ./packages/backend

# Ensure shared-types is built (idempotent if postinstall already ran).
RUN bun run --cwd packages/shared-types build

EXPOSE 8080

# Bun runs the TypeScript entrypoint directly (`start` is `bun server.ts`, the
# same as `bun run start:backend`).
CMD ["bun", "run", "--cwd", "packages/backend", "start"]
