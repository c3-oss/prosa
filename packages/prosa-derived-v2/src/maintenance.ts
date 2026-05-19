// One-call derived-layer maintenance summary.
//
// Composes every pure-read audit surface in the package into one
// dashboard-shaped result. Use cases:
//
//   - `prosa index-v2 maintenance` CLI: a single command emits the
//     full health snapshot a user wants before deciding whether to
//     run compile, compaction, GC, or just inspect the bundle.
//   - MCP `read_bundle_maintenance` tool (lands in Lane 7).
//   - Web overview panels that need totals + per-subsystem state in
//     one round-trip.
//
// Pure-read. No filesystem mutation. Composed surfaces' containment
// guards propagate. Returns `null` per-subsystem rollup when that
// subsystem has no on-disk artifacts yet so callers can distinguish
// "fresh bundle" from "subsystem in trouble".

import { bundleDerivedStatus } from './bundle-status.js'
import { planSupersededCleanup } from './compaction/gc-plan.js'
import { listCompactedOutputs } from './compaction/outputs.js'
import { detectCompactionOverlaps } from './compaction/overlaps.js'
import { planCompaction } from './compaction/planner.js'
import { summariseProjectionSegments } from './compaction/segments.js'

export interface DerivedLayerMaintenanceSummary {
  /** Top-level Tantivy + SessionBlob status from
   *  `bundleDerivedStatus(bundleRoot)`. */
  status: Awaited<ReturnType<typeof bundleDerivedStatus>>
  /** Per-entity / per-epoch byte+count rollup over every Parquet
   *  projection segment on disk. */
  projection: Awaited<ReturnType<typeof summariseProjectionSegments>>
  /** What `planCompaction` decides for the current bundle. */
  compaction: {
    /** True iff the planner would NOT fire (no entity meets the
     *  trigger). */
    empty: boolean
    /** Number of entities the planner would fire for (each
     *  produces one compacted output). */
    entity_count: number
    /** Reasons the planner fired, deduplicated. Empty when
     *  `empty === true`. */
    reasons: string[]
  }
  /** Persisted-compaction state aggregated from
   *  `epochs/compact-<NNNN>/compact.manifest.json`. */
  persisted_compactions: {
    /** How many compaction-seqs have a persisted manifest. */
    count: number
    /** How many are in a consistent post-merge state (manifest
     *  declares N outputs, all N exist as real files). */
    consistent_count: number
    /** Convenience: `count - consistent_count`. A non-zero value
     *  means a runtime worker crashed mid-merge. */
    inconsistent_count: number
  }
  /** GC partition from `planSupersededCleanup`. */
  gc: {
    /** Total superseded segments aggregated across persisted
     *  manifests. */
    candidate_count: number
    /** Segments safe to remove (declaring compaction-seq is
     *  consistent). */
    safe_to_delete: { count: number; bytes: number }
    /** Segments blocked (declaring compaction-seq is inconsistent
     *  — runtime worker may need to re-execute). */
    blocked: { count: number; bytes: number }
  }
  /** Cross-seq overlap audit from `detectCompactionOverlaps`. A
   *  non-zero `count` is a real correctness violation — the same
   *  source segment is claimed by more than one persisted
   *  manifest's `superseded[]`. The bundle is unsafe to GC until
   *  the operator resolves the duplicate claim. */
  overlaps: {
    /** Number of distinct bundle-relative paths claimed by more
     *  than one compaction. `0` in the healthy case. */
    count: number
    /** The overlapping paths themselves, sorted ascending. Empty
     *  when `count === 0`. */
    paths: string[]
  }
}

/**
 * Build the one-call derived-layer maintenance summary. Composes
 * `bundleDerivedStatus` + `summariseProjectionSegments` +
 * `planCompaction` + `listCompactedOutputs` + `planSupersededCleanup`
 * concurrently (each composed surface enforces its own containment;
 * failures propagate unchanged).
 *
 * Empty bundles return zero rollups for every subsystem.
 */
export async function derivedLayerMaintenanceSummary(bundleRoot: string): Promise<DerivedLayerMaintenanceSummary> {
  const [status, projection, compactionPlan, compactedOutputs, gcPlan, overlapRows] = await Promise.all([
    bundleDerivedStatus(bundleRoot),
    summariseProjectionSegments(bundleRoot),
    planCompaction(bundleRoot),
    listCompactedOutputs(bundleRoot),
    planSupersededCleanup(bundleRoot),
    detectCompactionOverlaps(bundleRoot),
  ])

  const reasonsSet = new Set<string>()
  for (const entity of compactionPlan.entities) reasonsSet.add(entity.reason)

  let consistentCount = 0
  for (const row of compactedOutputs) {
    if (row.consistent) consistentCount += 1
  }

  return {
    status,
    projection,
    compaction: {
      empty: compactionPlan.empty,
      entity_count: compactionPlan.entities.length,
      reasons: [...reasonsSet].sort(),
    },
    persisted_compactions: {
      count: compactedOutputs.length,
      consistent_count: consistentCount,
      inconsistent_count: compactedOutputs.length - consistentCount,
    },
    gc: {
      candidate_count: gcPlan.candidates.length,
      safe_to_delete: gcPlan.safe_to_delete,
      blocked: gcPlan.blocked,
    },
    overlaps: {
      count: overlapRows.length,
      paths: overlapRows.map((r) => r.path),
    },
  }
}
