FROM node:24-slim

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY lib/db ./lib/db
COPY services/discord-bot ./services/discord-bot

RUN pnpm install --no-frozen-lockfile

ENV NODE_ENV=production
CMD ["pnpm", "start"]
