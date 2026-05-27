// Compaction history — per-manifest timeline with generated_at.
//
// `listCompactedOutputs` answers "is each persisted manifest
// landed cleanly?" but drops the manifest's `generated_at`
// timestamp. Operators auditing a bundle want the timeline view:
// when did each compaction run, in what order, and is the
// resulting on-disk state still consistent. This module is that
// view.
//
// Composes `listCompactedOutputs` (consistency audit) with the
// underlying manifest reads (generated_at + entity counts) into a
// single per-compaction-seq row. Sorted by `compaction_seq`
// ascending — which is also chronological in practice because the
// runtime worker increments the seq on each run.
//
// Pure-read: no clock, no mutation. The `generated_at` field is
// echoed verbatim from the manifest the writer persisted, not
// recomputed.

import { type CompactManifestV2, readCompactManifestV2 } from './manifest.js'
import { listCompactedOutputs } from './outputs.js'

export interface CompactionHistoryRow {
  /** Sequence number the manifest declares. */
  compaction_seq: number
  /** Bundle-root-relative path of the persisted manifest. */
  manifest_path: string
  /** ISO-8601 UTC string the manifest carries — the wall-clock
   *  time the runtime worker recorded when the manifest was
   *  built. */
  generated_at: string
  /** True iff every entity output named by the manifest exists as
   *  a regular file. Mirrors `CompactedManifestAudit.consistent`. */
  consistent: boolean
  /** Number of entities the manifest declares. */
  entity_count: number
  /** Number of superseded segments aggregated across every entity. */
  superseded_segment_count: number
}

interface ManifestCounts {
  entity_count: number
  superseded_segment_count: number
}

function countManifestEntities(manifest: CompactManifestV2): ManifestCounts {
  let supersededCount = 0
  for (const entity of manifest.entities) {
    supersededCount += entity.superseded.length
  }
  return { entity_count: manifest.entities.length, superseded_segment_count: supersededCount }
}

/**
 * Walk every persisted manifest under `<bundleRoot>/epochs/compact-<NNNN>/`
 * and emit one history row per manifest. Sorted by `compaction_seq`
 * ascending. Empty bundles (no `epochs/`, no persisted manifests)
 * return `[]`.
 */
export async function listCompactionHistory(bundleRoot: string): Promise<CompactionHistoryRow[]> {
  const audits = await listCompactedOutputs(bundleRoot)
  const rows: CompactionHistoryRow[] = []
  for (const audit of audits) {
    const manifest = await readCompactManifestV2(bundleRoot, audit.compaction_seq)
    const counts = countManifestEntities(manifest)
    rows.push({
      compaction_seq: audit.compaction_seq,
      manifest_path: audit.manifest_path,
      generated_at: manifest.generated_at,
      consistent: audit.consistent,
      entity_count: counts.entity_count,
      superseded_segment_count: counts.superseded_segment_count,
    })
  }
  return rows
}
