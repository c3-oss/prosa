# Repository Guidelines

## Project Structure & Module Organization

`prosa` is a Node 22 TypeScript CLI for compiling, searching, exporting, and
analyzing local agent session histories. This is a pnpm/Turbo monorepo with
the CLI package in `apps/cli` and reusable runtime APIs in
`packages/prosa-core`. CLI commands live in `apps/cli/src/cli/commands/`,
entrypoints in `apps/cli/src/bin/` and `apps/cli/src/cli/main.ts`, storage and
schema logic in `packages/prosa-core/src/core/`, importers in
`packages/prosa-core/src/importers/`, services in
`packages/prosa-core/src/services/`, MCP support in `packages/prosa-core/src/mcp/`,
and Ink TUI code in `apps/cli/src/tui/`. Tests and fixtures live under each
package or app `test/` directory. Architecture and source-format references are
in `docs/` (see `docs/README.md`). Generated output belongs in package-local
`dist/`.

## Build, Test, and Development Commands

Use pnpm from a `devbox shell` when possible.

- `pnpm install` installs dependencies from `pnpm-lock.yaml`.
- `pnpm dev -- <command>` runs the CLI through SWC, for example `pnpm dev -- sessions`.
- `pnpm dev:all` runs all workspace `dev` tasks through Turbo.
- `pnpm build` bundles ESM output and declarations with tsup.
- `pnpm test` runs the Vitest suite once.
- `pnpm test:watch` runs Vitest interactively.
- `pnpm test:coverage` generates coverage.
- `pnpm typecheck` runs `tsc --noEmit`.
- `pnpm lint` checks Biome formatting and lint rules.
- `pnpm lint:fix` or `pnpm format` applies automatic fixes.
- `pnpm clean` removes `coverage`, `dist`, and `.turbo`.

## Coding Style & Naming Conventions

The project is strict TypeScript using NodeNext modules and ESM imports. Biome enforces 2-space indentation, single quotes, semicolons, trailing commas, and a 100-column line width. Prefer named exports, `import type` for type-only imports, and explicit domain types under `packages/prosa-core/src/core/domain/`. File names are lowercase kebab-case where the repository already uses them, such as `tmp-bundle.ts`.

## Testing Guidelines

Vitest runs Node tests matching package-local `test/**/*.test.ts`. Place CLI
behavior tests under `apps/cli/test/cli/`; importer, service, storage, migration,
CAS, MCP, fixture, and helper tests belong under `packages/prosa-core/test/`.
Keep fixtures deterministic and small; prefer temporary bundles via helpers.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects, for example `Add filtered session counts`, with occasional conventional prefixes such as `chore:`. Keep commits focused on one behavioral change. Pull requests should include a clear description, issue links, user-facing command examples when behavior changes, and test results such as `pnpm test`, `pnpm typecheck`, and `pnpm lint`. Include screenshots only for TUI changes.

## Agent-Specific Instructions

Respect existing generated directories and user data. Do not edit `dist/`, `coverage/`, `node_modules/`, or `.devbox/` by hand. When changing importers, preserve raw source bytes and update fixtures or docs that describe recovered formats.
