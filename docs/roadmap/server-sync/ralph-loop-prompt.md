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

Mandatory correction queue before RALPH_DONE:
- Fix tenant authorization before adding more tenant procedures. The API context
  must resolve the authenticated user's membership for the selected tenant, and
  `tenantProcedure` must reject non-members. `adminTenantProcedure` must allow
  real admin/owner members and reject normal members.
- Do not trust `x-prosa-tenant-id` or explicit tenant inputs without checking
  Better Auth organization membership in the database.
- Implement the CLI/device login requirement with Better Auth device
  authorization, including server-side plugin wiring and stable CLI-facing
  wrappers for device code and token polling. Email/password CLI login can
  remain useful for tests, but it is not sufficient for the roadmap.
- Make `PROSA_AUTH_SECRET`, `PROSA_DATABASE_URL`, and production object-store
  configuration fail-fast required in non-test/non-dev server startup. Do not
  allow a deployed server to use a static fallback auth secret.
- Make signup-with-tenant cohesive. If user creation, tenant creation, admin
  membership, active tenant setup, or token/session creation fails, do not leave
  a half-created tenant flow visible as success. Add failure-path tests.
- Complete the lane 2 public/protected/admin procedure surface or explicitly
  document any intentionally deferred procedures with tests proving no route
  depends on the missing behavior.
- Add production migrations or a checked-in migration path. Server startup must
  apply or verify the expected schema before accepting API traffic.
- Ensure root `pnpm build` and Turbo include every new workspace package:
  `apps/api`, `packages/prosa-db`, `packages/prosa-storage`, and
  `packages/prosa-sync`.
- Tighten remote schema tenant boundaries. Tenant-owned child rows must not be
  able to reference parent rows from another tenant. Use composite
  `(tenant_id, id)` constraints where possible or enforce equivalent checks
  transactionally in upload commits with tests.
- Tighten object ownership. Tenant projection rows must not reference a global
  object unless that tenant has a matching `tenant_object` provenance row.
- Preserve the local raw-store contract remotely. Source files and raw records
  must include the idempotency and provenance needed to reconstruct projections:
  source file kind/size/mtime/content hash, raw object id, decoded JSON object
  id when applicable, parser status, confidence, and import batch linkage.
- Object store adapters and HTTP object upload must verify BLAKE3 content and
  declared size metadata. Repeated `putIfAbsent` must reject conflicting bytes
  or metadata for an existing key instead of treating conflicts as success.
- Add tests for tenant isolation, non-member denial, member-vs-admin behavior,
  signup failure cleanup, device auth flow, cross-tenant row/object attachment
  rejection, object conflict rejection, upload replay idempotency, promotion
  verification, cleanup failure handling, and server-side reads after promotion.
- Add Docker-backed E2E tests that exercise CLI + API + Postgres + object-store
  adapter together. The E2E test must show Device A promotes a temporary bundle,
  local data is removed or marked non-authoritative, and Device B queries the
  same tenant remotely without any pull/rebuild step.

Current monitor findings that must be rechecked and fixed:
- As of 2026-05-15T02:11:22-03:00, `apps/api/src/trpc/context.ts` still had
  `memberRole` initialized to `null`. Do not proceed to completion until real
  membership resolution is implemented and tested.
- As of 2026-05-15T02:11:22-03:00, `apps/api/src/auth.ts` still did not wire
  Better Auth `deviceAuthorization()`. Do not proceed to completion until CLI
  device login exists and is tested.
- As of 2026-05-15T02:11:22-03:00, `apps/api/src/auth.ts` still allowed a
  static fallback auth secret. Do not proceed to completion until production
  startup fails fast without a real `PROSA_AUTH_SECRET`.
- As of 2026-05-15T02:11:22-03:00, E2E coverage appeared to be skipped unless
  external env vars are provided. Do not count that as the required full
  Docker-backed E2E gate unless the repo also provides a reproducible command
  that starts services and runs the suite.
- As of 2026-05-15T02:11:22-03:00, read routing and server-side sessions/search
  were in progress. Confirm `sessions` and `search` use the server after
  promotion and never read leftover `.prosa` data after the authority switch.
- As of 2026-05-15T02:45:45-03:00, the CLI still appeared to upload only
  sessions and search docs (`sourceFiles: []`, `rawRecords: []`, `objects: []`)
  while also deleting local `objects/` and `raw/` by default. This is a
  data-loss blocker. Either implement full raw/CAS promotion before cleanup, or
  disable/descope destructive local cleanup until raw source files, raw records,
  CAS objects, artifacts, and source file provenance are actually uploaded and
  verified.
- As of 2026-05-15T02:45:45-03:00, object HTTP routes still appeared to resolve
  tenant from `x-prosa-tenant-id`/active org outside the same membership check
  used by tRPC context. Object routes must reject non-members and must not allow
  tenant header spoofing.
- As of 2026-05-15T02:45:45-03:00, `verifyPromotion` still needed to prove the
  uploaded batch, sample sessions, expected counts, object availability, and
  search/read behavior before a promotion receipt can authorize cleanup.
- As of 2026-05-15T02:45:45-03:00, tests still needed to stop accepting empty
  object arrays as proof of promotion. Add failing tests for a bundle containing
  at least one CAS object/raw record/source file, and assert those are uploaded
  and tenant-owned before cleanup is allowed.
- As of 2026-05-15T03:17:11-03:00, the in-progress CLI raw/source-file readers
  appeared to query local SQLite columns that do not exist:
  `source_files.source_path`, `source_files.raw_record_id`,
  `raw_records.line_number`, and `raw_records.payload_object_id`. The local
  schema uses `source_files.path`, `source_files.object_id`,
  `raw_records.line_no`, `raw_records.raw_object_id`, and
  `raw_records.decoded_json_object_id`. Add tests that run `prosa sync` against
  a real initialized local bundle with at least one source file, raw record, and
  CAS object so invalid SQL cannot slip through.
- As of 2026-05-15T03:17:11-03:00, the CLI CAS walk computes BLAKE3 over the
  stored compressed bytes and sends that as the object hash, while local
  `object_id` is BLAKE3 of the uncompressed payload. If the server stores a
  transport hash, name it separately; do not overwrite canonical CAS semantics.
  The remote object model must preserve local `object_id = blake3:<uncompressed
  hash>` and compression metadata.
- As of 2026-05-15T03:28:30-03:00, `apps/cli/test/cli/sync-cas.test.ts` still
  created `source_files` with invalid legacy columns and swallowed the failure.
  That test proves CAS bytes, but not source file or raw record promotion.
  Update it to insert rows using the real local schema and assert
  `sourceFiles.length > 0`, `rawRecords.length > 0`, and server-side
  persistence for both. Avoid broad `catch { return [] }` paths in sync readers
  that can hide schema drift and still allow cleanup/remote-authority marking.

Completion rule:
Only output RALPH_DONE when all six lanes are implemented, documented,
committed in coherent commits, Docker-backed E2E tests pass, and the final
validation gate has passed or every unavoidable external-service gap is
documented with a reproducible fallback. Until then, keep working on the next
incomplete lane.
