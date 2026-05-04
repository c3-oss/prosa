# Repository Guidelines

## Project Structure & Module Organization

`prosa` is a Node 22 TypeScript CLI for compiling, searching, and exporting local agent session histories. Source lives under `src/`: CLI commands in `src/cli/commands/`, entrypoints in `src/bin/` and `src/cli/main.ts`, storage and schema logic in `src/core/`, importers in `src/importers/`, services in `src/services/`, MCP support in `src/mcp/`, and Ink TUI code in `src/tui/`. Tests live in `test/`, with fixtures in `test/fixtures/` and shared helpers in `test/helpers/`. Design and recovery notes are in `docs/`. Generated output belongs in `dist/`.

## Build, Test, and Development Commands

Use pnpm from a `devbox shell` when possible.

- `pnpm install` installs dependencies from `pnpm-lock.yaml`.
- `pnpm dev -- <command>` runs the CLI through SWC, for example `pnpm dev -- sessions`.
- `pnpm build` bundles ESM output and declarations with tsup.
- `pnpm test` runs the Vitest suite once.
- `pnpm test:watch` runs Vitest interactively.
- `pnpm test:coverage` generates coverage.
- `pnpm typecheck` runs `tsc --noEmit`.
- `pnpm lint` checks Biome formatting and lint rules.
- `pnpm lint:fix` or `pnpm format` applies automatic fixes.
- `pnpm clean` removes `coverage`, `dist`, and `.turbo`.

## Coding Style & Naming Conventions

The project is strict TypeScript using NodeNext modules and ESM imports. Biome enforces 2-space indentation, single quotes, semicolons, trailing commas, and a 100-column line width. Prefer named exports, `import type` for type-only imports, and explicit domain types under `src/core/domain/`. File names are lowercase kebab-case where the repository already uses them, such as `tmp-bundle.ts`.

## Testing Guidelines

Vitest runs Node tests matching `test/**/*.test.ts`. Place importer tests under `test/importers/`, CLI behavior tests under `test/cli/`, and storage or migration tests under `test/core/` or `test/cas/`. Keep fixtures deterministic and small; prefer temporary bundles via helpers.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects, for example `Add filtered session counts`, with occasional conventional prefixes such as `chore:`. Keep commits focused on one behavioral change. Pull requests should include a clear description, issue links, user-facing command examples when behavior changes, and test results such as `pnpm test`, `pnpm typecheck`, and `pnpm lint`. Include screenshots only for TUI changes.

## Agent-Specific Instructions

Respect existing generated directories and user data. Do not edit `dist/`, `coverage/`, `node_modules/`, or `.devbox/` by hand. When changing importers, preserve raw source bytes and update fixtures or docs that describe recovered formats.
