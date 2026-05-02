# steward — GitHub agent
# Requires: just, node, pnpm

default:
    @just --list

# Install dependencies
install:
    pnpm install

build:
    echo "Not needed."

# Run (requires .env)
run:
    pnpm --filter @steward/runner start

# Run in dev mode
dev:
    pnpm --filter @steward/runner dev

# Run webhook-loop in dev mode (requires WEBHOOK_SECRET in .env)
webhook-dev:
    pnpm --filter @steward/webhook-loop dev

# Run tests
test:
    pnpm -r test

# Run tests in watch mode
test-watch:
    pnpm --filter @steward/runner run test:watch

# Run all checks (lint + typecheck + test)
check: lint typecheck test

# Lint and check formatting
lint:
    pnpm biome check .

# Fix lint and formatting issues
fix:
    pnpm biome check . --write

# Type-check
typecheck:
    pnpm -r typecheck

# Remove build artifacts and node_modules
clean:
    rm -rf node_modules dist packages/*/node_modules packages/*/dist

# Reinstall from scratch
fresh: clean install

# Build Docker image
docker-build:
    docker build -f packages/runner/Dockerfile -t steward:latest .

# Run via Docker with full network access (required for GitHub + Anthropic APIs)
docker-run:
    DOCKER_NETWORK=bridge docker compose up --no-build

# End-to-end container smoke test (no real credentials required)
docker-smoke:
    bash scripts/docker-smoke-test.sh
