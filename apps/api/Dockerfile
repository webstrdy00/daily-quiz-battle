# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS pnpm

RUN corepack enable \
  && corepack prepare pnpm@11.24.0 --activate

WORKDIR /app

FROM pnpm AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN pnpm install --frozen-lockfile --filter @daily-quiz-battle/api...

COPY apps/api apps/api
COPY packages/contracts packages/contracts

RUN pnpm --filter @daily-quiz-battle/contracts build \
  && pnpm --filter @daily-quiz-battle/api build

FROM pnpm AS production-dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN pnpm install --frozen-lockfile --prod --filter @daily-quiz-battle/api...

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=production-dependencies --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/migrations ./apps/api/migrations
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist

USER node

EXPOSE 3000

CMD ["node", "apps/api/dist/server.js"]
