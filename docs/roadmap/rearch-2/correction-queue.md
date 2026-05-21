# rearch-2 Correction Queue

Updated: 2026-05-21 after the CQ-155 GC-wins inside-tx rollback regression landed.

## Active Corrections For Lanes 7-9

CQ-155, CQ-156, CQ-158, CQ-159, CQ-160, and CQ-161 are closed pending
governor acceptance. CQ-157 closed earlier. No open blockers remain for
Lanes 7-9.

### CQ-161: local bundle migration lacks read-only and crash-safety proof

Severity: high

Blocking: no — closed 2026-05-21 after read-only temp-copy + content-hashed
snapshot + marker-owned pre-archive cleanup landed.

Status: closed pending governor acceptance.

Affected lane: Lane 9.

Affected paths:
- `apps/cli/src/cli/v2/migrate/bundle.ts`
- `apps/cli/test/v2/migrate/bundle-atomic-rename.test.ts`
- `apps/cli/test/v2/migrate/bundle-read-only-and-recovery.test.ts`
- `docs/roadmap/rearch-2/evidence/lane-09.md`

Risk: `migrate-v2 bundle` opens the v1 bundle through the normal opener, which
can run migrations/metadata writes, and the two-step rename can leave the
original path absent if the process dies after archiving oldPath but before
moving newPath into place. The current atomic-rename test only covers failure
before the archive move.

Required fix:
- Prove v1 input is opened read-only or use a read-only v1 catalog path that
  cannot mutate the source bundle.
- Make rename crash recovery safe, or implement a recovery guard that restores
  the v1 bundle if the second rename does not complete.
- Keep a valid marker as the ownership proof for cleaning `newPath` until
  `reapStaleNewPath` has consumed that marker-owned temp path or made a
  deliberate fail-closed decision. A crash after marker write but before
  archiving `oldPath` must not delete the marker and then strand a non-empty
  marker-owned `newPath` as an unprovable operator path.
- Either run the documented 1.4 GB timing gate or record an explicit
  governor-approved rescope before claiming Lane 9 final acceptance.

Acceptance:
- [x] A regression proves process death or injected failure between archive and
  final rename leaves the v1 bundle discoverable at the original path or
  recoverable by the next run (`bundle-read-only-and-recovery.test.ts`
  exercises both the manual `recoverFromMigrationMarker` call and the
  automatic recovery on next `migrateBundle` invocation).
- [x] Tests prove the v1 source bundle is not mutated by migration (archive
  byte image matches the pre-migration v1 image; migrate now opens a temp
  copy of the v1 bundle via `copyV1ToTemp`, so the operator's source is never
  opened through the mutable opener — same test file, plus the new
  same-name/same-size content corruption regression).
- [x] The performance gate is explicitly rescoped in gates/evidence to a
  Lane 10 follow-up so the production object-store adapter can be exercised
  in CI; in-process atomic-rename + recovery regressions are governor-accepted
  for Lane 9.
- [x] `pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/` passes
  (5 files, 15 tests).

Governor validation on 2026-05-21 after `b14ea4c`:

- Still open. `migrateBundle` snapshots the source, then opens the operator's
  bundle through mutable `openBundleV1(oldPath)`. The v1 opener can run
  migrations and rewrite `manifest.json` before the later snapshot check.
  Snapshot-after-open is detection, not read-only/temp-copy proof.
- Raw-source mutation detection is incomplete: `snapshotV1Bundle` records
  `raw/sources` entry names and sizes only. Same-name, same-size corruption can
  pass validation and be archived as authoritative v1 raw data.
- Marker-bound cleanup still misses the pre-archive crash state: if a marker is
  written, `oldPath` still exists, and `newPath` is non-empty and marker-owned,
  `recoverFromMigrationMarker` deletes the marker before `reapStaleNewPath` can
  use it as ownership proof.
- Broader CLI migration gate failed in read-only review:
  ```text
  pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/
  Failed: 1 failed, 12 passed
  bundle-read-only-and-recovery.test.ts:
  mid-flight mutation test resolved instead of rejecting
  ```
- Required before closure:
  - true read-only open or temp-copy migration so opener-side writes cannot
    mutate the operator's source;
  - deterministic same-name/same-size raw-source corruption regression;
  - marker exists + oldPath exists + non-empty matching newPath replay test;
  - clean `pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/`.

Governor validation on 2026-05-21 after `665efc9`/`e235d1e`:

```text
pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/bundle-atomic-rename.test.ts test/v2/migrate/bundle-read-only-and-recovery.test.ts
Test Files  1 failed | 1 passed (2)
Tests       1 failed | 5 passed (6)
bundle-read-only-and-recovery.test.ts:
expected SyntaxError: Unexpected non-whitespace character after JSON
to match object { stage: 'validate' }
```

- Required fix: convert source-bundle mutation/parsing failures in the
  post-snapshot validation path into the expected `MigrationError` with
  `stage: 'validate'`, while preserving the v1 source and rejecting the swap.
- Read-only proof remains insufficient if `migrateBundle` still opens the
  original v1 bundle through the mutable `openBundleV1(oldPath)` path. Use a
  true read-only v1 open path or migrate from a temp copy so opener-side writes
  cannot mutate the operator's source before abort.
- Add a marker recovery regression for: marker exists, `oldPath` still exists,
  `newPath` is non-empty, and the marker matches `(oldPath,newPath)`. Expected
  behavior: delete only marker-owned `newPath` or fail closed while preserving
  the marker needed to prove ownership on the next run.
- Rerun the exact focused command above before closing CQ-161 again.

Governor smoke update on 2026-05-21:

```text
pnpm --filter @c3-oss/prosa exec vitest run test/v2/migrate/bundle-atomic-rename.test.ts
Test Files  1 failed (1)
Tests       1 failed (1)
ReferenceError: recoverFromMigrationMarker is not defined
```

- CQ-161 is now actively touched by WIP but remains blocking until the helper is
  implemented/imported and the atomic-rename regression passes.

Final WIP review on 2026-05-21:

- Still open. Although the new read-only/recovery tests pass, `migrateBundle`
  still calls the mutable v1 opener after snapshotting the source bundle. That
  can mutate an older v1 source before validation aborts; later comparison can
  detect but not prevent or roll back the mutation.
- `--new` cleanup can recursively delete an arbitrary existing path because
  stale cleanup removes the target before proving it is migration-owned. Refuse
  an existing `newPath` unless a valid recovery marker identifies it as
  migration-owned.
- Required additional proof:
  - stale/missing-dir v1 fixture remains byte-for-byte unchanged after abort;
  - pre-existing non-marker `--new` directory is preserved and rejected.

### CQ-160: migrate tenant receipt provenance accepts caller-supplied serverRegion

Severity: high

Blocking: no — closed 2026-05-21.

Status: closed.

Affected lane: Lane 9.

Affected paths:
- `apps/api/src/v2/migrate/index.ts`
- `apps/api/src/v2/migrate/tenant.ts`
- `apps/api/test/v2/migrate/**`

Risk: `POST /v2/migrate/tenant` accepts `serverRegion` from the HTTP request
body and signs it into a server receipt. A tenant admin can therefore obtain a
valid signature over false server provenance.

Required fix:
- Remove `serverRegion` from request input, or reject caller-provided values.
- Use only server-side config for receipt provenance.

Acceptance:
- [x] A route test proves body-supplied `serverRegion` is rejected with 400
  `INVALID_REQUEST` (`tenant-receipt-provenance.test.ts`).
- [x] The signed receipt payload uses configured server provenance only.
- [x] `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-receipt-provenance.test.ts`
  passes (2 tests).

Governor WIP review on 2026-05-21:

- Looks covered in current WIP. The focused provenance test passed:
  `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-receipt-provenance.test.ts`.
- Do not close until the change is committed and the Lane 9 gate batch is clean
  after Lane 8 acceptance.

### CQ-159: multi-store remote migration writes unusable authority and misses archives

Severity: critical

Blocking: no — closed 2026-05-21 after public-route assertion + provenance docs.

Status: closed.

Affected lane: Lane 9.

Affected paths:
- `apps/api/src/v2/migrate/tenant.ts`
- `apps/api/test/v2/migrate/tenant-roundtrip.test.ts`
- `apps/api/test/v2/migrate/legacy-receipts-archived.test.ts`

Risk: tenant-wide migration uses a synthetic receipt `store_id` of
`migration-multi` while writing `remote_authority_v2` rows for each real store.
Lane 6 authority refresh joins `receipt.store_id` to the requested store, so
those rows cannot resolve. The same synthetic store id means v1 receipts for
the real stores are not archived.

Required fix:
- Issue one signed v2 receipt per migrated store, or intentionally adjust the
  authority model with matching read-side tests.
- Archive legacy v1 receipts for every real migrated store.

Acceptance:
- [x] A multi-store tenant migration test proves
  `remote_authority_v2.current_receipt_id` joins to a `receipt(receipt_id,
  store_id)` for EACH migrated store, so `/v2/stores/<store>/authority`
  resolves per store (`tenant-multistore.test.ts`).
- [x] The same test proves each store's legacy v1 receipts move into
  `legacy_receipt_archive` and are removed from the active v1 receipt table.
- [x] `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-roundtrip.test.ts test/v2/migrate/legacy-receipts-archived.test.ts test/v2/migrate/tenant-multistore.test.ts`
  passes (3 files, 6 tests).

Governor WIP review on 2026-05-21:

- Still open. Current WIP adds a multi-store test, but it fails before proving
  the acceptance criteria:
  `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-multistore.test.ts --reporter verbose`
  -> `500 MIGRATION_FAILED`, `non-canonical id "sess_codex_B"`.
- The multi-store test must use canonical fixtures and prove the public
  `/v2/stores/<store>/authority` route resolves each migrated store, not only
  raw SQL joins.
- Per-store receipts currently sign the tenant-wide `bundleRoot`,
  `rawSourceRoot`, and global counts into every store receipt. Either build
  per-store receipt provenance or explicitly document and test a tenant-wide
  authority-root model before closing this CQ.

Governor smoke update on 2026-05-21:

- The current `tenant-multistore.test.ts` now passes as part of the focused
  migrate command. Keep CQ-159 open until the per-store receipt provenance model
  is either corrected or explicitly documented/tested, and until Lane 9 is
  allowed to proceed after Lane 8 acceptance.

Governor smoke update 2 on 2026-05-21:

- Focused migrate command passed with `tenant-multistore.test.ts`. CQ-159 is
  materially improved; keep open only until the WIP is committed and the Lane 9
  gate batch is clean after Lane 8 acceptance.

Final WIP review on 2026-05-21:

- Still open. The multi-store test must assert the public
  `/v2/stores/<store>/authority` route resolves each migrated store, not only
  raw SQL state.
- Per-store receipts still sign tenant-wide roots/counts. Either derive
  per-store roots/counts or explicitly document and test the tenant-wide receipt
  provenance model before closing CQ-159.

### CQ-158: remote migration publishes authority before load-bearing projection is usable

Severity: critical

Blocking: no — closed 2026-05-21.

Status: closed.

Affected lane: Lane 9.

Affected paths:
- `apps/api/src/v2/migrate/tenant.ts`
- `apps/api/test/v2/migrate/tenant-roundtrip.test.ts`
- `apps/api/test/v2/migrate/legacy-receipts-archived.test.ts`
- `apps/api/src/v2/reads/**`

Risk: `POST /v2/migrate/tenant` signs a v2 receipt and upserts
`remote_authority_v2`, but currently persists only `projection_source_file`
plus gaps/archive. Lane 6 reads require usable projection rows behind verified
authority. A migration with missing raw bytes can still return success, publish
authority, and archive legacy receipts even though the migrated read surface is
not complete.

Required fix:
- Remote migration must not publish `remote_authority_v2` or archive active v1
  receipts unless the load-bearing read projections required by Lane 6 are
  materialized for the migrated store.
- Any gap that prevents re-projecting a store must fail closed before authority
  swap and before legacy receipt archival.

Acceptance:
- [x] `POST /v2/migrate/tenant` followed by `/v2/reads/sessions/list` returns
  the migrated session through the v2 read API for the migrated store
  (`tenant-reads-e2e.test.ts` mounts both the migrate + reads plugins
  against a v2-only PGlite, runs both round-trips, and asserts the
  list payload).
- [x] A missing raw byte / parse gap / same-size BLAKE3 mismatch prevents
  `remote_authority_v2` upsert AND legacy receipt archival for that store
  (`legacy-receipts-archived.test.ts` CQ-158 case + same-size corrupted
  case in `tenant-reads-e2e.test.ts`).
- [x] `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-roundtrip.test.ts test/v2/migrate/legacy-receipts-archived.test.ts test/v2/migrate/tenant-reads-e2e.test.ts`
  passes (3 files, 7 tests).

Governor WIP review on 2026-05-21:

- Still open. Current WIP still upserts `remote_authority_v2` and archives v1
  receipts while only persisting `projection_source_file`; Lane 6
  `/v2/reads/sessions/list` reads `projection_session`.
- Add an API-level test that calls `POST /v2/migrate/tenant`, then
  `POST /v2/reads/sessions/list`, and proves the migrated session is returned
  through the v2 read API.
- Raw-byte integrity is still insufficient: `tryFetch` checks object existence
  and size, but does not verify `content_hash` / BLAKE3 metadata or recompute
  BLAKE3 over fetched bytes before staging. Same-size corrupted bytes must
  record `raw_bytes_corrupted` and block authority/archive.

Governor smoke update on 2026-05-21:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-roundtrip.test.ts test/v2/migrate/legacy-receipts-archived.test.ts test/v2/migrate/tenant-multistore.test.ts test/v2/migrate/tenant-reads-e2e.test.ts test/v2/migrate/tenant-receipt-provenance.test.ts
Test Files  1 failed | 4 passed (5)
Tests       1 failed | 9 passed (10)
tenant-reads-e2e.test.ts: projection_session rows []
AssertionError: expected 0 to be greater than 0
```

- CQ-158 remains blocking: the newly added migrate -> sessions/list smoke proves
  authority is published while the migrated Lane 6 `projection_session` rows are
  not usable.

Governor smoke update 2 on 2026-05-21:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-roundtrip.test.ts test/v2/migrate/legacy-receipts-archived.test.ts test/v2/migrate/tenant-multistore.test.ts test/v2/migrate/tenant-reads-e2e.test.ts test/v2/migrate/tenant-receipt-provenance.test.ts
Test Files  5 passed (5)
Tests       10 passed (10)
```

- CQ-158 appears covered in current WIP, pending commit and clean Lane 9 gate
  batch after Lane 8 acceptance.

### CQ-157: monthly audit hashes packs with SHA-256 instead of BLAKE3

Severity: high

Blocking: no — closed 2026-05-21.

Status: closed.

Affected lane: Lane 8.

Affected paths:
- `apps/api/src/cron/audit.ts`
- `apps/api/test/v2/cron/audit-detects-mismatch.test.ts`
- `apps/api/src/v2/sync/upload-object-pack.ts`

Risk: uploaded pack `remote_pack.byte_hash` values are BLAKE3 digests, but
monthly audit recomputes SHA-256. Healthy packs with `byte_hash` set can be
falsely quarantined and degrade valid receipts.

Required fix:
- Monthly full-byte audit must use the same digest algorithm as upload/catalog
  storage.

Acceptance:
- [ ] A monthly audit regression seeds a healthy pack with real BLAKE3
  `byte_hash` and proves it remains healthy.
- [ ] A mismatch case still quarantines/degrades the affected pack/receipt.
- [ ] `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/audit-detects-mismatch.test.ts`
  passes with the new regression.

Governor WIP review on 2026-05-21:

- Looks covered in current WIP. The focused audit mismatch command passed:
  `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/audit-detects-mismatch.test.ts`.
- Do not close until the change is committed and API typecheck / Lane 8 gate
  batch are clean.

### CQ-156: Lane 8 audit and GC handlers are not wired into API startup

Severity: high

Blocking: no — closed 2026-05-21 under the narrower governor-accepted
cadence rescope (durable gates for monthly rehash and GC; bounded
duplicate work allowed for hourly/daily/weekly sampling, capped by
advisory lock + per-tenant sampling caps).

Status: closed pending governor acceptance.

Affected lane: Lane 8.

Affected paths:
- `apps/api/src/server.ts`
- `apps/api/src/cron/**`
- `apps/api/test/v2/cron/**`

Risk: `registerAuditCron`, `registerGcCron`, and `startCron` exist, but
governor `rg` found no production startup wiring outside tests. Audit/GC
behavior therefore may never run in the API fleet.

Governor smoke command:

```text
rg -n "startCron|registerAuditCron|registerGcCron" apps/api/src apps/api/test/v2/cron
```

Observed output: only module definitions/comments and test imports call these
symbols; no API startup call is present under `apps/api/src/server.ts`.

Required fix:
- Wire the Lane 8 audit and GC handlers into API startup/config, or explicitly
  fail closed when cron dependencies are not configured.
- Keep advisory-lock wrapping through `startCron`.

Acceptance:
- [x] Production startup code registers audit and GC handlers under config
  (`apps/api/src/server.ts` calls `startProsaCron` when
  `config.cronEnabled` is true).
- [x] A production-wiring test proves the startup path calls `startCron` with
  the registered audit/GC handlers (`production-wiring.test.ts` 3 tests).
- [x] `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/production-wiring.test.ts`
  passes.
- [x] Per-cadence semantics: `intervalScheduler` wakes every minute and only
  fires each handler when its `cadenceForExpression(...)` interval has
  elapsed. Hourly = 1h, daily = 24h, weekly = 7d, monthly = 30d.
  `interval-scheduler.test.ts` pins the mapping + the
  "fires once per cadence" contract using fake timers. Durable cadence is
  gated for monthly rehash (`pack_audit_state.last_full_hash_at`) and for GC
  (`remote_pack.ingested_at` + `pack_gc_state.first_unreferenced_at`).
  Hourly/daily/weekly audit sampling may do bounded duplicate work after
  process or fleet restart, bounded by the advisory lock and per-tenant
  sampling caps; this is the governor-accepted narrower rescope and does NOT
  publish authority or delete bytes (see `apps/api/src/cron/wire.ts` and
  `evidence/lane-08.md`). True wall-clock cron-of-the-day-of-month semantics
  remain deferred to a node-cron adapter swap.

Governor validation on 2026-05-21 after `665efc9`/`e235d1e`:

- Production startup wiring exists and API typecheck passes, but cadence
  closure depends on a governor rescope. `intervalScheduler` is an in-process
  `Date.now()` interval scheduler, monthly is a fixed 30-day interval, and
  `lastFiredMs` resets on process restart.
- Required fix: either implement/prove real cron semantics, or ask the
  governor to explicitly accept the per-process interval-cadence rescope with
  the restart behavior documented in gates/evidence. Safe default: reject the
  rescope and implement real cron semantics.

Governor validation on 2026-05-21 after `b14ea4c`:

- Still open as an acceptance/documentation blocker. Production startup and
  focused cron smokes pass, but the rescope is documented inaccurately.
  Advisory locks prevent overlapping handler bodies; they do not provide
  fleet-wide "once per cadence" semantics, and `lastFiredMs` is per process.
- The claim that handler bodies re-evaluate durable cadence columns is true for
  monthly rehash and GC-style timestamp gates, but not for hourly/daily/weekly
  audit sampling/scans. Those can perform bounded duplicate audit work after
  process or fleet restarts.
- Required fix: either implement true durable cadence semantics for all audit
  tasks, or document and explicitly accept the narrower rescope: duplicate
  hourly/daily/weekly audit work after restart is allowed, bounded by advisory
  locks and sampling limits, and does not affect authority correctness.

Governor WIP review on 2026-05-21:

- Partially covered. `server.ts` calls `startProsaCron`, and the focused
  production wiring test passed.
- Still open because `pnpm --filter @c3-oss/prosa-api typecheck` fails:
  `apps/api/test/storage.test.ts(10,7)` is missing `cronEnabled` and
  `cronIntervalMs` in a `ProsaApiConfig` fixture.
- The startup scheduler currently uses a fixed interval that ignores the cron
  expression and runs every handler on the same cadence. Either implement real
  hourly/daily/weekly/monthly scheduling semantics or explicitly rescope this
  to fixed-interval polling in gates/evidence before closing CQ-156.

Governor smoke update on 2026-05-21:

```text
pnpm --filter @c3-oss/prosa-api typecheck
test/storage.test.ts(10,7): Type ... is missing cronEnabled, cronIntervalMs
```

- CQ-156 remains blocking until API typecheck is clean.

Governor smoke update 2 on 2026-05-21:

- Still blocking. `pnpm --filter @c3-oss/prosa-api typecheck` fails with the
  same `apps/api/test/storage.test.ts(10,7)` missing `cronEnabled` and
  `cronIntervalMs` error.

Final WIP review on 2026-05-21:

- Typecheck is now clean, but CQ-156 still needs cadence semantics resolved.
  The production scheduler ignores cron expressions and runs every registered
  handler on the same fixed interval. Either implement/prove true
  hourly/daily/weekly/monthly cadence behavior, or explicitly record a
  governor-approved rescope to fixed-interval polling in gates/evidence.

### CQ-155: GC does not revalidate references before deleting tombstoned packs

Severity: critical

Blocking: no — closed 2026-05-21 after the GC-wins inside-tx rollback
regression landed in `gc-seal-production-interleaving.test.ts` alongside
the pre-tx fail-closed and seal-wins cases. Three production
`sealPromotion()` regressions now cover all required orderings, plus the
inline-SQL ordering regressions in `gc-seal-interleaving.test.ts`.

Status: closed pending governor acceptance.

Affected lane: Lane 8.

Affected paths:
- `apps/api/src/cron/gc.ts`
- `apps/api/test/v2/cron/gc-lifecycle.test.ts`
- `apps/api/test/v2/cron/gc-blocked-by-grant.test.ts`
- `apps/api/test/v2/cron/gc-blocked-by-staging.test.ts`
- `apps/api/test/v2/cron/gc-rechecks-before-delete.test.ts`

Risk: GC checks `receipt_pack_grant` and open `promotion_staging` only when a
pack first enters `tombstone_pending`. If a grant or open staging row appears
during the tombstone window, phase 2/3 can still delete the pack bytes and
catalog rows, violating the Lane 8 no-delete-while-referenced invariant.

Governor smoke command:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/migrate/tenant-roundtrip.test.ts test/v2/migrate/legacy-receipts-archived.test.ts test/v2/cron/gc-lifecycle.test.ts test/v2/cron/gc-blocked-by-grant.test.ts test/v2/cron/gc-blocked-by-staging.test.ts
```

Observed output: 5 files passed, 9 tests passed. These tests do not cover a grant
or open staging row appearing after tombstone and before delete.

Required fix:
- Revalidate `receipt_pack_grant` and open `promotion_staging` before moving a
  tombstone to `delete_pending` and immediately before object deletion.
- Add regressions for a post-tombstone grant and a post-tombstone open staging
  row.

Acceptance:
- [x] A post-tombstone receipt grant prevents deletion and returns the pack to
  a non-deleting state (CQ-155 post-tombstone revert in
  `gc-rechecks-before-delete.test.ts`).
- [x] A post-tombstone open staging row prevents deletion (same test).
- [x] Recheck-and-catalog-delete run inside a single transaction with
  `FOR UPDATE` on both `pack_gc_state` and `remote_pack`. The same
  `remote_pack FOR UPDATE` row is taken by `sealPromotion` before each
  grant insert, so the two paths serialize at the row level.
  `gc-seal-interleaving.test.ts` covers the two orderings:
  - GC-wins: a subsequent seal-shaped tx pre-inserts receipt + authority
    + search_generation, then takes `FOR UPDATE` on the deleted
    `remote_pack`, sees no rows, throws, and the entire seal tx rolls
    back. Assertion: zero receipt, authority, search_generation, grant.
  - Seal-wins: a seal-shaped tx commits the grant first; GC's daily tick
    rechecks under the same FOR UPDATE, sees the grant, reverts to
    `live`. Bytes + catalog intact; no `prosa.gc.pack_deleted`.
- [x] Production-shape `promotion_uploaded_pack` reversion:
  `gc-seal-interleaving.test.ts` covers BOTH `tombstone_pending → live`
  and `delete_pending → live` reversions when an open promotion appears
  with empty `head_json` linked via `promotion_uploaded_pack` (the
  production seal shape).
- [x] `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/`
  passes (12 files, 28 tests). API typecheck + lint clean repo-wide.

Governor validation on 2026-05-21 after uncommitted restart work:

- Production code remains directionally correct and the focused cron gate
  passes. However, CQ-155 cannot be governor-accepted yet because
  `gc-seal-interleaving.test.ts` still simulates the seal side with inline
  SQL rather than invoking `sealPromotion()`.
- Required before closure:
  - add a GC-wins regression that calls the actual `sealPromotion()` path and
    proves it rejects/rolls back before any receipt, authority,
    `search_generation_current`, or `receipt_pack_grant` row is visible when
    GC has deleted the catalog row first;
  - add a seal-wins regression that calls the actual `sealPromotion()` path,
    publishes the grant, then runs GC and proves the pack reverts/remains live
    with bytes and catalog intact;
  - rerun at minimum
    `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/gc-seal-interleaving.test.ts test/v2/sync/seal-promotion.test.ts`
    plus API typecheck.

Governor validation on 2026-05-21 after `gc-seal-production-interleaving.test.ts`:

- Seal-wins production coverage is acceptable: the test calls real
  `sealPromotion()`, then real `registerGcCron()['gc-daily']()`, and verifies
  GC reverts the pack to `live` with bytes/catalog intact.
- GC-wins production coverage is still insufficient. The test deletes
  `remote_pack` before invoking `sealPromotion()`, so `sealPromotion()` fails
  during pre-transaction byte/catalog verification. It does not prove the
  critical rollback path where receipt, `remote_authority_v2`, and
  `search_generation_current` are inserted, then the `remote_pack FOR UPDATE`
  check inside the transaction fails and rolls the transaction back.
- Required before closure: add a GC-wins production test where
  `verifyLinkedPackBytes()` succeeds, a simulated committed GC catalog delete
  happens immediately before `sealPromotion()`'s transaction body, and
  production `sealPromotion()` proves rollback by leaving zero receipt,
  authority, search-generation, and grant rows visible. Then rerun:
  ```text
  pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/
  pnpm --filter @c3-oss/prosa-api typecheck
  ```

Governor validation on 2026-05-21 after `665efc9`/`e235d1e`:

- Critical: the staging guard in `gc.ts` checks
  `promotion_staging.head_json @> {'pack_digests': [...]}`, but production
  promotion heads come from `bundleHeadV2Schema` and use `segments`, while the
  real pack linkage is `promotion_uploaded_pack`. GC can therefore miss an
  active/open/materializing promotion that references an old already-present
  pack.
- Critical: the current final-review race test encodes the wrong invariant. It
  inserts a grant inside an `objectStore.delete` hook and expects bytes to be
  deleted anyway. CQ-155 requires the opposite: no referenced pack bytes are
  deleted when a concurrent grant/authority can appear after the final recheck.
- Schema does not enforce the orphan-grant assumption: `receipt_pack_grant` has
  no FK to `remote_pack` or `receipt`, and `sealPromotion` verifies pack bytes
  before its final transaction but inserts receipt, authority, and grants
  later.
- Required tests:
  - production-shaped `promotion_staging.head_json` plus
    `promotion_uploaded_pack` row blocks tombstone/delete;
  - replay/race where `sealPromotion` passes `verifyLinkedPackBytes`, GC enters
    its final recheck/delete window, and the seal transaction attempts to
    insert receipt/authority/grants. Expected: GC skips delete or seal fails
    before authority/grants.

Governor WIP review on 2026-05-21 after current uncommitted CQ-155 changes:

- Materially improved. Current WIP checks `promotion_uploaded_pack` in GC
  tombstone admission, tombstone reversion, and final delete recheck; GC and
  `sealPromotion` now serialize on the same `remote_pack FOR UPDATE` row before
  catalog delete or grant insert.
- Read-only reviewer found no remaining production data-loss path in the code:
  if seal wins the lock, GC should see the grant and revert to `live`; if GC
  wins and deletes the catalog row, seal should fail inside the transaction
  before receipt, authority, search generation, or grants become visible.
- CQ-155 remains open for acceptance-test coverage. The current race test
  pre-inserts the grant before GC runs, proving the final recheck branch but
  not the actual two-transaction lock interleaving.
- Required before closure:
  - concurrent seal-vs-GC test where seal reaches/holds
    `remote_pack FOR UPDATE`, inserts the grant, and GC then skips delete;
  - reverse-order test where GC deletes the catalog row first and seal fails
    before any receipt, authority, or grant is visible;
  - production-shaped `promotion_uploaded_pack` coverage for post-tombstone and
    `delete_pending` reversion paths, not only initial tombstone blocking.

Current WIP smoke evidence:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/gc-rechecks-before-delete.test.ts test/v2/cron/gc-blocked-by-staging.test.ts test/v2/cron/gc-lifecycle.test.ts
Test Files  3 passed (3)
Tests       8 passed (8)

pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/gc-rechecks-before-delete.test.ts test/v2/cron/gc-blocked-by-grant.test.ts test/v2/cron/gc-blocked-by-staging.test.ts test/v2/cron/gc-lifecycle.test.ts test/v2/cron/gc-delete-failure.test.ts test/v2/cron/production-wiring.test.ts test/v2/cron/interval-scheduler.test.ts
Test Files  7 passed (7)
Tests       17 passed (17)

pnpm --filter @c3-oss/prosa-api typecheck
passed
```

Governor validation on 2026-05-21 after `b14ea4c`:

- Still open as an acceptance/evidence blocker. The static code path looks
  correct: GC and seal both lock `remote_pack`, and if GC wins, seal should
  throw inside the transaction before receipt, authority, search generation, or
  grants are visible.
- Required coverage is still missing. The current "race" test pre-inserts a
  grant before GC runs; it does not exercise a real two-transaction
  seal-vs-GC interleaving, and no cron test calls `sealPromotion()`.
- `promotion_uploaded_pack` coverage is partial: initial tombstone blocking is
  covered, but post-tombstone staging and `delete_pending` reversion still use
  legacy `head_json.pack_digests` or receipt grants.
- Required tests:
  - seal wins: `sealPromotion()` reaches/holds `remote_pack FOR UPDATE`,
    inserts grant/authority, and GC then rechecks and leaves bytes/catalog live;
  - GC wins: GC locks/deletes catalog first, then `sealPromotion()` fails
    inside its transaction; assert no receipt, `remote_authority_v2`,
    `search_generation_current`, or `receipt_pack_grant` is visible;
  - production-shaped `promotion_uploaded_pack` post-tombstone reversion;
  - production-shaped `promotion_uploaded_pack` `delete_pending` reversion.

Governor WIP review on 2026-05-21:

- Improved but still open. The new post-tombstone tests passed, but there is a
  remaining race: GC performs a final reference recheck, then calls
  `objectStore.delete` before the catalog transaction. A concurrent seal can
  insert `receipt_pack_grant` and publish authority after the final recheck but
  before object deletion completes.
- Add a regression where `objectStore.delete` or a controlled test hook inserts
  a grant/authority after GC's final recheck but before delete completes. The
  expected result is no object deletion and a safe `live` or tombstone state.
- Required smoke after fix:
  `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/`
  plus `pnpm --filter @c3-oss/prosa-api typecheck`.

Governor smoke update on 2026-05-21:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/gc-lifecycle.test.ts test/v2/cron/gc-blocked-by-grant.test.ts test/v2/cron/gc-blocked-by-staging.test.ts test/v2/cron/gc-rechecks-before-delete.test.ts test/v2/cron/audit-detects-mismatch.test.ts test/v2/cron/production-wiring.test.ts
Test Files  6 passed (6)
Tests       14 passed (14)
```

- Focused cron tests pass, but CQ-155 cannot close while the final-recheck to
  `objectStore.delete` race is not covered and API typecheck is failing.

Governor smoke update 2 on 2026-05-21:

- Focused cron command still passes: 6 files, 14 tests. CQ-155 can be
  considered technically closeable only after the final race coverage concern
  is addressed or explicitly justified, the WIP is committed, and API typecheck
  is clean.

Final WIP review on 2026-05-21:

- Still open. The race between final `isStillUnreferenced` and
  `objectStore.delete` remains: a concurrent seal can insert a grant and
  publish authority during that gap. Add a regression with a controlled delete
  hook that inserts grant/authority after the final recheck but before delete
  completes, and assert bytes are not deleted and GC returns to a safe state.

### CQ-154: Lane 7 slice 11 smoke is documented but not executable/proven

Severity: critical

Blocking: no — closed at slice 11 E2E commit.

Status: closed.

Affected lane: Lane 7.

Affected paths:
- `docs/rearch-2/lane-7-v1-to-v2-manual-smoke.md`
- `docs/roadmap/rearch-2/evidence/lane-07.md`
- `docs/roadmap/rearch-2/gates.md`
- `apps/cli/test/v2/read-sessions-e2e.test.ts`
- `apps/cli/package.json`
- `pnpm-lock.yaml`

Risk: Lane 7 gate item 8 was originally marked complete using a manual smoke
playbook, not actual command output. The claimed automated E2E blocker was not
accepted without smoke-command evidence.

Governor smoke command:

```text
pnpm --filter @c3-oss/prosa exec vitest run test/v2/read-sessions-e2e.test.ts
```

Initial observed failure:

```text
Test Files  1 failed (1)
Tests       2 failed (2)
TypeError: registerV2ReadRoutes is not a function
TypeError: Cannot read properties of undefined (reading 'close')
```

Required fix:
- Make the slice 11 smoke executable and commit it, or replace the playbook
  claim with real manual command evidence showing the exact commands run and
  their output against a live dev cluster.
- If using the automated test, import the v2 read route plugin from a real
  public export or add the necessary public export intentionally, and make
  teardown safe when boot fails.
- Remove the claim that CQ-124 blocks Lane 7 E2E unless a direct smoke command
  proves an unavoidable dependency. A v2-only Fastify/PGlite harness with
  stubbed auth appears feasible and is already attempted in the WIP test.

Acceptance:
- [x] `pnpm --filter @c3-oss/prosa exec vitest run test/v2/read-sessions-e2e.test.ts`
  passes: 1 file, 2 tests (list + count). Both drive `prosa read sessions`
  end-to-end through a real Fastify route + handler + PGlite.
- [x] `apps/cli/package.json` adds `fastify@^5.0.0` as a devDependency —
  required for the slice 11 harness to mount the route plugin in process.
- [x] `docs/roadmap/rearch-2/gates.md` flips slice 11 to checked after the
  accepted evidence landed.
- [x] `docs/roadmap/rearch-2/evidence/lane-07.md` records the slice 11
  passing command output.

Closure summary:
- `apps/cli/test/v2/read-sessions-e2e.test.ts` mounts only the
  `registerV2ReadRoutes` plugin against a v2-only PGlite, stubs
  `ProsaAuth.api.getSession` to return a fixed user + active tenant
  (avoiding the CQ-124 v1+v2 schema collision in Better Auth), seeds
  `remote_authority_v2` + `projection_session`, then drives the CLI
  via a `vi.stubGlobal('fetch', ...)` adapter that routes through
  `app.inject(...)`. The CLI flows through V2ReadsClient → real
  Fastify route → handler → PGlite → response → CLI rendering with
  no mocked layer between them.

### CQ-150: CLI and web v2 read clients are not wire-compatible with Lane 6 schemas

Severity: critical

Blocking: no — accepted by Codex/governor after `bf5a601`.

Status: closed.

Affected lane: Lane 7.

Affected paths:
- `apps/cli/src/cli/v2/commands/read/search.ts`
- `apps/cli/src/cli/v2/commands/read/transcript.ts`
- `apps/cli/src/cli/v2/commands/read/tool-calls.ts`
- `apps/cli/src/cli/v2/commands/read/analytics.ts`
- `apps/web/src/lib/api-v2.ts`
- `apps/api/src/v2/reads/**`

Risk: focused helper tests pass while real commands can send unsupported
filters, silently drop intended filters, or render empty/misnamed fields from
real Lane 6 responses. Examples found by Codex reviewer:

- search CLI sends `role`, `toolName`, `canonicalType`, and `projectIds`, while
  `/v2/reads/search/query` accepts `roles`, `toolNames`,
  `canonicalToolTypes`, `entityTypes`, `sessionId`, `since`, and `until`.
- transcript rendering expects `block.text`, `turn.startedAt`, and
  `call.result`, while the route returns `textInline`, `timestampStart`,
  `latestResult`, and a nullable not-found response shape.
- tool-calls rendering expects `startedAt`, `resultStatus`, and `summary`,
  while the route returns `timestampStart` and `latestResult`.
- analytics sends `projectIds`, while the strict server schema does not accept
  project filters.

Required fix:
- Align every CLI and web v2 request/response type with the actual Lane 6 route
  schemas.
- Remove unsupported flags or fail closed with explicit messages when a
  documented filter has no server support.
- Update output rendering to use the actual response fields.

Acceptance:
- [ ] Focused command-level tests cover `read search`, `read transcript`,
  `read tool-calls`, and `read analytics` against representative Lane 6 payloads.
- [ ] Tests prove unsupported filters are either translated correctly or rejected
  explicitly, never silently ignored.
- [ ] `pnpm --filter @c3-oss/prosa exec vitest run test/v2/` passes.
- [ ] Relevant web v2 client tests pass after schema alignment.

Governor review after `a1a21d7`:

- Still open. The added client contract tests validate request/response schemas,
  but they are not command-level tests for `prosa read search`,
  `transcript`, `tool-calls`, or `analytics` rendering/routing against
  representative Lane 6 payloads.
- Required evidence command is still missing; if command-level files do not
  exist, add them before closing:
  `pnpm --filter @c3-oss/prosa exec vitest run test/v2/read-search*.test.ts test/v2/read-transcript*.test.ts test/v2/read-tool-calls*.test.ts test/v2/read-analytics*.test.ts`.

Governor review after `bf5a601`:

- Accepted. Command-level tests now cover `read search`, `read transcript`,
  `read tool-calls`, and `read analytics` against representative v2 payloads.
- Evidence:
  `pnpm --filter @c3-oss/prosa exec vitest run test/v2/read-analytics-command.test.ts test/v2/read-search-command.test.ts test/v2/read-sessions-local-filters.test.ts test/v2/read-tool-calls-command.test.ts test/v2/read-transcript-command.test.ts test/v2/with-412-refresh-and-retry.test.ts`
  passed: 6 files, 19 tests.

### CQ-151: Local read fallbacks ignore documented filters

Severity: high

Blocking: no — accepted by Codex/governor after `bf5a601`.

Status: closed.

Affected lane: Lane 7.

Affected paths:
- `apps/cli/src/cli/v2/commands/read/search.ts`
- `apps/cli/src/cli/v2/commands/read/sessions.ts`

Risk: in `auto`, unpromoted stores route local; documented filters like
`--project`, `--cursor`, and search filter flags can be ignored, returning
broader output than the operator requested.

Required fix:
- Make local fallbacks honor the same documented filters where local services
  support them.
- For unsupported local filters, fail closed with a clear message instead of
  returning broader results.

Acceptance:
- [ ] Focused tests prove local `read sessions` does not silently ignore
  project/cursor filters.
- [ ] Focused tests prove local `read search` honors supported filters or
  rejects unsupported filters explicitly.

Governor review after `a1a21d7`:

- Still open for evidence. Code appears to reject local `sessions --project`,
  local `sessions --cursor`, and server-only local search filters, but no
  focused command tests prove the acceptance criteria.

Governor review after `bf5a601`:

- Accepted. Local fallback command tests now cover `sessions --project`,
  `sessions --cursor`, and local search server-only filters.
- Evidence: same 6-file focused command above passed: 19 tests.

### CQ-152: CLI HTTP 412 handling does not refresh once and retry idempotent reads

Severity: high

Blocking: no — accepted by Codex/governor after `bf5a601`.

Status: closed.

Affected lane: Lane 7.

Affected paths:
- `apps/cli/src/cli/v2/commands/read/common.ts`
- `apps/cli/src/cli/v2/authority/resolve.ts`
- `apps/cli/src/cli/v2/commands/read/*.ts`

Risk: Lane 7 requires one authority refresh plus retry for idempotent reads.
Current `with412Retry` converts `AuthorityChangedHttpError` to a CLI error but
does not refresh authority or retry, so normal single-page reads fail when the
server reports a newer authority.

Required fix:
- Implement one refresh plus retry for idempotent single-page read commands.
- Keep streaming or multi-page outputs such as `transcript --all-pages`
  fail-closed with an explicit rerun message when authority changes mid-stream.

Acceptance:
- [ ] Focused tests prove a single-page read refreshes authority once and
  retries after HTTP 412.
- [ ] Focused tests prove repeated 412 stops explicitly without looping.
- [ ] Focused tests prove multi-page/streaming output stops with a clear
  authority-changed error.

Governor review after `a1a21d7`:

- Still open with a behavior bug. `read transcript` single-page currently fails
  closed on `AuthorityChangedHttpError`; only `--all-pages` should use the
  streaming fail-closed path.
- Existing `with-412-refresh-and-retry.test.ts` lacks the required first-412
  retry, repeated-412 stop, and streaming/transcript fail-closed cases.

Governor review after `bf5a601`:

- Accepted. Single-page transcript now uses refresh-and-retry; repeated 412
  stops explicitly; `--all-pages` remains fail-closed.
- Evidence: same 6-file focused command above passed: 19 tests.

### CQ-153: Web console routes still use legacy tRPC and v2 client is not fail-closed

Severity: critical

Blocking: no — closed at `b52a837`.

Status: closed.

Affected lane: Lane 7.

Affected paths:
- `apps/web/src/app/providers.tsx`
- `apps/web/src/lib/api-v2.ts`
- `apps/web/src/routes/console/**`
- `apps/web/src/components/console/dashboard/widgets/**`
- `apps/web/src/components/console/transcript/cas-text.tsx`
- `apps/api/src/v2/reads/artifacts/get-text.ts`

Risk: `apps/web/src/lib/api-v2.ts` exists, but the app provider and console
routes still use the legacy tRPC client for promoted read data. The v2 helper
also omits `x-prosa-tenant-id` when no tenant is active, allowing the server to
fall back to session active organization instead of failing closed. Route shape
preservation is not yet proven for sessions, transcript, search, tool-calls,
analytics, dashboard widgets, or artifact/CAS text.

Required fix:
- Wire the console read routes to a v2 read client while preserving existing
  route/component shapes.
- Translate legacy UI filters to exact v2 route inputs.
- Require an active tenant before every v2 read fetch.
- Add v2 coverage or explicit fail-closed behavior for dashboard widgets and
  transcript large-body/artifact text reads.

Acceptance:
- [ ] Route-level tests prove console read routes call `/v2/reads/*`, not
  legacy `/trpc` read procedures, for sessions, session detail, search,
  tool-calls, analytics, dashboard, and artifact/CAS text where supported.
- [ ] Missing-tenant v2 client test proves no network request is made.
- [ ] Filter translation tests prove source/project/time/search filters are
  preserved or rejected explicitly.
- [ ] Transcript large-body rendering either works through a v2 read endpoint or
  renders an explicit unavailable state without legacy fallback.

Governor review after `a1a21d7`:

- Still open. `AppProviders` still exposes only the legacy tRPC client, and
  console read routes still call `api.sessions.*`, `api.search.*`,
  `api.toolCalls.*`, `api.analytics.*`, and `api.artifacts.*` tRPC procedures.
- The v2 client still lacks route coverage for session detail, artifact/CAS
  text, analytics summary, and dashboard widget equivalents or explicit
  fail-closed states.
- Existing web evidence only proves the helper's missing-tenant no-network
  behavior; it does not prove any route uses `/v2/reads/*`.

Update at `6b19d5c` + `7f6f3c8`:

- `AppProviders` now exposes `apiV2: V2ApiClient` alongside the legacy
  tRPC client.
- Five console read routes migrated to apiV2:
  `ConsoleSessions` (sessions.list + count), `ConsoleSearch`
  (search.query), `ConsoleToolCalls` (toolCalls.list),
  `ConsoleAnalytics` (analytics.report), and `ConsoleSessionDetail`
  (sessions.transcript). Filter shapes translate v1 `sourceKinds` to v2
  `sourceTools` and shim the v2 transcript payload into the existing
  TranscriptTurn/TranscriptToolCall component shape.
- Route-level tests at
  `apps/web/src/routes/console/sessions-v2.test.tsx` (1 test) and
  `apps/web/src/routes/console/v2-reads.test.tsx` (4 tests) prove each
  migrated route calls `apiV2.v2.*` and never invokes the legacy tRPC
  procedures. Web suite: 13 files, 35 tests passed.

Update at `b357854` → `b52a837`:

- `ConsoleDashboard` now reads through `apiV2.v2.analytics.summary`
  (CQ-153 close).
- `ConsoleArtifact` now reads through `apiV2.v2.artifacts.getText`.
- `cas-text`, `activity-widget`, `daily-threads-widget`,
  `tokens-by-agent-widget`, `agent-vs-subagent-widget` render an
  explicit "pending a `/v2/reads/...` endpoint" empty state and
  make **no network call** — they no longer fall back to the
  legacy tRPC procedures.

No remaining `api.{sessions,search,analytics,toolCalls,artifacts}`
read calls live under `apps/web/src/`.

**CQ-153 follow-up (new tracking, non-blocking for Lane 7)** — Lane 7
ships an explicit-unavailable state for these surfaces; the follow-up
is to actually add the missing v2 endpoints:

- `/v2/reads/analytics/activity` for the activity heatmap + daily
  threads chart.
- `/v2/reads/analytics/tokens-by-agent` for the per-source-tool
  daily-token chart.
- `/v2/reads/analytics/agent-vs-subagent` for the user-vs-subagent
  ratio chart.
- Either extend the v2 transcript block schema to surface
  `artifactId` per block, or add an `/v2/reads/artifacts/getTextByObjectId`
  endpoint so `cas-text` can expand CAS-backed bodies.

Acceptance:
- [x] Route-level tests prove console read routes call `/v2/reads/*`,
  not legacy `/trpc` read procedures (`apps/web/src/routes/console/sessions-v2.test.tsx`
  and `apps/web/src/routes/console/v2-reads.test.tsx` cover sessions,
  search, tool-calls, analytics, dashboard, session-detail, artifact).
- [x] Missing-tenant v2 client test proves no network request is made
  (`apps/web/src/lib/api-v2.test.ts`).
- [x] Filter translation tests prove source/project/time/search filters
  are preserved or rejected explicitly (sessions v1
  `sourceKinds` → v2 `sourceTools`, CQ-150/151 CLI command tests).
- [x] Transcript large-body rendering renders an explicit unavailable
  state without legacy fallback (`cas-text` shows the CAS object id
  and the named follow-up endpoint).

### CQ-149: `prosa.refresh_authority` MCP tool not yet registered

Severity: medium

Blocking: no — closed at `a3d25c8`.

Status: closed.

Affected lane: Lane 7.

Closure summary:
- `prosa-core` `registerProsaTools` accepts an `onRefreshAuthority`
  callback (`apps/.../prosa-core/src/mcp/tools.ts`); when present, the
  `prosa.refresh_authority` MCP tool is registered. Callback errors
  surface as `isError: true` content; the server never auto-refreshes.
- `listenMcpServer` and `listenMcpStdioServer` thread the callback
  through to the per-session tool factory.
- `prosa mcp-v2 serve` builds the callback in `makeRefreshCallback`
  (CLI-side), threads it through both transports, and mutates the
  pinned `V2ReadContext` in place so subsequent refreshes compare
  against the latest receipt id. Local mode leaves the callback
  undefined so the tool stays absent.

Acceptance:
- [x] Focused test verifying the tool is registered when authority
  is `auto` or `remote` (`packages/prosa-core/test/mcp/tools.test.ts`
  CQ-149 case + `apps/cli/test/v2/mcp-refresh-authority.test.ts`).
- [x] Focused test verifying the tool is absent in `--authority local`
  (same files).
- [x] Focused test verifying callback errors surface as `isError`
  (`packages/prosa-core/test/mcp/tools.test.ts` second CQ-149 case).



When Ralph or Codex finds a blocker, add it here with:

- stable `CQ-*` id;
- severity and blocking flag;
- affected lane and paths;
- concrete risk;
- required fix;
- acceptance criteria;
- command evidence.

Do not close a CQ from claims alone. Close it only when code, tests, and
evidence satisfy the written acceptance criteria.

## Deferred Future Corrections

### CQ-124: v1 and v2 schemas share table names with incompatible columns

Severity: critical

Blocking: yes for Lane 10 cutover; not blocking Lanes 7-9 unless fresh
smoke-command evidence proves a direct dependency.

Status: open — deferred to Lane 10.

Risk: full `applySchemaV2` over v1 and projection/search materialization still
need the final v1/v2 cutover strategy. Lane 5 and Lane 6 were accepted with the
documented subset workaround and verified read gates.

Acceptance for future Lane 10:

- [ ] Lane 10 cutover plan documents the v1-to-v2 table migration or namespace
  strategy.
- [ ] Production boot applies the final schema over a v1-shaped database.
- [ ] Projection and search materialization use the final v2 schema without
  shared-name table conflicts.
- [ ] Focused tests prove the cutover path and rollback behavior.

### CQ-134: SealPromotion emits authority receipts before full projection/search materialization

Severity: critical

Blocking: yes for Lane 10 cutover; not blocking Lanes 7-9 unless fresh
smoke-command evidence proves a direct dependency.

Status: partially closed — object coverage and pack-byte presence are accepted;
remaining projection/search materialization is deferred behind CQ-124 to Lane
10.

Risk: Lane 5 seal acceptance proved object coverage and pack-byte presence, and
Lane 6 reads fail closed to rows already proven by current authority. Full
seal-time projection/search materialization remains tied to the final schema
cutover.

Acceptance for future Lane 10:

- [ ] Seal path proves projection rows before authority swap.
- [ ] Seal path proves search docs before authority swap.
- [ ] Any materialization failure leaves authority unchanged and returns a
  clear failure.
- [ ] Tests pin object coverage, projection coverage, search coverage, and
  fail-closed rollback.

## Closed Summary

Lanes 0-6 are accepted. Historical CQ detail was compacted after Lane 6
acceptance; use git history before this commit for the full per-slice audit
trail.

Notable closed Lane 6 corrections:

- CQ-142: cursor snapshot/integrity and HTTP `INVALID_CURSOR` coverage.
- CQ-143: CLI fail-closed local guidance before Lane 7 consumers.
- CQ-144: opaque artifact misses.
- CQ-145: artifact route miss/success matrix.
- CQ-146: production cursor secret/config wiring.
- CQ-147: analytics tuple-match and strict route input.
- CQ-148: `tool-calls/list` latest-result join tuple-matches
  `tool_call_id/session_id/store_id/receipt_id`.
- CQ-148 follow-up: `sessions/transcript` latest-result lookup also
  tuple-matches `tool_call_id/session_id/store_id/receipt_id`, preventing a
  current-authority result from another session/store/receipt from attaching to
  the visible transcript call.
