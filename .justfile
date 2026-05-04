# Show all available recipes.
default:
  just --list

# Install dependencies from pnpm-lock.yaml.
install:
  pnpm install

# Build the distributable package into dist/.
build:
  pnpm build

# Run the Vitest suite once.
test:
  pnpm test

# Run Biome lint/format checks without writing changes.
lint:
  pnpm lint

# Run TypeScript type checking without emitting files.
typecheck:
  pnpm typecheck

# Remove generated local outputs such as dist/, coverage/, and .turbo/.
clean:
  pnpm clean

# Run the standard pre-release quality gate.
quality:
  pnpm typecheck
  pnpm test
  pnpm lint

# Create a new Changeset entry describing the next package release.
changeset:
  pnpm changeset

# Apply pending Changesets to package versions and changelog files.
version-packages:
  pnpm version-packages

# Build and publish changed packages to the official npm registry.
release:
  pnpm release
