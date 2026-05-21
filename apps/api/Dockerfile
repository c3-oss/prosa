FROM node:22-bookworm-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /repo

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @c3-oss/prosa-api... build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV="production"
ENV PROSA_RUNTIME_MODE="production"

WORKDIR /repo

COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/package.json ./package.json
COPY --from=build --chown=node:node /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml

COPY --from=build --chown=node:node /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./apps/api/dist

COPY --from=build --chown=node:node /repo/packages/prosa-db/package.json ./packages/prosa-db/package.json
COPY --from=build --chown=node:node /repo/packages/prosa-db/node_modules ./packages/prosa-db/node_modules
COPY --from=build --chown=node:node /repo/packages/prosa-db/dist ./packages/prosa-db/dist
COPY --from=build --chown=node:node /repo/packages/prosa-storage/package.json ./packages/prosa-storage/package.json
COPY --from=build --chown=node:node /repo/packages/prosa-storage/node_modules ./packages/prosa-storage/node_modules
COPY --from=build --chown=node:node /repo/packages/prosa-storage/dist ./packages/prosa-storage/dist
COPY --from=build --chown=node:node /repo/packages/prosa-sync/package.json ./packages/prosa-sync/package.json
COPY --from=build --chown=node:node /repo/packages/prosa-sync/node_modules ./packages/prosa-sync/node_modules
COPY --from=build --chown=node:node /repo/packages/prosa-sync/dist ./packages/prosa-sync/dist

COPY --from=build --chown=node:node /repo/packages/prosa-types-v2/package.json ./packages/prosa-types-v2/package.json
COPY --from=build --chown=node:node /repo/packages/prosa-types-v2/node_modules ./packages/prosa-types-v2/node_modules
COPY --from=build --chown=node:node /repo/packages/prosa-types-v2/dist ./packages/prosa-types-v2/dist

COPY --from=build --chown=node:node /repo/packages/prosa-wire-v2/package.json ./packages/prosa-wire-v2/package.json
COPY --from=build --chown=node:node /repo/packages/prosa-wire-v2/node_modules ./packages/prosa-wire-v2/node_modules
COPY --from=build --chown=node:node /repo/packages/prosa-wire-v2/dist ./packages/prosa-wire-v2/dist

COPY --from=build --chown=node:node /repo/packages/prosa-bundle-v2/package.json ./packages/prosa-bundle-v2/package.json
COPY --from=build --chown=node:node /repo/packages/prosa-bundle-v2/node_modules ./packages/prosa-bundle-v2/node_modules
COPY --from=build --chown=node:node /repo/packages/prosa-bundle-v2/dist ./packages/prosa-bundle-v2/dist

COPY --from=build --chown=node:node /repo/packages/prosa-db-v2/package.json ./packages/prosa-db-v2/package.json
COPY --from=build --chown=node:node /repo/packages/prosa-db-v2/node_modules ./packages/prosa-db-v2/node_modules
COPY --from=build --chown=node:node /repo/packages/prosa-db-v2/dist ./packages/prosa-db-v2/dist

COPY --from=build --chown=node:node /repo/packages/prosa-importers-v2/package.json ./packages/prosa-importers-v2/package.json
COPY --from=build --chown=node:node /repo/packages/prosa-importers-v2/node_modules ./packages/prosa-importers-v2/node_modules
COPY --from=build --chown=node:node /repo/packages/prosa-importers-v2/dist ./packages/prosa-importers-v2/dist

USER node

EXPOSE 3000

CMD ["node", "apps/api/dist/bin/prosa-api.js"]
