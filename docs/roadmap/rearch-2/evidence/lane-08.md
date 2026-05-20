// markdownlint-disable MD041
# Lane 8 Evidence — Audit and GC

Status: shipped on the `feature/rearch` worktree branch
`worktree-agent-a9b01faa332e1bffa`.

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

## Open CQs

None opened.
