---
name: prosa-dev-workflow
description: Local development workflow for the prosa monorepo. Use when orienting in the workspace, choosing pnpm or Turbo commands, running CLI subcommands, picking the right validation lane, or making cross-package changes that are not tied to a single domain skill.
---

# Prosa Dev Workflow

Use this skill for repo orientation, command selection, and everyday implementation hygiene across the workspace.

## Monorepo Shape

Prosa is a pnpm + Turbo workspace. Workspace globs (`pnpm-workspace.yaml`): `apps/*`, `packages/*`.

- `apps/cli/` — published `prosa` CLI. Entrypoint `apps/cli/src/cli/main.ts`; subcommands under `apps/cli/src/cli/commands/`; Ink TUI under `apps/cli/src/tui/`; auth and sync glue under `apps/cli/src/cli/auth/` and `apps/cli/src/cli/sync/`.
- `apps/api/` — multi-tenant Fastify + tRPC server (`apps/api/src/{server,app,trpc,http,auth,db,storage,config}.ts`, routers under `apps/api/src/trpc/routers/`).
- `packages/prosa-core/` — local-first bundle, importers, services, MCP. Source under `packages/prosa-core/src/{core,importers,services,mcp}/`; tests under `packages/prosa-core/test/`.
- `packages/prosa-db/` — Drizzle schema and migrations for Postgres (`src/schema/{auth,objects,projection,sync}.ts`).
- `packages/prosa-storage/` — object store abstraction with `memory`, `fs`, `s3` adapters.
- `packages/prosa-sync/` — shared sync schemas and protocol types reused by CLI and API.
- `.changeset/` — Changesets workflow drives versioning and changelogs (`pnpm changeset`, `pnpm version-packages`, `pnpm release`).

Architecture and source-format references live in `docs/`; start at `docs/README.md`. Key references: `docs/architecture/bundle-format.md` (schema/CAS contract), `docs/architecture/import-pipeline.md` (`compile` flow), `docs/architecture/search-engines.md` (FTS5 vs. Tantivy), `docs/architecture/server-sync.md` (promotion protocol).

## CLI Surface

The published CLI exposes these subcommands (see `apps/cli/src/cli/main.ts`):

`init`, `compile`, `compile-all`, `index`, `sessions`, `search`, `export`, `query`, `analytics`, `doctor`, `mcp`, `tui`, `auth`, `sync`.

Use `pnpm dev -- <subcommand> …` for manual runs (for example `pnpm dev -- compile codex --store <tmp>`). Do not point manual checks at the user's real `~/.prosa` store.

## Commands

Prefer `devbox shell` before running project commands when available. Turbo fans these out per package; filter with `pnpm --filter <pkg>` when iterating on one workspace.

```bash
pnpm install
pnpm dev -- <prosa-command>
pnpm build
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm lint
pnpm lint:fix
pnpm format
pnpm clean
```

Per-workspace tests live under `packages/<pkg>/test/` and `apps/<app>/test/`. Run focused suites via `pnpm --filter @c3-oss/prosa-core test test/importers/codex.test.ts` (or the equivalent app filter).

## Implementation Rules

- Strict TypeScript, NodeNext modules, ESM imports across every workspace.
- Biome owns style: 2 spaces, single quotes, semicolons, trailing commas, 100-column lines.
- Prefer existing helper APIs over new parallel utilities: `prepare`, `transactional`, `putBytes`, `putJson`, `registerSourceFile`, and ID helpers in `packages/prosa-core/src/core/domain/ids.ts`.
- Keep generated output out of hand edits: `dist/`, `coverage/`, `.turbo/`, `.devbox/`, `node_modules/`.

## Validation

Run the smallest useful checks first. Before finishing a meaningful change, prefer:

```bash
pnpm typecheck
pnpm test
pnpm lint
```

For importer or schema work, also run the focused suite, for example `pnpm --filter @c3-oss/prosa-core test test/importers/codex.test.ts`.

## Commit Hygiene

- Never bundle every change into one commit. Split work into sequential commits, one per coherent slice — schema migration vs. service rewrite vs. CLI vs. tests vs. docs are usually distinct commits.
- Order commits so each builds on the previous: foundations (schemas, new services) before consumers (CLI, MCP, API), code before docs.
- Commit message style follows commitlint: `type(scope): subject`. Allowed scopes (see `commitlint.config.cjs`): `cli`, `mcp`, `core`, `importers`, `services`, `tui`, `docs`, `test`, `deps`, `release`, `infra`, `api`, `sync`, `auth`. Body lines stay ≤ 100 chars.
- A single big mixed commit usually means the work was not split into clean chunks; pause and stage by file/topic instead of `git add -A`.
- User-facing changes need a Changeset (`pnpm changeset`); the file lands in `.changeset/` and travels with the same PR.
