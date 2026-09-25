FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
# better-sqlite3 is compiled from source when no prebuilt binary matches this Node release, so this stage carries the
# toolchain; the worker and runtime images below copy only the finished node_modules or the standalone build.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 QUASAR_STANDALONE=1
RUN npm run build

# The worker uses the same pinned dependencies and SQLite volume as the app.
# tsx is retained in this separate image to run the server TypeScript directly.
FROM node:24-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production DATABASE_PATH=/app/data/quasar.sqlite
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src/domain ./src/domain
COPY --chown=node:node src/server ./src/server
COPY --chown=node:node scripts/worker.ts ./scripts/worker.ts
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "--import", "tsx", "scripts/worker.ts"]

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/quasar.sqlite
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
