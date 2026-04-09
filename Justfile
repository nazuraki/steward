# steward — GitHub agent
# Requires: just, node, tsx

default:
    @just --list

# Install dependencies
install:
    npm install

# Run the agent (requires .env)
run:
    npm start

# Run in dev mode with .env file
dev:
    npm run dev

# Lint (biome) + type-check (tsc)
check:
    npm run check

# Remove build artifacts and node_modules
clean:
    rm -rf node_modules dist

# Reinstall from scratch
fresh: clean install
