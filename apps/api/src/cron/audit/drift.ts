// Lane 8 — drift response wiring.
//
// When the audit cron detects a `missing` or `hash_mismatch` pack it
// hands the finding off to one of the helpers in this module. Each
// helper performs three writes in a single transaction so an operator
// always sees a consistent state:
//
//   1. `pack_audit_state` flipped to `quarantined` with the failure
//      reason captured in `error::jsonb`.
//   2. Every receipt that holds a `receipt_pack_grant` on the
//      affected pack is upserted into `receipt_audit_state` with
//      status `degraded` so the read surfaces (authority refresh and
//      `artifacts.getText`) can fail closed.
//   3. A metrics counter is incremented and the logger emits a single
//      structured warning per finding. Alerting hooks are optional —
//      production wires Prometheus + Loki; tests pass no-ops.

import type { RawExec } from '../../db.js'

export type DriftLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void
  error: (obj: Record<string, unknown>, msg: string) => void
}

export type DriftMetrics = {
  increment: (name: string, tags?: Record<string, string>) => void
}

export type DriftTxRunner = <T>(fn: (tx: RawExec) => Promise<T>) => Promise<T>

export type DriftDeps = {
  rawExec: RawExec
  transaction: DriftTxRunner
  logger: DriftLogger
  metrics: DriftMetrics
}

/** Reason captured on the `pack_audit_state.error` JSONB column. */
export type DriftReason = 'missing_pack' | 'byte_length_mismatch' | 'header_digest_mismatch' | 'byte_hash_mismatch'

type DriftOutcome = {
  affectedReceiptIds: string[]
}

/**
 * Mark a pack as missing from object storage. Used by the hourly /
 * daily / weekly cadences when a HEAD returns null. The receipt
 * grants chain is followed so every receipt that depends on the
 * pack ends up `degraded` in `receipt_audit_state`.
 */
export async function markPackMissing(deps: DriftDeps, tenantId: string, packDigest: string): Promise<DriftOutcome> {
  const reason: DriftReason = 'missing_pack'
  const outcome = await applyDrift(deps, tenantId, packDigest, reason)
  deps.metrics.increment('prosa.audit.pack_missing', { tenantId })
  deps.logger.warn(
    {
      tenantId,
      packDigest,
      reason,
      affectedReceiptCount: outcome.affectedReceiptIds.length,
    },
    'audit detected missing pack; quarantined',
  )
  return outcome
}

/**
 * Mark a pack as hash-mismatched. Used by daily / weekly / monthly
 * cadences when the stored bytes no longer match the catalog row.
 * `reason` distinguishes byte-length, header-digest, and byte-hash
 * mismatches so operators can tell scan classes apart in dashboards.
 */
export async function markPackHashMismatch(
  deps: DriftDeps,
  tenantId: string,
  packDigest: string,
  reason: Exclude<DriftReason, 'missing_pack'>,
): Promise<DriftOutcome> {
  const outcome = await applyDrift(deps, tenantId, packDigest, reason)
  deps.metrics.increment('prosa.audit.pack_mismatch', { tenantId, reason })
  deps.logger.warn(
    {
      tenantId,
      packDigest,
      reason,
      affectedReceiptCount: outcome.affectedReceiptIds.length,
    },
    'audit detected pack hash mismatch; quarantined',
  )
  return outcome
}

async function applyDrift(
  deps: DriftDeps,
  tenantId: string,
  packDigest: string,
  reason: DriftReason,
): Promise<DriftOutcome> {
  return deps.transaction(async (tx) => {
    // 1. Quarantine the pack. The legacy `last_audit_at` column is
    //    refreshed alongside the new `last_header_check_at` so dual
    //    consumers stay coherent.
    await tx(
      `INSERT INTO pack_audit_state (tenant_id, pack_digest, status, details, error, last_audit_at, last_header_check_at)
         VALUES ($1, $2, 'quarantined', $3::jsonb, $3::jsonb, now(), now())
         ON CONFLICT (tenant_id, pack_digest) DO UPDATE
           SET status = 'quarantined',
               details = EXCLUDED.details,
               error = EXCLUDED.error,
               last_audit_at = now(),
               last_header_check_at = now()`,
      [tenantId, packDigest, JSON.stringify({ reason })],
    )

    // 2. Find every receipt that depends on this pack via
    //    `receipt_pack_grant`.
    const affected = await tx<{ receipt_id: string }>(
      `SELECT DISTINCT receipt_id
         FROM receipt_pack_grant
        WHERE tenant_id = $1
          AND pack_digest = $2`,
      [tenantId, packDigest],
    )

    // 3. Upsert each receipt into `receipt_audit_state`. The pack
    //    counter is incremented monotonically so an operator can
    //    tell how many quarantined packs a single receipt depends
    //    on without scanning the grants table.
    for (const row of affected) {
      await tx(
        `INSERT INTO receipt_audit_state (receipt_id, tenant_id, status, affected_pack_count, updated_at)
           VALUES ($1, $2, 'degraded', 1, now())
           ON CONFLICT (receipt_id) DO UPDATE
             SET status = CASE
                            WHEN receipt_audit_state.status = 'invalidated' THEN 'invalidated'
                            ELSE 'degraded'
                          END,
                 affected_pack_count = receipt_audit_state.affected_pack_count + 1,
                 updated_at = now()`,
        [row.receipt_id, tenantId],
      )
    }

    return { affectedReceiptIds: affected.map((r) => r.receipt_id) }
  })
}
