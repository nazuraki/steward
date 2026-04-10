# steward — GitHub agent
# Requires: just, node, tsx

default:
    @just --list

# Install dependencies
install:
    npm install

# Run (requires .env)
run:
    npm start

# Run in dev mode
dev:
    npm run dev

# Run all checks (lint + typecheck)
check: lint typecheck

# Lint and check formatting
lint:
    npx biome check .

# Fix lint and formatting issues
fix:
    npx biome check . --write

# Type-check
typecheck:
    npm run typecheck

# Remove build artifacts and node_modules
clean:
    rm -rf node_modules dist

# Reinstall from scratch
fresh: clean install
