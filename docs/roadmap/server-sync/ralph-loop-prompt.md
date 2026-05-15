You are implementing the Prosa server-sync roadmap in this repository.

Read these docs first and treat them as the source of truth:
- docs/roadmap/server-sync/01-api-foundation.md
- docs/roadmap/server-sync/02-auth-tenancy.md
- docs/roadmap/server-sync/03-remote-store-schema.md
- docs/roadmap/server-sync/04-sync-protocol.md
- docs/roadmap/server-sync/05-cli-auth-sync.md
- docs/roadmap/server-sync/06-query-remote-ops-tests.md
- AGENTS.md
- docs/architecture/bundle-format.md
- docs/architecture/import-pipeline.md

Available local tooling:
- Docker is available. Use it for local Postgres, object-store substitutes, and
  true end-to-end test environments instead of mocking away integration risks.
- `psql` is available. Use it when direct queries against the local test
  database help verify migrations, tenant isolation, row counts, or sync state.
- Prefer reproducible Docker-based setup for services needed by tests.

Critical product requirements:
- Prosa is local-first only before auth/sync.
- There is no pull command and no remote-to-local bundle reconstruction.
- After login and successful `prosa sync`, the local `.prosa` bundle is promoted to the server, verified, and removed unless `--keep-local` is explicitly used.
- Even with `--keep-local`, the local bundle must no longer be authoritative after promotion.
- After promotion, CLI reads and heavy work (`sessions`, `search`, `query`, `analytics`, `export`, `mcp`, `tui`) must use the server for the active tenant.
- Device B must log in and query the server directly. It must not pull or rebuild `.prosa`.
- Postgres stores auth, tenancy, sync/upload state, metadata, canonical projection rows, search docs, reports, and export metadata.
- S3-compatible object storage stores CAS bytes, raw source copies, large artifacts, and generated exports.
- Filesystem object storage is only for dev/self-host single-node. Memory object storage is only for tests.
- Do not store `prosa.sqlite`, Tantivy, Parquet, or local exports as authoritative remote state.

Work sequentially by lane:
1. API foundation
2. Auth and tenancy
3. Remote store and object storage
4. One-way promotion protocol
5. CLI auth and sync promotion
6. Server-side reads, operations, and tests

At the beginning of each iteration:
- Inspect the current git status and existing implementation.
- Identify the first incomplete lane.
- Continue from there. Do not restart completed work.
- Preserve user changes. Do not revert unrelated changes.
- Do not touch generated directories by hand: dist, coverage, node_modules, .devbox.
- Never run tests against a real ~/.prosa store. Use temporary bundles only.

Implementation expectations:
- Follow the monorepo conventions already in the repo.
- Use TypeScript ESM/NodeNext, pnpm, Turbo, Biome, Vitest.
- Keep code split into apps/packages that match the roadmap.
- Prefer small, coherent commits. Commit after a lane is implemented and validated. Do not push.
- Update docs when behavior, commands, env vars, or architecture change.
- Add tests with each meaningful feature. Do not leave major behavior untested.
- Add real E2E coverage for the promotion flow. The E2E path must exercise the
  CLI, API server, Postgres, and object storage adapter together.

Validation expectations:
- Run the smallest useful focused tests while iterating.
- Before committing a lane, run that lane's relevant tests, typecheck, and lint where practical.
- For server/auth/storage/sync work, start the required local services with
  Docker and run E2E tests that prove the full system works together.
- Use `psql` against the local test database when useful to confirm actual
  persisted rows, tenant boundaries, object metadata, batches, and promotion
  receipts.
- Before declaring completion, run:
  - pnpm i
  - just typecheck
  - just test-all
  - just lint-all
  - just build-all
  - the full Docker-backed E2E suite
- If a command cannot run because an external service is missing, add a documented local/test substitute and explain the remaining manual requirement.

Completion rule:
Only output RALPH_DONE when all six lanes are implemented, documented,
committed in coherent commits, Docker-backed E2E tests pass, and the final
validation gate has passed or every unavoidable external-service gap is
documented with a reproducible fallback. Until then, keep working on the next
incomplete lane.
