// Prescriptive maintenance recommendations.
//
// `derivedLayerMaintenanceSummary` answers "what is the state of
// this bundle?" — a descriptive snapshot. This module answers the
// next-action question: "what should I do next, given that state?"
// The two layers are deliberately separate so an operator script
// can branch on the snapshot directly, and a higher-level UI can
// surface the same recommendations as actionable prompts.
//
// Pure function — no filesystem touch. Takes a maintenance summary
// in, returns an ordered list of recommendations out.
//
// The priority order is deliberate: a mid-merge crash (inconsistent
// persisted compaction) MUST be resolved before any safe-to-delete
// GC runs (resuming the merge may add new outputs that still
// reference the soon-to-be-deleted sources). Compaction-plan fires
// are lower priority because they can be deferred indefinitely
// without correctness risk.

import type { DerivedLayerMaintenanceSummary } from './maintenance.js'

export type DerivedLayerRecommendation =
  /** A persisted compaction-seq has an inconsistent post-merge
   *  state — runtime worker likely crashed mid-merge. Resume that
   *  specific seq before doing anything else. */
  | {
      kind: 'resume_compaction'
      inconsistent_count: number
    }
  /** Superseded sources are safe to remove (declaring
   *  compaction-seq is consistent). Run GC to reclaim disk. */
  | {
      kind: 'gc_superseded'
      safe_count: number
      safe_bytes: number
    }
  /** The compaction planner would fire — at least one entity has
   *  exceeded the small-file threshold. Run compaction to keep
   *  Parquet read performance bounded. */
  | {
      kind: 'run_compaction'
      entity_count: number
      reasons: string[]
    }

/**
 * Inspect a maintenance summary and return the ordered list of
 * recommended next actions. Returns `[]` when the bundle is idle
 * (every subsystem is in a clean state).
 *
 * Priority order, highest first:
 *
 *   1. `resume_compaction` — inconsistent persisted compactions
 *      must be resolved first; their superseded sources may still
 *      be needed for re-execution.
 *   2. `gc_superseded` — once everything is consistent, safe
 *      candidates can be reclaimed. CQ-111: this slot is suppressed
 *      whenever any persisted compaction is inconsistent, even if
 *      `gc-plan` independently classified some rows as safe. A
 *      resuming merge may still need its superseded sources; we
 *      must not let the operator delete them before the resume
 *      runs.
 *   3. `run_compaction` — defer last; small-file pressure is a
 *      performance concern, not a correctness one.
 */
export function recommendMaintenanceActions(summary: DerivedLayerMaintenanceSummary): DerivedLayerRecommendation[] {
  const recommendations: DerivedLayerRecommendation[] = []

  if (summary.persisted_compactions.inconsistent_count > 0) {
    recommendations.push({
      kind: 'resume_compaction',
      inconsistent_count: summary.persisted_compactions.inconsistent_count,
    })
  }

  // CQ-111: suppress GC entirely while any persisted compaction is
  // inconsistent — the resuming merge may still need its superseded
  // sources, so we must not let the operator reclaim them yet.
  if (summary.gc.safe_to_delete.count > 0 && summary.persisted_compactions.inconsistent_count === 0) {
    recommendations.push({
      kind: 'gc_superseded',
      safe_count: summary.gc.safe_to_delete.count,
      safe_bytes: summary.gc.safe_to_delete.bytes,
    })
  }

  if (!summary.compaction.empty) {
    recommendations.push({
      kind: 'run_compaction',
      entity_count: summary.compaction.entity_count,
      reasons: summary.compaction.reasons,
    })
  }

  return recommendations
}
