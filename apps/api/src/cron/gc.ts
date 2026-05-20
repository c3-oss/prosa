// Lane 8 — GC cron handler.
//
// Three-phase lifecycle per `pack_gc_state.status`:
//
//   1. `live` -> `tombstone_pending`. A pack becomes eligible once it
//      has no `receipt_pack_grant` rows AND no open
//      `promotion_staging` row references it via the `pack_digests`
//      array embedded in `head_json`. The transition stamps
//      `first_unreferenced_at = now()`.
//   2. `tombstone_pending` -> `delete_pending`. Performed
//      GC_TOMBSTONE_GRACE_HOURS after the tombstone stamp so a stale
//      consumer in the middle of a read has a chance to recover.
//   3. `delete_pending` -> `deleted`. The S3 object is removed, then
//      `remote_pack_entry` + `remote_pack` rows are dropped in the
//      same transaction so a half-deleted catalog never surfaces.
//
// If the S3 delete fails the row is rolled back to `live` and an
// `error` JSONB is recorded so the next tick can retry.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { RawExec } from '../db.js'
import type { DriftLogger, DriftMetrics, DriftTxRunner } from './audit/drift.js'

/** Minimum age (days) before a tombstone is even considered. */
export const GC_UNREFERENCED_AGE_DAYS = 30
/** Tombstone -> delete grace window in hours. */
export const GC_TOMBSTONE_GRACE_HOURS = 24
/** Max packs deleted in a single tick to bound egress. */
export const GC_MAX_DELETES_PER_TICK = 1000

export type GcCronDeps = {
  rawExec: RawExec
  transaction: DriftTxRunner
  objectStore: Pick<RemoteObjectStore, 'delete'>
  logger: DriftLogger
  metrics: DriftMetrics
}

export type GcHandlers = {
  'gc-daily': () => Promise<void>
}

/** Return the GC handler map ready to pass to `startCron({ handlers })`. */
export function registerGcCron(deps: GcCronDeps): GcHandlers {
  return {
    'gc-daily': () => runGcDaily(deps),
  }
}

type DeleteCandidate = {
  tenant_id: string
  pack_digest: string
  storage_uri: string
}

/**
 * Daily GC pass. Single advisory lock owns all three phase
 * transitions. The unreferenced-age threshold for the
 * `tombstone_pending` insert is the spec's
 * GC_UNREFERENCED_AGE_DAYS; the spec uses `now()` for the initial
 * sweep but production should also bake an inflight grace period
 * into the inserter, so we filter on
 * `remote_pack.ingested_at + interval '30 days' < now()`.
 */
export async function runGcDaily(deps: GcCronDeps): Promise<void> {
  // Phase 1: live -> tombstone_pending.
  await deps.rawExec(
    `INSERT INTO pack_gc_state (tenant_id, pack_digest, unreferenced_since, first_unreferenced_at, status)
     SELECT p.tenant_id, p.pack_digest, now(), now(), 'tombstone_pending'
       FROM remote_pack p
      WHERE p.ingested_at < now() - ($1 || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM receipt_pack_grant g
           WHERE g.tenant_id = p.tenant_id AND g.pack_digest = p.pack_digest
        )
        AND NOT EXISTS (
          SELECT 1 FROM promotion_staging s
           WHERE s.tenant_id = p.tenant_id
             AND s.status IN ('open','uploading','materializing')
             AND s.head_json @> jsonb_build_object('pack_digests', jsonb_build_array(p.pack_digest))
        )
        AND NOT EXISTS (
          SELECT 1 FROM pack_gc_state existing
           WHERE existing.tenant_id = p.tenant_id
             AND existing.pack_digest = p.pack_digest
        )`,
    [String(GC_UNREFERENCED_AGE_DAYS)],
  )

  // Phase 2: tombstone_pending -> delete_pending after the grace
  // window. The conditional update keeps unrelated rows untouched.
  await deps.rawExec(
    `UPDATE pack_gc_state
        SET status = 'delete_pending'
      WHERE status = 'tombstone_pending'
        AND first_unreferenced_at < now() - ($1 || ' hours')::interval`,
    [String(GC_TOMBSTONE_GRACE_HOURS)],
  )

  // Phase 3: actually delete. The `LIMIT` keeps a single tick bounded.
  const toDelete = await deps.rawExec<DeleteCandidate>(
    `SELECT s.tenant_id, s.pack_digest, p.storage_uri
       FROM pack_gc_state s
       JOIN remote_pack p
         ON p.tenant_id = s.tenant_id
        AND p.pack_digest = s.pack_digest
      WHERE s.status = 'delete_pending'
      ORDER BY s.first_unreferenced_at NULLS FIRST
      LIMIT $1`,
    [GC_MAX_DELETES_PER_TICK],
  )

  for (const row of toDelete) {
    try {
      await deps.objectStore.delete(row.storage_uri)
      await deps.transaction(async (tx) => {
        await tx(`DELETE FROM remote_pack_entry WHERE tenant_id = $1 AND pack_digest = $2`, [
          row.tenant_id,
          row.pack_digest,
        ])
        await tx(`DELETE FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [row.tenant_id, row.pack_digest])
        await tx(
          `UPDATE pack_gc_state
              SET status = 'deleted', deleted_at = now()
            WHERE tenant_id = $1 AND pack_digest = $2`,
          [row.tenant_id, row.pack_digest],
        )
      })
      deps.metrics.increment('prosa.gc.pack_deleted', { tenantId: row.tenant_id })
    } catch (err) {
      const errorPayload = JSON.stringify({ error: String(err) })
      await deps.rawExec(
        `UPDATE pack_gc_state
            SET status = 'live', error = $3::jsonb
          WHERE tenant_id = $1 AND pack_digest = $2`,
        [row.tenant_id, row.pack_digest, errorPayload],
      )
      deps.metrics.increment('prosa.gc.delete_failed', { tenantId: row.tenant_id })
      deps.logger.error(
        { err: String(err), tenantId: row.tenant_id, packDigest: row.pack_digest, storageUri: row.storage_uri },
        'GC delete failed; reverting to live',
      )
    }
  }
}
