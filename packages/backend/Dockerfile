# Backend Dockerfile (Express API).
#
# Runs on AWS Graviton (linux/arm64) as well as x86_64; base node:18-alpine.
# The repo is a Bun workspaces monorepo with a committed bun.lock, so we use
# Bun for a deterministic install instead of npm. npm's strict ERESOLVE
# resolver fails here because @oxyhq/services declares OPTIONAL peer deps
# (expo-font ~55, expo >=55, ...) that conflict with the expo 56 tree pulled
# in by the frontend workspace; Bun honours peerDependenciesMeta.optional and
# resolves the workspace cleanly. The backend itself only needs @oxyhq/core
# (a shared root dependency) and never imports any expo/frontend package.

FROM node:18-alpine

# Pin Bun to the same version used in CI for reproducible installs.
ENV BUN_VERSION=1.3.11
ENV BUN_INSTALL=/usr/local
RUN apk add --no-cache bash curl unzip libstdc++ \
    && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && bun --version

WORKDIR /app

# Copy the workspace manifests + lockfile. All workspace package.json files
# must be present for `bun install --frozen-lockfile` to validate the committed
# lockfile, but only the backend + shared-types workspaces are actually
# installed below (via --filter), so the heavy expo/react-native frontend tree
# is never downloaded into this image.
COPY package.json bun.lock ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/frontend/package.json ./packages/frontend/

# shared-types source must exist before install: the root "postinstall" script
# builds it (bun run build:shared-types) as part of `bun install`.
COPY packages/shared-types ./packages/shared-types/

# Install only the backend + shared-types workspaces (and shared root deps such
# as @oxyhq/core). --frozen-lockfile guarantees the committed bun.lock is used
# verbatim, so the build is fully deterministic.
RUN bun install --frozen-lockfile \
        --filter '@allo/backend' \
        --filter '@allo/shared-types'

# Copy backend source.
COPY packages/backend ./packages/backend

# Ensure shared-types is built (idempotent if postinstall already ran).
RUN bun run --cwd packages/shared-types build

EXPOSE 8080

# ts-node runs the TypeScript entrypoint directly (matches `bun run start:backend`).
CMD ["bun", "run", "--cwd", "packages/backend", "start"]
