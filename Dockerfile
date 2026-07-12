# Monetizer engine — Cloud Run-ready image.
FROM node:22-slim

RUN corepack enable
WORKDIR /app

# Workspace manifests first for layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY engine/package.json engine/
COPY packages/context-taxonomy/package.json packages/context-taxonomy/
COPY packages/astro-kit/package.json packages/astro-kit/
RUN pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
# Cloud Run injects PORT (8080); config.ts reads it.
EXPOSE 8080
CMD ["pnpm", "--filter", "@monetizer/engine", "start"]
