# The Next.js dashboard as a self-hosted container, built WITH the fork-local
# strict engine from typescript/. Build from the REPOSITORY ROOT:
#
#   docker build -f web/Dockerfile -t hevy2garmin-web .
#
# The root Dockerfile is a different image: it builds the Python CLI.
#
# The `hevy2garmin` engine is NOT taken from the npm registry. It is compiled
# from typescript/ in this checkout, stamped with a digest of its source, and
# installed into web/node_modules as a copy (web/.npmrc install-links=true), so
# its peer dependencies resolve from web/. scripts/verify-engine.mjs fails the
# build if the installed engine is not exactly that build (contract item 4).
# web/Dockerfile.dockerignore limits the context to typescript/ and web/.

FROM node:22-bookworm-slim AS engine
WORKDIR /src/typescript
COPY typescript/package.json typescript/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY typescript/ ./
RUN npm run build


FROM node:22-bookworm-slim AS deps
WORKDIR /src/web
COPY --from=engine /src/typescript /src/typescript
COPY web/package.json web/package-lock.json web/.npmrc ./
COPY web/scripts ./scripts
RUN npm ci --no-audit --no-fund && node scripts/verify-engine.mjs


FROM node:22-bookworm-slim AS builder
WORKDIR /src/web
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=engine /src/typescript /src/typescript
COPY --from=deps /src/web/node_modules ./node_modules
COPY web/ ./
# H2G_BASE_PATH serves the dashboard under a path prefix (README: Under a
# sub-path). Next.js bakes it into the build, so it is a build argument.
ARG H2G_BASE_PATH=""
# Routes are force-dynamic, so the build never connects to a database; it only
# needs a URL to be set, the same as the CI build. Scoped to this one command
# so it does not end up in the image. `npm run build` re-runs the engine check.
RUN H2G_BASE_PATH="$H2G_BASE_PATH" DATABASE_URL=postgres://build:build@localhost:5432/build npm run build


FROM node:22-bookworm-slim

# Kept at runtime for the health check, which has to call the prefixed path.
ARG H2G_BASE_PATH=""
ENV H2G_BASE_PATH=$H2G_BASE_PATH
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8096 \
    HOSTNAME=0.0.0.0

WORKDIR /app

# `output: "standalone"` (next.config.ts, off Vercel) traces the node_modules the
# server needs into .next/standalone. The static assets are not part of that and
# are copied next to it. There is no public/ folder to copy.
COPY --from=builder /src/web/.next/standalone ./
COPY --from=builder /src/web/.next/static ./.next/static

# The code stays root-owned and read-only for the app. Only Next's cache
# directory is writable, by the `node` user (uid 1000) that ships in the base image.
RUN mkdir -p .next/cache && chown node:node .next/cache

USER node
EXPOSE 8096

# /api/version needs no session and no database, so it says whether the server
# is up without turning a database outage into a restart loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8096) + (process.env.H2G_BASE_PATH || '') + '/api/version').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "server.js"]
