---
name: prosa-dev-workflow
description: Local development workflow for the prosa TypeScript CLI. Use when Codex needs to set up the repo, run or debug CLI commands, choose validation commands, understand project layout, or make general non-domain-specific changes in prosa.
---

# Prosa Dev Workflow

Use this skill for repo orientation, command selection, and everyday implementation hygiene.

## Repo Shape

- Runtime source is under `src/`.
- CLI commands live in `src/cli/commands/`; the CLI entrypoint is `src/cli/main.ts`.
- Core bundle, SQLite, CAS, schema, and ingest helpers live in `src/core/`.
- Importers live in `src/importers/{codex,claude,gemini,cursor}/`.
- User-facing services live in `src/services/`.
- Tests live in `test/`, with fixtures in `test/fixtures/` and helpers in `test/helpers/`.
- Architecture notes live in `docs/`; use `docs/gpt-5-pro-response.md` for format intent.

## Commands

Prefer `devbox shell` before running project commands when available.

```bash
pnpm install
pnpm dev -- <prosa-command>
pnpm build
pnpm test
pnpm test:watch
pnpm test:coverage
pnpm typecheck
pnpm lint
pnpm lint:fix
pnpm format
```

Use `pnpm dev -- init --store <tmp-store>` and `pnpm dev -- compile ... --store <tmp-store>` for manual CLI checks. Do not point tests at a real `~/.prosa` store.

## Implementation Rules

- Follow strict TypeScript, NodeNext modules, and ESM imports.
- Let Biome define style: 2 spaces, single quotes, semicolons, trailing commas, 100-column line width.
- Prefer existing helper APIs over new parallel utilities: `prepare`, `transactional`, `putBytes`, `putJson`, `registerSourceFile`, and ID helpers in `src/core/domain/ids.ts`.
- Keep generated output (`dist/`, `coverage/`, `.devbox/`, `node_modules/`) out of hand edits.

## Validation

Run the smallest useful checks first while iterating. Before finishing a meaningful change, prefer:

```bash
pnpm typecheck
pnpm test
pnpm lint
```

For importer or schema work, also run the affected focused tests, for example `pnpm test test/importers/codex.test.ts`.
