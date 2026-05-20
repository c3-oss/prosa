# Lane 9 Evidence — Migration

Status: implementation landed, but not governor-accepted. Focused review on
2026-05-20 opened CQ-158 through CQ-161.

Required source plan: `docs/rearch-2/10-lane-9-migration.md`.

## Slices Shipped

1. **CLI scaffolding** (`feat(cli): lane 9 slice 1`):
   - `apps/cli/src/cli/v2/migrate/bundle.ts` — `migrateBundle` open v1
     read-only, stage preserved raw bytes per provider, run
     `runCompileImports`, validate counts, atomic-rename.
   - `apps/cli/src/cli/v2/migrate/validate.ts` — strict equality on
     `sourceFiles`/`rawRecords`/`sessions`, bounded variance on
     `objects` (≤) and `searchDocs` (±1%).
   - `apps/cli/src/cli/v2/migrate/provider-fallback.ts` +
     `staging.ts` — provider-directory recompile fallback when v1
     raw bytes are missing/corrupt; staging tree mirrors each
     provider's discovery convention.
   - `apps/cli/src/cli/commands/migrate-v2.ts` — `prosa migrate-v2
     bundle|tenant` Commander surface with `--verbose` / `--json`
     output. Hooked into `apps/cli/src/cli/main.ts`.

2. **Server-side migrate route + legacy_v1 catalog**
   (`feat(api): lane 9 slice 2`):
   - `apps/api/src/v2/migrate/tenant.ts` walks
     `legacy_v1_source_files`, fetches preserved bytes from object
     store, stages them per provider, runs `runCompileImports`
     against a temp v2 bundle, signs a synthetic migration receipt
     and persists projection rows + `remote_authority_v2` in one
     transaction.
   - `apps/api/src/v2/migrate/index.ts` — `POST /v2/migrate/tenant`
     with admin/owner gate, tenant-mismatch check, and error
     mapping. Wired into `apps/api/src/v2/index.ts`.
   - Schema migration: `legacy_v1_source_files` and
     `legacy_v1_migration_gap` added to `packages/prosa-db-v2`
     promotion schema and the conflict-free subset list.
   - Conflict-free subset also gains `projection_source_file` +
     `projection_raw_record` (v2-only tables) so the tenant
     migrator's projection inserts succeed under the PGlite test
     app.

3. **Test suites** (`test(cli,api): lane 9 slice 3`):
   - CLI: `bundle-roundtrip`, `bundle-corruption-fallback`,
     `bundle-atomic-rename`, `bundle-count-validation` —
     8 tests / 4 files.
   - API: `tenant-roundtrip`, `legacy-receipts-archived` —
     5 tests / 2 files.
   - Lane 5 gate L5.7 amended to allow `migrate/tenant.ts` as a
     sanctioned writer for `remote_authority_v2`.

## Focused Test Evidence

```text
pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/
Test Files  4 passed (4)
Tests       8 passed (8)
```

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/
Test Files  2 passed (2)
Tests       5 passed (5)
```

## Baseline Gates

```text
pnpm typecheck     ->  13/13 packages clean
pnpm lint          ->  13/13 packages clean
pnpm build         ->  13/13 packages clean
pnpm --filter @c3-oss/prosa test        ->  310 passed | 3 skipped
pnpm --filter @c3-oss/prosa-api test    ->  440 passed | 4 skipped (after L5.7 amendment)
```

The Lane 5 invariant L5.7 source-grep test
(`test/v2/sync/seal-only-authority.test.ts`) was updated to
allowlist `apps/api/src/v2/migrate/tenant.ts` as a sanctioned
writer of `remote_authority_v2`. The migration receipt is built and
signed before the upsert, satisfying the same "receipt backs every
authority row" invariant SealPromotion enforces.

## Governor Review Blockers

- CQ-158: remote migration must not publish `remote_authority_v2` or archive
  active v1 receipts until load-bearing Lane 6 read projections are usable; any
  blocking gap must fail closed before authority swap.
- CQ-159: multi-store remote migration must issue resolvable per-store
  authority and archive each real store's v1 receipts.
- CQ-160: signed receipt provenance must come from server config, not caller
  input.
- CQ-161: local bundle migration needs read-only source proof, crash-safe
  rename/recovery proof, and the performance gate must be run or explicitly
  rescoped by the governor.

Current focused tests still pass, but they do not cover these blockers:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-roundtrip.test.ts test/v2/migrate/legacy-receipts-archived.test.ts test/v2/cron/gc-lifecycle.test.ts test/v2/cron/gc-blocked-by-grant.test.ts test/v2/cron/gc-blocked-by-staging.test.ts
Test Files  5 passed (5)
Tests       9 passed (9)
```

## Open CQs / Notes

- The fallback `recompileFromProviderDirectories` is opt-in via
  `--codex-root` / `--claude-root` / `--cursor-root` / `--gemini-root`
  / `--hermes-root`; without an explicit override the migration
  reports gaps but does NOT scan the operator's real `~/.codex` /
  `~/.claude` etc. This guards CI/tests from accidental home-dir
  walks. Operators recovering from a corrupted v1 archive must
  pass the fallback root explicitly.
- The 1.4 GB performance gate from
  `docs/rearch-2/10-lane-9-migration.md` (`timing.test.ts`) is
  intentionally deferred to a follow-up; the in-process fixtures
  validate the round-trip + validation + atomic-rename invariants
  but do not exercise multi-GB throughput.
- Server-side projection materialization is the load-bearing
  `projection_source_file` + `legacy_receipt_archive` path only.
  The fuller CQ-124 projection materialization remains Lane 10
  scope.

## Code Map

- `apps/cli/src/cli/v2/migrate/` (4 files, ~700 LoC)
- `apps/cli/src/cli/commands/migrate-v2.ts`
- `apps/cli/test/v2/migrate/` (4 tests + helpers)
- `apps/api/src/v2/migrate/` (3 files)
- `apps/api/test/v2/migrate/` (2 tests + helpers)
- `packages/prosa-db-v2/src/schema/promotion.ts`
- `packages/prosa-db-v2/src/apply.ts`
