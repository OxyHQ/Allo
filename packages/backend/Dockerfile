# Backend Dockerfile (Express API).
#
# Runs on AWS Graviton (linux/arm64) as well as x86_64; base oven/bun alpine.
#
# Bun is the runtime, not only the installer: `start` is `bun server.ts` and
# `db:migrate` (the deploy's pre/post one-shot tasks, which run in this image)
# is `bun src/db/migrate.ts`. Nothing in this image runs Node, so it does not
# ship one. Bun exposes `globalThis.crypto` everywhere, so @oxy.so/core's
# RN-only getRandomValues polyfill is never installed.
#
# Two stages. `deps` installs the backend's PRODUCTION dependency closure and
# nothing else; `runtime` is a fresh base holding that node_modules plus the
# TypeScript sources bun runs. No dev dependency, no SDK workspace (@allo/core,
# @allo/react), no frontend package and no compiler reaches the runtime image.
#
# There is no build stage because nothing is built. Bun runs the backend's
# TypeScript directly, and it loads @allo/shared-types from its SOURCE: the
# backend tsconfig maps `@allo/shared-types` to `../shared-types/src`, and bun
# honours tsconfig `paths` at runtime (measured: the server boots with
# shared-types' `dist/` removed). The `tsc` builds the old single-stage image
# ran produced nothing it loaded: its root postinstall never ran under
# `--filter` (bun does not run the root's scripts when the root is not
# selected), and the shared-types `dist/` it built by hand was shadowed by
# `paths`. CI's image smoke boots this image, so a change that makes the
# runtime need a build output fails there.

# The bun that wrote bun.lock: the tag must equal the root package.json
# `packageManager`, which CI's setup-bun reads. `bun run check:bun-pin` (CI lint
# job) fails if not.
#
# The digest is what the build uses; the tag is only for reading and for
# check:bun-pin. It is the multi-arch index digest (linux/amd64 + linux/arm64),
# resolved 2026-10-12. Both stages use the same reference. A bump, even of the
# same tag, needs a new digest and a re-review (`reviewed-image.py pin`); without
# one the deploy refuses to build. bump-base-digests.yml proposes those bumps.
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS deps

WORKDIR /app

# Every workspace manifest plus the lockfile: `--frozen-lockfile` validates the
# committed bun.lock against all of them even though only two are installed.
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

# The production closure of the two workspaces the server runs: the backend and
# @allo/shared-types, which it imports. --frozen-lockfile uses the committed
# bun.lock verbatim.
#
# --production drops devDependencies (typescript, drizzle-kit, supertest,
# bun-types, @allo/core and every @types/* the workspaces declare).
#
# --omit=peer: bun otherwise installs every peer the LOCKFILE resolved, and the
# lockfile resolves them for the frontend. @oxy.so/core's optional peers
# expo-crypto and expo-secure-store then drag in expo and react-native, and with
# them typescript: measured 916 packages and 696 MB with peers against 317 and
# 163 MB without. Every required peer in the closure is also a direct
# dependency (drizzle-orm, postgres, express, zod, ...) except @oxy.so/protocol's
# `expo-modules-core`, which only its React Native build loads. CI's image smoke
# runs .github/scripts/check-runtime-closure.mjs against this tree and fails on
# any other missing peer, and on any installed package nothing requires.
#
# --ignore-scripts: measured on this closure, the only install scripts are the
# postinstalls of @firebase/util (writes a web-app config default from
# FIREBASE_WEBAPP_CONFIG, unset here, so the shipped `undefined` stands) and
# protobufjs (prints a version-scheme warning). Neither is in bun's default
# trusted list, the tree is byte-identical with and without the flag, and there
# is no native addon. The flag keeps it that way if a trust list ever grows.
RUN bun install --frozen-lockfile --production --omit=peer --ignore-scripts \
        --filter '@allo/backend' \
        --filter '@allo/shared-types'

FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS runtime

WORKDIR /app

# Everything is copied as root (no --chown), so the app can read but not
# rewrite its own code and dependencies. node_modules keeps the hoisted
# workspace symlinks (@allo/backend, @allo/shared-types -> ../../packages/*),
# which resolve to the two source trees below. Tests and Markdown are kept out
# of the build context by .dockerignore.
COPY --from=deps /app/node_modules ./node_modules
COPY packages/shared-types ./packages/shared-types/
COPY packages/backend ./packages/backend/

EXPOSE 8080

# Run as the base image's unprivileged `bun` user (uid 1000), not root. Nothing
# at runtime writes outside /tmp: the API writes no files, the migrator
# materialises journal prefixes under os.tmpdir(), and the base sets
# BUN_RUNTIME_TRANSPILER_CACHE_PATH=0. Port 8080 needs no root. CI's image
# smoke asserts all of it: uid 1000, nothing under /app owned by or writable to
# it, /tmp writable, and a boot that answers the ALB's `GET /`.
USER bun

# Bun runs the TypeScript entrypoint directly (`start` is `bun server.ts`, the
# same as `bun run start:backend`).
CMD ["bun", "run", "--cwd", "packages/backend", "start"]
