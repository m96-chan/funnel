# syntax=docker/dockerfile:1.7
#
# Funnel signaling server.
#
# Build context is the REPOSITORY ROOT, not infra/ — the server is an npm
# workspace that depends on the `shared` workspace, so the whole workspace tree
# has to be visible to npm. From infra/:
#
#   docker build -f infra/server.Dockerfile -t funnel-server ..
#
# (docker-compose.yml already sets `context: ..` for exactly this reason.)

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
#
# Only the manifests are copied first so this layer is reused whenever source
# changes but package.json does not, which is most of the time.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
# The dashboard is a workspace too. npm resolves the whole workspace set from
# the root manifest, so its package.json has to exist even though nothing from
# it ends up in the runtime image.
COPY dashboard/package.json ./dashboard/

# `npm ci` is the reproducible path but it requires a committed lockfile; the
# repo does not have one yet, so fall back to `npm install`. Once
# package-lock.json is committed this silently starts using the strict path.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---------------------------------------------------------------------------
# Stage 2 — build
#
# `shared` must be compiled before `server`: the server's tsconfig resolves
# @funnel/shared through the workspace symlink.
# ---------------------------------------------------------------------------
FROM deps AS build

WORKDIR /app

COPY shared/ ./shared/
COPY server/ ./server/

RUN npm run build --workspace @funnel/shared \
    && npm run build --workspace @funnel/server

# Drop devDependencies (typescript, tsx, @types/*) so the runtime stage copies
# a production-only tree. Workspace links in node_modules survive this.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 3 — runtime
#
# Slim: no toolchain, no sources beyond what `node dist/index.js` needs.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

# wget (busybox) is what HEALTHCHECK uses below; it ships with the base image.
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

# Root manifest first — it carries the `workspaces` field that makes the
# node_modules/@funnel/shared symlink resolve.
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules

# `shared` ships both dist/ and src/: its package.json `exports` currently
# points "." at ./src/index.ts, so copying only dist/ would break resolution.
COPY --from=build --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=build --chown=node:node /app/shared/dist ./shared/dist
COPY --from=build --chown=node:node /app/shared/src ./shared/src

COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist

# The base image ships an unprivileged `node` user (uid 1000). Nothing here
# needs root, and the signaling port is >1024.
USER node

WORKDIR /app/server

EXPOSE 8080

# Hits the server's own liveness endpoint from inside the container, so the
# check fails if the process is up but the HTTP listener is wedged.
# start-period covers boot; the server has no slow warmup.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --quiet --spider "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "dist/index.js"]
