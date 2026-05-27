# Lane 8 — Audit and GC

## Goal

Ship the audit and GC cron roles inside the API fleet (one fleet, three roles — lean profile). Audit detects drift in stored packs and flags receipts as `degraded` when needed. GC reclaims storage for packs no longer referenced by any sealed receipt grant. Both serialize via Postgres advisory locks; no separate worker fleet is provisioned.

## Depends on

- Lane 4 (Server) complete — uses `pack_audit_state`, `pack_gc_state`, and the cron skeleton from Lane 4.
- Lane 5 (Sync protocol) complete — populates `remote_pack`, `remote_pack_entry`, `receipt_pack_grant` that audit and GC operate on.

## Deliverables

- `apps/api/src/cron/audit.ts` with four cadence handlers: hourly, daily, weekly, monthly.
- `apps/api/src/cron/gc.ts` with the GC cadence.
- `apps/api/src/v2/reads/authority.ts` extended with `auditStatus` derivation and `repair` field on response (per L14).
- Drift response: pack quarantine + receipt degrade + 503 read fallback.
- Monitoring: Prometheus metrics for audit findings + GC volume.

## Tasks

1. **Audit hourly (0.1% sample).** Pick 0.1% of `remote_pack` rows per tenant. For each: HEAD the S3 object, compare byte length against `pack_audit_state` baseline. Update `last_header_check_at`. If S3 missing → status `missing`. Throttled to `MAX_HOURLY_AUDIT_OPS_PER_TENANT = 100`.
2. **Audit daily (1% sample).** Pick 1% per tenant. Same as hourly plus: fetch first 4 KiB of pack, validate `magic` and `pack_header_digest`. Update `last_header_check_at`.
3. **Audit weekly (full header scan).** Iterate all `remote_pack` rows. HEAD + header digest verification on every pack. Long-running; budget: complete within 72 h. Pause if Postgres advisory lock is held by another instance.
4. **Audit monthly (full byte rehash, sampled).** Pick packs not rehashed in the last 90 days. Download full pack, recompute pack_digest, compare against `remote_pack.pack_header_digest`. Update `last_full_hash_at`. Throttled to a configurable storage egress budget per day.
5. **GC daily.** For each tenant: find packs with no `receipt_pack_grant` reference AND `first_unreferenced_at` older than 30 days. Transition `live` → `tombstone_pending`. Wait 24 h. Transition `tombstone_pending` → `delete_pending`. Delete S3 object + `remote_pack_entry` rows + `remote_pack` row. Transition to `deleted`.
6. **Drift response wiring.** When audit detects a `missing` or `hash_mismatch` pack: mark pack `quarantined`; find all `receipt_pack_grant` rows referencing the pack; mark the corresponding `receipt` entries as `degraded` via a new `receipt_audit_state` table; surface `repair` field on `GET /v2/stores/:storeId/authority` responses.
7. **`receipt_audit_state` table** added in this lane (schema update, applied via Lane 4's migration path).
8. **503 read fallback.** When `artifacts.getText` requests a body whose pack is `quarantined`, return `503 DATA_UNAVAILABLE`. Caller surfaces a clear error.

## Concrete types and schemas

### Cron registrations (extend Lane 4 skeleton)

```ts
// apps/api/src/cron/audit.ts
import cron from 'node-cron'
import { withAdvisoryLock } from './advisory-lock'

const MAX_HOURLY_AUDIT_OPS_PER_TENANT = 100
const DAILY_AUDIT_SAMPLE_RATIO = 0.01
const WEEKLY_AUDIT_FULL_SCAN_TIMEOUT_HOURS = 72
const MONTHLY_REHASH_MIN_AGE_DAYS = 90
const MONTHLY_REHASH_DAILY_EGRESS_GB_BUDGET = 50

export function registerAuditCron(deps: CronDeps): void {
  // Hourly: 0.1% sample HEAD check.
  cron.schedule('0 * * * *', () =>
    withAdvisoryLock('prosa-audit-hourly', () => runAuditHourly(deps)),
  )
  // Daily 02:00: 1% sample with header validation.
  cron.schedule('0 2 * * *', () =>
    withAdvisoryLock('prosa-audit-daily', () => runAuditDaily(deps)),
  )
  // Weekly Sunday 03:00: full header scan.
  cron.schedule('0 3 * * 0', () =>
    withAdvisoryLock('prosa-audit-weekly', () => runAuditWeeklyFullScan(deps)),
  )
  // Monthly 1st 04:00: full byte rehash for cold packs.
  cron.schedule('0 4 1 * *', () =>
    withAdvisoryLock('prosa-audit-monthly', () => runAuditMonthly(deps)),
  )
}

async function runAuditHourly(deps: CronDeps): Promise<void> {
  const tenants = await deps.db.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM remote_pack`)
  for (const { tenant_id } of tenants.rows) {
    const sample = await deps.db.query<PackRow>(`
      SELECT pack_digest, storage_key, byte_length, pack_header_digest
        FROM remote_pack
       WHERE tenant_id = $1
       ORDER BY random()
       LIMIT $2`,
      [tenant_id, MAX_HOURLY_AUDIT_OPS_PER_TENANT],
    )
    for (const pack of sample.rows) {
      try {
        const head = await deps.objectStore.head(pack.storage_key)
        if (!head) {
          await markPackMissing(deps, tenant_id, pack.pack_digest)
          continue
        }
        if (head.byteLength !== pack.byte_length) {
          await markPackHashMismatch(deps, tenant_id, pack.pack_digest, 'byte_length_mismatch')
          continue
        }
        await updateAuditState(deps, tenant_id, pack.pack_digest, { last_header_check_at: 'now()' })
      } catch (err) {
        deps.logger.error({ err, tenant_id, pack_digest: pack.pack_digest }, 'audit hourly error')
      }
    }
  }
}
```

### Drift response

```ts
// apps/api/src/cron/audit/drift.ts
export async function markPackMissing(
  deps: CronDeps,
  tenantId: string,
  packDigest: string,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    // 1. Mark pack quarantined.
    await tx.query(`
      INSERT INTO pack_audit_state (tenant_id, pack_digest, status, error, last_header_check_at)
      VALUES ($1, $2, 'quarantined', $3::jsonb, now())
      ON CONFLICT (tenant_id, pack_digest) DO UPDATE
        SET status = 'quarantined',
            error = EXCLUDED.error,
            last_header_check_at = EXCLUDED.last_header_check_at
    `, [tenantId, packDigest, { reason: 'missing_pack' }])

    // 2. Find affected receipts.
    const receipts = await tx.query<{ receipt_id: string }>(`
      SELECT DISTINCT receipt_id FROM receipt_pack_grant
       WHERE tenant_id = $1 AND pack_digest = $2
    `, [tenantId, packDigest])

    // 3. Degrade receipts.
    for (const { receipt_id } of receipts.rows) {
      await tx.query(`
        INSERT INTO receipt_audit_state (receipt_id, tenant_id, status, affected_pack_count, updated_at)
        VALUES ($1, $2, 'degraded', 1, now())
        ON CONFLICT (receipt_id) DO UPDATE
          SET status = 'degraded',
              affected_pack_count = receipt_audit_state.affected_pack_count + 1,
              updated_at = now()
      `, [receipt_id, tenantId])
    }
  })

  // 4. Alert operator.
  deps.metrics.increment('prosa.audit.pack_missing', { tenantId })
  deps.alerting.notify({
    severity: 'high',
    title: `Pack missing for tenant ${tenantId}`,
    detail: `pack_digest=${packDigest}; affected receipts: ${/*count*/}`,
  })
}
```

### `receipt_audit_state` schema addition

```sql
-- Added in Lane 8 schema migration.
CREATE TABLE IF NOT EXISTS receipt_audit_state (
  receipt_id              TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'invalidated')),
  affected_pack_count     INTEGER NOT NULL DEFAULT 0,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX receipt_audit_state_tenant_status_idx
  ON receipt_audit_state (tenant_id, status);
```

### Authority response with repair (L14)

```ts
// apps/api/src/v2/reads/authority.ts (extended in Lane 8)
async function fetchAuditStatusAndRepair(
  db: Db,
  tenantId: string,
  receiptId: string,
): Promise<{ auditStatus: 'ok' | 'degraded' | 'invalidated'; repair?: RepairRequest }> {
  const row = await db.query<{ status: string; affected_pack_count: number }>(`
    SELECT status, affected_pack_count FROM receipt_audit_state
     WHERE receipt_id = $1
  `, [receiptId])

  if (row.rows.length === 0 || row.rows[0].status === 'ok') {
    return { auditStatus: 'ok' }
  }

  const status = row.rows[0].status as 'degraded' | 'invalidated'
  const repair: RepairRequest = {
    kind: 're_promote_requested',
    reason: 'missing_pack',
    affectedReceiptId: receiptId,
    affectedBundleRoot: /* fetch from receipt */,
    message: `Receipt has ${row.rows[0].affected_pack_count} affected pack(s). Re-promotion recommended.`,
  }

  return { auditStatus: status, repair }
}
```

### GC cron

```ts
// apps/api/src/cron/gc.ts
const GC_UNREFERENCED_AGE_DAYS = 30
const GC_TOMBSTONE_GRACE_HOURS = 24

export function registerGcCron(deps: CronDeps): void {
  // Daily 01:00: GC pass.
  cron.schedule('0 1 * * *', () =>
    withAdvisoryLock('prosa-gc-daily', () => runGcDaily(deps)),
  )
}

async function runGcDaily(deps: CronDeps): Promise<void> {
  // Phase 1: live → tombstone_pending.
  await deps.db.query(`
    INSERT INTO pack_gc_state (tenant_id, pack_digest, status, first_unreferenced_at)
    SELECT p.tenant_id, p.pack_digest, 'tombstone_pending', now()
      FROM remote_pack p
     WHERE NOT EXISTS (
       SELECT 1 FROM receipt_pack_grant g
        WHERE g.tenant_id = p.tenant_id AND g.pack_digest = p.pack_digest
     )
       AND NOT EXISTS (
       SELECT 1 FROM promotion_staging s
        WHERE s.tenant_id = p.tenant_id AND s.status IN ('open','uploading','materializing')
          AND s.head_json::jsonb @> jsonb_build_object('pack_digests', jsonb_build_array(p.pack_digest))
     )
    ON CONFLICT (tenant_id, pack_digest) DO NOTHING
  `)

  // Phase 2: tombstone_pending → delete_pending (after 24h).
  await deps.db.query(`
    UPDATE pack_gc_state SET status = 'delete_pending'
     WHERE status = 'tombstone_pending'
       AND first_unreferenced_at < now() - interval '${GC_TOMBSTONE_GRACE_HOURS} hours'
  `)

  // Phase 3: delete S3 + catalog rows, then mark deleted.
  const toDelete = await deps.db.query<{ tenant_id: string; pack_digest: string; storage_key: string }>(`
    SELECT s.tenant_id, s.pack_digest, p.storage_key
      FROM pack_gc_state s
      JOIN remote_pack p ON p.tenant_id = s.tenant_id AND p.pack_digest = s.pack_digest
     WHERE s.status = 'delete_pending'
     LIMIT 1000
  `)

  for (const row of toDelete.rows) {
    try {
      await deps.objectStore.delete(row.storage_key)
      await deps.db.transaction(async (tx) => {
        await tx.query(`DELETE FROM remote_pack_entry WHERE tenant_id=$1 AND pack_digest=$2`, [row.tenant_id, row.pack_digest])
        await tx.query(`DELETE FROM remote_pack WHERE tenant_id=$1 AND pack_digest=$2`, [row.tenant_id, row.pack_digest])
        await tx.query(`UPDATE pack_gc_state SET status='deleted', deleted_at=now() WHERE tenant_id=$1 AND pack_digest=$2`, [row.tenant_id, row.pack_digest])
      })
      deps.metrics.increment('prosa.gc.pack_deleted', { tenantId: row.tenant_id })
    } catch (err) {
      await deps.db.query(`UPDATE pack_gc_state SET status='live', error=$3::jsonb WHERE tenant_id=$1 AND pack_digest=$2`,
        [row.tenant_id, row.pack_digest, { error: String(err) }])
      deps.logger.error({ err, ...row }, 'GC delete failed; reverting to live')
    }
  }
}
```

## Tests

| File | Asserts |
|---|---|
| `apps/api/test/v2/cron/audit-detects-missing.test.ts` | Inject a missing pack (delete from S3 but leave catalog row); hourly audit detects, quarantines, degrades affected receipts. |
| `apps/api/test/v2/cron/audit-detects-mismatch.test.ts` | Inject a hash mismatch (replace pack bytes); audit detects, quarantines. |
| `apps/api/test/v2/cron/audit-throttle.test.ts` | Hourly cap of 100 ops per tenant enforced. |
| `apps/api/test/v2/cron/audit-advisory-lock.test.ts` | Two API workers both fire the hourly cron; only one acquires the lock and runs the work. |
| `apps/api/test/v2/cron/gc-lifecycle.test.ts` | Pack unreferenced for 30 days → tombstone_pending; after 24h → delete_pending; deletion completes; catalog rows gone. |
| `apps/api/test/v2/cron/gc-blocked-by-grant.test.ts` | Pack with a `receipt_pack_grant` never becomes tombstone_pending. |
| `apps/api/test/v2/cron/gc-blocked-by-staging.test.ts` | Pack referenced by an open `promotion_staging` never becomes tombstone_pending. |
| `apps/api/test/v2/cron/gc-delete-failure.test.ts` | S3 delete fails → pack reverts to `live`; error recorded in `pack_gc_state.error`. |
| `apps/api/test/v2/reads/authority-repair-surface.test.ts` | Degraded receipt surfaces `repair` field on `GET /v2/stores/:storeId/authority`. |
| `apps/api/test/v2/reads/artifacts-quarantined.test.ts` | `getText` for a body in a quarantined pack returns 503 DATA_UNAVAILABLE. |

## Gate

The lane is complete when:

1. All test files above pass.
2. E2E scenario: inject drift (delete one pack from S3), run audit cron, verify within one hour the affected receipt is `degraded` and the next authority refresh surfaces a `repair` field.
3. E2E scenario: unreferenced pack older than 30 days → GC deletes it within the next two daily cron runs (tombstone + delete phases).
4. Metrics emitted for: `prosa.audit.pack_missing`, `prosa.audit.pack_mismatch`, `prosa.gc.pack_deleted`, `prosa.gc.delete_failed`.
5. Advisory lock test: two API workers scheduled the same cron, only one runs the work per tick.

## Risks

| Risk | Mitigation |
|---|---|
| Audit budget exceeded on huge tenants | Hourly cap of 100 ops/tenant; weekly full scan budgeted at 72 h; monthly rehash gated by daily egress GB budget. |
| GC accidentally deletes a pack still in use | Three-way guard: no `receipt_pack_grant`, no open `promotion_staging` referencing it, age ≥ 30 days. Plus 24 h tombstone grace before actual delete. |
| Drift response storm (many packs missing) | Rate-limit alerting; batch notifications per tenant. |
| Cron skipping ticks under contention | Cron skips silently if advisory lock held; the next tick picks up. Acceptable for these cadences. |
| Postgres write load from audit updates | Hourly audit updates ~100 rows/tenant × N tenants. Acceptable up to ~10k tenants without further sharding. |

## Unblocks

Lane 9 (`10-lane-9-migration.md`) — migration tool needs audit and GC to be operational so promoted v2 bundles are safely managed.
