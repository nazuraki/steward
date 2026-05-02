FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Include devDependencies — tsx is required to run TypeScript source directly
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./

ENV LOG_DIR=/var/log/steward \
    WORK_DIR=/tmp/repo

RUN mkdir -p /var/log/steward \
    && addgroup --system steward \
    && adduser --system --ingroup steward steward \
    && chown steward:steward /var/log/steward

USER steward

CMD ["node", "--import", "tsx/esm", "src/index.ts"]
