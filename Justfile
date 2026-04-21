# steward — GitHub agent
# Requires: just, node, tsx

default:
    @just --list

# Install dependencies
install:
    npm install

build:
    echo "Not needed."

# Run (requires .env)
run:
    npm start

# Run in dev mode
dev:
    npm run dev

# Run tests
test:
    npm test

# Run tests in watch mode
test-watch:
    npm run test:watch

# Run all checks (lint + typecheck + test)
check: lint typecheck test

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
