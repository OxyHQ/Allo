# Bridge connector Dockerfile (Telegram interop service).
#
# Runs on AWS Graviton (linux/arm64) as well as x86_64; base node:18-alpine.
# Mirrors packages/backend/Dockerfile: the repo is a Bun workspaces monorepo with
# a committed bun.lock, so we use a PINNED Bun for a deterministic install. npm's
# strict ERESOLVE resolver fails on this tree (optional expo peer deps in
# @oxyhq/services); Bun honours peerDependenciesMeta.optional and resolves the
# workspace cleanly. The connector only needs @allo/bridge + @allo/shared-types
# (and their deps incl. gramjs) and never imports any expo/frontend package.

FROM node:18-alpine

# Pin Bun to the same version used in CI for reproducible installs.
ENV BUN_VERSION=1.3.11
ENV BUN_INSTALL=/usr/local
RUN apk add --no-cache bash curl unzip libstdc++ \
    && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && bun --version

WORKDIR /app

# Copy the workspace manifests + lockfile. All workspace package.json files must
# be present for `bun install --frozen-lockfile` to validate the committed
# lockfile, but only the bridge + shared-types workspaces are installed below
# (via --filter), so the heavy expo/react-native frontend tree is never pulled.
COPY package.json bun.lock ./
COPY packages/bridge/package.json ./packages/bridge/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/

# shared-types source must exist before install: the root "postinstall" script
# builds it (bun run build:shared-types) as part of `bun install`.
COPY packages/shared-types ./packages/shared-types/

# Install only the bridge + shared-types workspaces (and their deps such as
# gramjs). --frozen-lockfile guarantees the committed bun.lock is used verbatim,
# so the build is fully deterministic.
RUN bun install --frozen-lockfile \
        --filter '@allo/bridge' \
        --filter '@allo/shared-types'

# Copy bridge source.
COPY packages/bridge ./packages/bridge

# Ensure shared-types is built (idempotent if postinstall already ran).
RUN bun run --cwd packages/shared-types build

# Connector listens on BRIDGE_PORT (default 8090); no public ingress assumed.
EXPOSE 8090

# ts-node runs the TypeScript entrypoint directly (matches `bun run start`).
CMD ["bun", "run", "--cwd", "packages/bridge", "start"]
