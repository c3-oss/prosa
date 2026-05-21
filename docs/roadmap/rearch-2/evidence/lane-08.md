// markdownlint-disable MD041
# Lane 8 Evidence — Audit and GC

Status: accepted by Codex/governor on 2026-05-21. Focused review on
2026-05-20 opened CQ-155 through CQ-157; all are now closed for Lane 8.

Required source plan: `docs/rearch-2/09-lane-8-audit-and-gc.md`.

## Slices

### Slice 1 — receipt_audit_state + audit/GC column additions

- `packages/prosa-db-v2/src/schema/packs.ts` adds the
  `receipt_audit_state` table and extends `pack_audit_state` with
  `last_header_check_at`, `last_full_hash_at`, `error`. Extends
  `pack_gc_state` with `status`, `first_unreferenced_at`, `error`.
- `packages/prosa-db-v2/src/apply.ts` lists `receipt_audit_state` in
  `V2_PROMOTION_SUBSET_TABLES` so the conflict-free schema applier
  creates it at boot.
- Commit: `feat(api): lane 8 slice 1 — receipt_audit_state + audit/GC columns`.

### Slice 2 — audit/GC handlers + read drift surface

- `apps/api/src/cron/audit/drift.ts` — `markPackMissing` /
  `markPackHashMismatch` quarantine the pack and upsert
  `receipt_audit_state` for every receipt with a grant on it. Single
  transaction. Emits `prosa.audit.pack_missing` /
  `prosa.audit.pack_mismatch`.
- `apps/api/src/cron/audit.ts` — four cadence handlers
  (hourly 0.1% sample, daily 1% with 4 KiB header probe, weekly full
  scan, monthly full byte rehash). `registerAuditCron(deps)` returns
  the handler map for `startCron({ handlers })`.
- `apps/api/src/cron/gc.ts` — three-phase lifecycle with the spec's
  guards: no `receipt_pack_grant`, no open `promotion_staging` row
  whose `head_json @> jsonb_build_object('pack_digests', jsonb_build_array(pack))`,
  age > 30 days, 24 h tombstone grace. Failed S3 delete reverts to
  `live` and stamps `error`. Emits `prosa.gc.pack_deleted` /
  `prosa.gc.delete_failed`.
- `apps/api/src/v2/reads/authority.ts` extended with the
  `receipt_audit_state` join and a typed `repair` hint when the
  receipt is `degraded` or `invalidated`. The `auditStatus` field
  retains the Lane 6 pack-level mapping for back-compat.
- `apps/api/src/v2/reads/artifacts/get-text.ts` returns a typed
  `{ found: false, reason: 'data_unavailable' }` shape when the
  underlying pack is quarantined; `apps/api/src/v2/reads/index.ts`
  maps it to `503 DATA_UNAVAILABLE` with code +
  artifactId payload.
- Commit: `feat(api): lane 8 slice 2 — audit/GC handlers + read drift surface`.

### Slice 3 — focused test pins

10 new test files under `apps/api/test/v2/cron/` and
`apps/api/test/v2/reads/`. Commit: `test(api): lane 8 slice 3 — audit
+ GC + drift surface pins`.

## Focused gate

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/ test/v2/reads/
Test Files  27 passed (27)
Tests       143 passed (143)
```

Full API suite (regression — no Lane 6 tests broken):

```text
pnpm --filter @c3-oss/prosa-api test
Test Files  82 passed | 2 skipped (84)
Tests       446 passed | 4 skipped (450)
```

Baseline gates:

```text
pnpm typecheck   # 13/13 packages clean
pnpm lint        # 13/13 packages clean
pnpm build       # 13/13 packages clean
```

## Metrics

- `prosa.audit.pack_missing` — emitted by `markPackMissing` per
  finding, tagged with `tenantId`.
- `prosa.audit.pack_mismatch` — emitted by `markPackHashMismatch` per
  finding, tagged with `tenantId` and the mismatch `reason`
  (`byte_length_mismatch`, `header_digest_mismatch`,
  `byte_hash_mismatch`).
- `prosa.gc.pack_deleted` — emitted on each successful S3 + catalog
  delete, tagged with `tenantId`.
- `prosa.gc.delete_failed` — emitted when the S3 delete throws,
  tagged with `tenantId`.

## E2E scenarios

- **Drift detection** — `audit-detects-missing.test.ts` /
  `audit-detects-mismatch.test.ts` seed a pack, delete or shrink the
  bytes, run the hourly handler, and assert the audit row flips to
  `quarantined`, the receipt becomes `degraded`, and the next
  authority refresh surfaces a `repair` field
  (`authority-repair-surface.test.ts`). `artifacts-quarantined.test.ts`
  asserts that the affected artifact response is the typed
  `data_unavailable` shape.
- **GC lifecycle** — `gc-lifecycle.test.ts` seeds a 40-day-old
  unreferenced pack, runs the first daily tick to land on
  `tombstone_pending`, backdates `first_unreferenced_at` past the 24 h
  grace, then runs a second tick to delete the bytes and catalog rows
  and stamp `deleted`. The blocker tests (`gc-blocked-by-grant.test.ts`,
  `gc-blocked-by-staging.test.ts`, `gc-delete-failure.test.ts`) pin
  the three-way guard and the revert-on-failure contract.

## Governor Review Blockers — validation rejected 2026-05-21

- **CQ-155 (closed and accepted):** `apps/api/src/cron/gc.ts` now does the final
  reference recheck + catalog delete inside a SINGLE transaction
  guarded by `SELECT ... FOR UPDATE` on `pack_gc_state` plus a row
  lock on `remote_pack`. `apps/api/src/v2/sync/seal-promotion.ts`
  also takes `FOR UPDATE` on `remote_pack` BEFORE inserting each
  grant; the two paths serialize at the row level. The atomic
  catalog delete commits BEFORE the object-store delete is
  attempted; once the catalog row is gone, any concurrent seal-tx
  that tries to grant on the same pack hits an empty `FOR UPDATE`
  result and throws inside its tx, so no receipt, authority, search
  generation, or grant is ever published against a deleted pack.

  `gc-seal-production-interleaving.test.ts` adds three production-path
  regressions through the real `sealPromotion()` entry point with a real
  signer, real PGlite transaction runner, real `MemoryObjectStore`, real
  `promotion_staging` + `promotion_uploaded_pack` + `remote_pack` setup,
  and real inventory blobs.

  - **GC-wins pre-tx fail-closed (production seal)**: the catalog
    tx (modelled with the same `remote_pack FOR UPDATE` lock GC's
    production tx takes) commits and the object bytes are swept
    BEFORE `sealPromotion()` runs. `verifyLinkedPackBytes` finds
    `remote_pack` gone and throws
    `SealPromotionPackBytesMissingError` (`code: PACK_BYTES_MISSING`).
    Assertions: `promotion_staging.status` returns to `'open'` via
    the CQ-135 staging-restore path; zero `receipt`, zero
    `remote_authority_v2`, zero `search_generation_current`, zero
    `receipt_pack_grant` rows are visible.
  - **GC-wins inside-tx rollback (production seal)**: models the
    interleaving where `verifyLinkedPackBytes` SUCCEEDS (the
    catalog row + bytes were still present), then GC's
    catalog-delete tx commits between verify and the seal's
    `SELECT ... FOR UPDATE` recheck inside the load-bearing tx. A
    wrapping `transaction` runner injects the catalog DELETE at
    the start of the seal's tx so the inner FOR UPDATE finds no
    rows; the seal throws `remote_pack(<digest>) was deleted
    before grant insert`. Assertions: the entire seal tx rolls
    back — zero `receipt`, zero `remote_authority_v2`, zero
    `search_generation_current`, zero `receipt_pack_grant` rows
    are visible; `promotion_staging.status` returns to `'open'`
    via the CQ-135 staging-restore path. This pins the
    governor-requested invariant: when the inside-tx FOR UPDATE
    catches GC's commit, the seal MUST NOT publish any
    authority-side rows even though receipts/authorities were
    INSERTed earlier in the same tx.
  - **Seal-wins (production seal)**: `sealPromotion()` is invoked
    against a fully seeded promotion and commits the receipt +
    authority + grant. Then GC's daily tick runs and reverts the
    `pack_gc_state` row back to `'live'` via the FOR UPDATE recheck.
    Bytes + catalog intact; `prosa.gc.pack_deleted` is not emitted.

  Two-transaction interleaving coverage
  (`gc-seal-interleaving.test.ts`, 4 tests):

  - **GC-wins**: GC's catalog-delete tx commits first. A subsequent
    seal-shaped tx inserts a receipt + remote_authority_v2 +
    search_generation_current row, takes `FOR UPDATE` on
    `remote_pack`, sees no rows, throws, and rolls the entire tx
    back. Assertion: zero receipts, zero authority rows, zero
    search-generation rows, zero grants are visible afterwards.
  - **Seal-wins**: a seal-shaped tx takes `FOR UPDATE` on
    `remote_pack`, inserts the grant, commits. GC's daily tick then
    runs phase 3 and reverts to `live` because the inside-tx
    recheck sees the grant. Bytes + catalog intact;
    `prosa.gc.pack_deleted` not emitted.
  - **Production-shape `promotion_uploaded_pack` reversion**: an
    open `promotion_staging` row with EMPTY `head_json` linked via
    `promotion_uploaded_pack` reverts both a `tombstone_pending` and
    a `delete_pending` pack to `live`. This is the production
    seal-promotion shape (the legacy `head_json.pack_digests` array
    is no longer written by seal).

  Existing post-tombstone coverage
  (`gc-rechecks-before-delete.test.ts`, 5 tests) continues to pin
  the cases where a grant or staging row appears after tombstone but
  before delete. Smoke:
  ```text
  pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/
  Test Files  13 passed (13)
  Tests       31 passed (31)
  ```
  The orphan-object case (`gc-delete-failure.test.ts`) keeps
  `pack_gc_state.status = 'deleted'` with the orphan `storage_uri`
  recorded in `error` so an operator can sweep the bytes; failure of
  the object-store delete after a successful catalog-tx commit does
  NOT resurrect the receipt — at that point there is no catalog row
  for a grant to reference, so no authority can publish on the
  orphan.

- **CQ-156 (closed under narrower governor-accepted rescope):**
  `apps/api/src/cron/wire.ts` exposes `startProsaCron(deps)` which
  feeds the `registerAuditCron` + `registerGcCron` handler maps into
  `startCron`. `apps/api/src/server.ts` calls it after schema
  bootstrap under `config.cronEnabled`. The scheduler is
  cadence-aware: `intervalScheduler` wakes every minute and each
  handler runs only when its `cadenceForExpression(expression)`
  window has elapsed since the previous fire (hourly = 1h, daily =
  24h, weekly = 7d, monthly = 30d). `interval-scheduler.test.ts`
  pins the mapping AND the fires-once-per-cadence contract via
  vitest fake timers.
  ```text
  pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/interval-scheduler.test.ts test/v2/cron/production-wiring.test.ts
  Test Files  2 passed (2)
  Tests       7 passed (7)
  ```
  Governor smoke command still hits real production code:
  ```text
  rg -n "startCron|registerAuditCron|registerGcCron|startProsaCron" apps/api/src
  ```

  **Narrower rescope (governor-accepted):** the rescope docs in
  `apps/api/src/cron/wire.ts` now state explicitly what is and is
  NOT durably gated:

  - Durably gated (no duplicate work across restart):
    - Monthly full-byte rehash skips packs with a recent
      `pack_audit_state.last_full_hash_at`.
    - GC tombstone admission requires
      `remote_pack.ingested_at < now() - 30 days`.
    - GC `tombstone_pending → delete_pending` requires
      `first_unreferenced_at < now() - GC_TOMBSTONE_GRACE_HOURS`.
    - GC `delete_pending → deleted` runs in a single tx with
      `FOR UPDATE` recheck (CQ-155).

  - Bounded duplicate work after process/fleet restart (accepted):
    - Hourly audit sampling (0.1% of packs per tenant, capped by
      `MAX_HOURLY_AUDIT_OPS_PER_TENANT`).
    - Daily 4 KiB header probe (1% per tenant, capped).
    - Weekly full scan over each tenant.

    Duplicate work in these three audit tasks only re-reads
    `remote_pack` rows and may rewrite `pack_audit_state.last_*_check_at`
    timestamps. It does not publish authority, delete bytes, or
    change projection/search. Advisory locks (`audit-advisory-lock.test.ts`)
    prevent overlapping bodies within the same process; the sampling
    caps bound the per-tick read fanout. Authority correctness,
    read-side projection, and pack durability are unaffected.

  Wall-clock cron-of-the-day-of-month semantics (e.g. monthly on the
  1st at 04:00) remain deferred to a node-cron adapter swap; the
  per-handler cron expression is recorded in
  `CRON_TASK_DEFINITIONS` so the swap is transparent.

- **CQ-157 (closed):** `apps/api/src/cron/audit.ts` `hashStream` now uses
  `@noble/hashes/blake3` and compares against `remote_pack.byte_hash`
  normalized to lowercase hex without the `blake3:` prefix.
  `audit-detects-mismatch.test.ts` adds a healthy-BLAKE3 + corrupted-BLAKE3
  pair under the monthly cadence:
  ```text
  pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/audit-detects-mismatch.test.ts
  Test Files  1 passed (1)
  Tests       4 passed (4)
  ```
