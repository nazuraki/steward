FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/auth/package.json ./packages/auth/
COPY packages/config/package.json ./packages/config/
COPY packages/gh-client/package.json ./packages/gh-client/
COPY packages/runner/package.json ./packages/runner/

# Include devDependencies — tsx is required to run TypeScript source directly
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/ ./packages/

ENV LOG_DIR=/var/log/steward \
    WORK_DIR=/tmp/repo

RUN mkdir -p /var/log/steward \
    && addgroup --system steward \
    && adduser --system --ingroup steward steward \
    && chown steward:steward /var/log/steward

USER steward

CMD ["node", "--import", "tsx/esm", "packages/runner/src/index.ts"]
