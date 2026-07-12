# Monetizer engine — Cloud Run-ready image.
# Base via Google's registry mirror: Docker Hub rate-limits/blocks anonymous
# pulls from Cloud Build's shared IPs, which fails builds at the FROM step.
FROM mirror.gcr.io/library/node:22-slim

# npm-installed pnpm instead of corepack: corepack's registry-key pinning has
# repeatedly broken cold image builds, and newer node images drop it entirely.
RUN npm install -g pnpm@10.33.0
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
