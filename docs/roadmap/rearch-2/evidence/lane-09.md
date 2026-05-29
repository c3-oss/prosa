# Lane 9 Evidence — Migration

Status: accepted by Codex/governor on 2026-05-21. Focused review on
2026-05-20 opened CQ-158 through CQ-161; all are now closed for Lane 9.

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
   - `apps/cli/src/cli/commands/migrate-v2.ts` — `prosa v2 migrate
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

## Governor Review Blockers — final review rejected 2026-05-21

- **CQ-158 (closed):** `apps/api/src/v2/migrate/tenant.ts` now drains the
  bundle's sealed `session`, `raw_record`, and `source_file` projection
  NDJSON segments, derives a per-store mapping via
  `(raw_record_id → canonical source_file_id → legacy source_file_id)`
  on `content_hash`, and inserts `projection_session` rows under the
  same `(tenant, store, receipt)` triple Lane 6 reads gate on. Per-store
  gaps now block authority upsert AND legacy v1 receipt archive (CQ-158
  fail-closed). `tryFetch` recomputes BLAKE3 of the fetched bytes and
  rejects same-size corrupted payloads as `raw_bytes_corrupted`. New
  v2-only end-to-end test mounts `registerV2Routes`, POSTs
  `/v2/migrate/tenant`, then `/v2/reads/sessions/list`, and asserts the
  migrated session is returned:
  ```text
  pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-reads-e2e.test.ts
  Test Files  1 passed (1)
  Tests       2 passed (2)
  ```
  Updated `legacy-receipts-archived.test.ts` confirms a gap-blocked
  store has no authority row, no archive movement, and no
  projection_session rows.

- **CQ-159 (closed):** the migrator now issues one signed v2 receipt
  per migrated store (not a synthetic `migration-multi`), with each
  store's `remote_authority_v2.current_receipt_id` matching a
  `receipt(receipt_id, store_id)` for that store. v1 receipts are
  archived per real store. `tenant-multistore.test.ts` now exercises
  the PUBLIC `/v2/stores/<store>/authority` route for each migrated
  store and asserts the response carries the per-store
  `receiptId` + `storeId` from the signed receipt payload:
  ```text
  pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-multistore.test.ts
  Test Files  1 passed (1)
  Tests       1 passed (1)
  ```
  Receipt provenance model: per-store receipts carry the SAME
  tenant-wide `bundleRoot` / `rawSourceRoot` / counts because all
  stores were migrated through one shared bundle. This tenant-wide
  authority-root semantic is explicitly documented in
  `apps/api/src/v2/migrate/tenant.ts` under the CQ-159 comment block;
  Lane 6 reads only join on `(tenant_id, store_id, receipt_id)` so
  cross-store row leaks are still impossible. Per-store roots can be
  added later by reshaping `buildMigrationReceiptPayload` without
  changing the call sites.

- **CQ-160 (closed):** `apps/api/src/v2/migrate/index.ts` rejects any
  request body that sets `serverRegion` with a 400 `INVALID_REQUEST`;
  the migrate handler uses the server-owned region (config default
  `'local'`) only. `tenant-receipt-provenance.test.ts` pins both the
  rejection path and the signed-payload contents:
  ```text
  pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-receipt-provenance.test.ts
  Test Files  1 passed (1)
  Tests       2 passed (2)
  ```

- **CQ-161 (closed):**
  - **Read-only proof via temp copy.** `apps/cli/src/cli/v2/migrate/bundle.ts`
    now copies the operator's v1 bundle to a fresh temp directory
    (`copyV1ToTemp`) and opens THAT copy through the mutable
    `openBundleV1` opener. Any pending v1 schema migrations or
    `manifest.json` rewrites run inside the temp copy only; the
    operator's source bundle is never opened mutably. The temp copy
    is removed on both success and error paths. The archive rename
    at the end of the migrate path therefore captures the original
    byte-identical v1 bundle.
  - **Content-hashed snapshot.** `snapshotV1Bundle` now records a
    SHA-256 content hash for every `raw/sources` file (in addition
    to manifest + db hashes) so same-name/same-size corruption is
    detected. The new regression "snapshot detects same-name
    same-size raw_sources corruption" overwrites a raw_sources file
    with same-length but different bytes via the deterministic
    `_beforeResnapshot` hook and asserts the migrate aborts with
    `MigrationError(stage='validate')`.
  - **Deterministic mid-flight mutation guard.** The previous
    `setTimeout(..., 5)` race regression is replaced with the
    `_beforeResnapshot` hook so the test is deterministic. The
    governor-reproduced "resolved instead of rejected" failure is
    no longer possible because the tamper runs synchronously before
    the resnapshot.
  - **`MigrationError(stage='validate')` on resnapshot failures.**
    The post-reproject resnapshot is wrapped so JSON parse errors,
    IO errors, or any other read failures during the verification
    surface as `MigrationError(stage='validate')` (rather than the
    raw `SyntaxError` previously surfacing through). The archive
    rename is skipped on every failure path so the v1 source is
    preserved.
  - **Marker-owned pre-archive cleanup.** `recoverFromMigrationMarker`
    now handles the pre-archive crash state: when the marker
    exists, `oldPath` still exists (first rename never landed), AND
    the marker-recorded `newPath` is non-empty, the marker-owned
    `newPath` is reaped BEFORE the marker is removed. Without this,
    the next migration run would see an unprovable non-empty
    operator path at `newPath` and refuse. The regression
    "CQ-161: pre-archive crash with marker + oldPath + non-empty
    newPath" plants the exact crash state and asserts both the
    marker and the marker-owned temp are gone after recovery.
  - **`reapStaleNewPath` refuses unmarked operator data.** Existing
    behavior preserved: a non-empty `newPath` without a matching
    marker throws `MigrationError(stage='discovery')` and the
    operator data is preserved byte-for-byte.
  - Full focused gate:
    ```text
    pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/
    Test Files  5 passed (5)
    Tests       15 passed (15)
    ```
  - Performance gate (1.4 GB end-to-end timing): explicitly rescoped
    to a Lane 10 follow-up so the production object-store adapter can
    be exercised in CI. The in-process fixtures + atomic-rename +
    recovery + same-name corruption + non-empty-newPath regressions
    cover the load-bearing Lane 9 invariants. The rescope mirrors the
    original Slice 1 deferral noted under "Open CQs / Notes".

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
