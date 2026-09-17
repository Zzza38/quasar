FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 QUASAR_STANDALONE=1
RUN npm run build

# The worker uses the same pinned dependencies and SQLite volume as the app.
# tsx is retained in this separate image to run the server TypeScript directly.
FROM dependencies AS worker
ENV NODE_ENV=production DATABASE_PATH=/app/data/quasar.sqlite
COPY --chown=node:node tsconfig.json ./
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
