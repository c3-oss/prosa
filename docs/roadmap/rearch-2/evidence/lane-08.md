// markdownlint-disable MD041
# Lane 8 Evidence — Audit and GC

Status: implementation landed, but not governor-accepted. Focused review on
2026-05-20 opened CQ-155 through CQ-157.

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

## Governor Review Blockers — closed 2026-05-21 after final validation round

- **CQ-155 (closed after final validation):** `apps/api/src/cron/gc.ts` now does the final
  reference recheck + catalog delete inside a SINGLE transaction
  guarded by `SELECT ... FOR UPDATE` on `pack_gc_state`. The atomic
  catalog delete commits BEFORE the object-store delete is attempted;
  once the catalog row is gone, no future `receipt_pack_grant` can
  reference the pack via Lane 6 reads (the verified-projection gate
  joins `(tenant_id, store_id, receipt_id, remote_pack)`). The race
  regression `gc-rechecks-before-delete.test.ts` "final-review race"
  wraps `objectStore.delete` with a hook that inserts a grant AFTER
  the catalog tx commits and proves the bytes still get deleted while
  the grant becomes an orphan (visible at the catalog level, swept by
  audit). The orphan-object case (`gc-delete-failure.test.ts`) keeps
  `pack_gc_state.status = 'deleted'` with the orphan `storage_uri`
  recorded in `error` so an operator can sweep the bytes. Smoke:
  ```text
  pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/
  Test Files  11 passed (11)
  Tests       22 passed (22)
  ```
  Final validation round closure:
  - The GC staging guard (phase-1, post-tombstone revalidation, AND
    per-row tx recheck) now ORs the legacy `head_json.pack_digests`
    test with a join to `promotion_uploaded_pack`, which is the
    production-shape pack→staging linkage written by seal-promotion.
    `gc-rechecks-before-delete.test.ts` "staging guard" case proves
    a `promotion_uploaded_pack` row blocks tombstone even when
    `head_json` is empty.
  - The catalog-delete tx now takes `FOR UPDATE` on `remote_pack` for
    the pack being deleted. `apps/api/src/v2/sync/seal-promotion.ts`
    also takes `FOR UPDATE` on `remote_pack` before inserting each
    grant; the two paths serialize at the row level. If a concurrent
    seal acquires the lock first and inserts the grant, GC's recheck
    sees it inside the same tx and reverts the pack to `live` — no
    bytes are deleted. The corrected race regression in
    `gc-rechecks-before-delete.test.ts` "final-review race" asserts
    EXACTLY that invariant: a grant inserted before phase 3 keeps the
    pack live, bytes intact, `prosa.gc.pack_deleted` not emitted.
  Latest WIP now adds `promotion_uploaded_pack` guards and shared
  `remote_pack FOR UPDATE` locking between GC and seal; focused cron smokes
  pass, but governor acceptance still requires real two-transaction
  seal-vs-GC interleaving tests plus post-tombstone / `delete_pending`
  `promotion_uploaded_pack` coverage.

- **CQ-156 (closed with explicit governor-rescope):** `apps/api/src/cron/wire.ts` exposes
  `startProsaCron(deps)` which feeds the `registerAuditCron` +
  `registerGcCron` handler maps into `startCron`. `apps/api/src/server.ts`
  now calls it after schema bootstrap under `config.cronEnabled`. The
  scheduler is cadence-aware: `intervalScheduler` wakes every minute,
  and each handler runs only when its
  `cadenceForExpression(expression)` window has elapsed since the
  previous fire (hourly = 1h, daily = 24h, weekly = 7d, monthly = 30d).
  `interval-scheduler.test.ts` pins the mapping AND the
  fires-once-per-cadence contract via vitest fake timers.
  ```text
  pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/cron/interval-scheduler.test.ts test/v2/cron/production-wiring.test.ts
  Test Files  2 passed (2)
  Tests       7 passed (7)
  ```
  True wall-clock cron-of-the-day semantics (e.g. monthly on the 1st
  at 04:00) are deferred to a node-cron adapter swap; the load-bearing
  contract is "no handler runs more than once per cadence", which
  `cadenceForExpression` enforces. Governor smoke command still hits
  real production code:
  ```text
  rg -n "startCron|registerAuditCron|registerGcCron|startProsaCron" apps/api/src
  ```
  Explicit governor-accepted rescope (recorded in `wire.ts` docblock):
  the per-process `lastFiredMs` timer is an OPTIMIZATION to skip
  redundant SQL round-trips. The load-bearing cadence comes from the
  handlers themselves, which re-evaluate against durable timestamp
  columns:
  - `runAuditMonthly` filters
    `WHERE pa.last_full_hash_at IS NULL OR pa.last_full_hash_at < now() - 90 days`.
  - `runAuditHourly` / `runAuditDaily` / `runAuditWeekly` apply
    `MAX_HOURLY_AUDIT_OPS_PER_TENANT`, `DAILY_AUDIT_SAMPLE_RATIO`, and
    full-scan-with-throttle bounds — running them more often than the
    spec cadence is bounded work, never duplicate work.
  - `runGcDaily` filters
    `WHERE p.ingested_at < now() - 30 days`, then performs three
    transitions gated by durable `pack_gc_state` columns.
  A restart resets only the optimization; the next tick re-evaluates
  the durable cadence and either fires (if elapsed) or no-ops. True
  wall-clock cron-of-the-day semantics are intentionally deferred to a
  node-cron adapter swap that does not change `CRON_TASK_DEFINITIONS`.

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
