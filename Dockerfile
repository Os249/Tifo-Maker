# Tifo Maker — single-image deploy (serves the built SPA + the API together).
#
# Node 24 is the Active LTS line, with security releases until 30 April 2028.
# Node 20 reached end of life on 30 April 2026 and no longer gets security
# fixes, which is what this image ran before. server/test/deploy.test.mts fails
# once the Node line named here is within 90 days of its end of life, so the
# next move is prompted, not remembered.

# ---- build: everything needed to compile the frontend ----
FROM node:24-slim AS build
WORKDIR /app

# Install exactly what package-lock.json says, or stop. This used to be
# `npm ci || npm install`: whenever the lockfile and package.json disagreed,
# the fallback quietly re-resolved versions nobody had reviewed and shipped them.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy source and build the frontend into dist/.
COPY . .
RUN npm run build:prod

# What npm knew about the production packages on the day this image was built,
# shown on /admin#security. Informational only: an advisory service that cannot
# be reached must not block a deploy (CI runs the strict check on every push).
RUN npm audit --omit=dev --json > audit-snapshot.json 2>/dev/null || true

# Drop the build-only packages (TypeScript, Vite, Playwright) so they never
# reach the server image.
RUN npm prune --omit=dev --no-audit --no-fund

# ---- runtime: the built site, the server source and production packages ----
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

# Owned by, and run as, the unprivileged "node" user the base image provides.
# As root, any code-execution bug in the server or a dependency would own the
# whole container, including what it can reach on Railway's network.
COPY --from=build --chown=node:node /app /app
USER node

EXPOSE 8787

# Health check hits the existing GET /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node itself is the container's main process, not npm. Railway stops a
# container with SIGTERM; npm did not pass it on, so the server was killed
# without closing: in-flight requests cut, queued emails and the last seconds
# of the security log lost. server.ts handles SIGTERM and closes cleanly.
CMD ["node", "--import", "tsx", "server/src/server.ts"]
